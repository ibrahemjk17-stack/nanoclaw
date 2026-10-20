/**
 * Jarvis host module (self-registering; see docs/UPSTREAM_PATCHES.md #5).
 *
 * Intercepts the OWNER's slash commands at the very top of routing, so they are answered by the host and never reach an agent:
 *   /stop    halt every running agent now and pause the host (no container starts until /resume)
 *   /resume  lift the pause
 * Messages from anyone else are not touched here (normal routing and its access policy apply).
 */
import { killAllContainers } from '../../container-runner.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import { registerMessageInterceptor } from '../../router.js';
import type { InboundEvent } from '../../channels/adapter.js';

import { handleTail, PAUSED_NOTICE, parseCommand, runCommand } from './commands.js';
import { isHostPaused, setHostPaused } from './pause.js';

const NOTICE_EVERY_MS = 10 * 60_000;
const lastNotice = new Map<string, number>();

function ownerId(): string | undefined {
  return (
    (process.env.TELEGRAM_OWNER_ID || readEnvFile(['TELEGRAM_OWNER_ID']).TELEGRAM_OWNER_ID || '').trim() || undefined
  );
}

function parse(event: InboundEvent): { text: string; sender: string | undefined } {
  try {
    const c = JSON.parse(event.message.content) as Record<string, unknown>;
    const author =
      typeof c.author === 'object' && c.author !== null ? (c.author as Record<string, unknown>) : undefined;
    const sender = [c.senderId, c.sender, author?.userId].find((v): v is string => typeof v === 'string');
    return { text: typeof c.text === 'string' ? c.text : '', sender };
  } catch {
    return { text: '', sender: undefined };
  }
}

async function reply(event: InboundEvent, text: string): Promise<void> {
  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.warn('Jarvis command: no delivery adapter, reply not sent');
    return;
  }
  await adapter.deliver(
    event.channelType,
    event.platformId,
    null,
    'chat-sdk',
    JSON.stringify({ text }),
    undefined,
    event.instance,
  );
}

registerMessageInterceptor(async (event: InboundEvent): Promise<boolean> => {
  const owner = ownerId();
  if (!owner) return false; // not configured: never act
  const { text, sender } = parse(event);
  if (handleTail(sender) !== owner) return false; // anyone else: normal routing and its policy

  const command = parseCommand(text);
  if (command) {
    const started = Date.now();
    const answer = runCommand(command, {
      isPaused: isHostPaused,
      setPaused: setHostPaused,
      killAll: killAllContainers,
    });
    log.info('Jarvis command', { command, ms: Date.now() - started });
    await reply(event, answer).catch((err) => log.error('Jarvis command reply failed', { command, err }));
    return true;
  }

  if (isHostPaused()) {
    const key = `${event.channelType}:${event.platformId}`;
    if (Date.now() - (lastNotice.get(key) ?? 0) > NOTICE_EVERY_MS) {
      lastNotice.set(key, Date.now());
      await reply(event, PAUSED_NOTICE).catch(() => undefined);
    }
  }
  return false; // let routing continue: the message is queued, not lost
});
