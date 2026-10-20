/**
 * Jarvis host module (self-registering; see docs/UPSTREAM_PATCHES.md #5).
 *
 * Intercepts the OWNER's slash commands at the very top of routing, so they are answered by the host and never reach an agent:
 *   /stop    halt every running agent now and pause the host (no container starts until /resume)
 *   /resume  lift the pause
 *   /today /status /budget   answered from the data server
 *   /log     post the quick-log buttons; a tap logs a habit step (no model call)
 * Messages from anyone else are not touched here (normal routing and its access policy apply).
 */
import { registerQuestionActionHandler } from '../../channels/question-render-registry.js';
import { getActiveContainerCount, killAllContainers } from '../../container-runner.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import { registerMessageInterceptor } from '../../router.js';
import type { InboundEvent } from '../../channels/adapter.js';

import { handleApprovalAction, syncApprovals, type ApprovalDeps } from './approvals.js';
import { handleTail, PAUSED_NOTICE, parseCommand, runCommand, type CommandDeps } from './commands.js';
import { isHostPaused, setHostPaused } from './pause.js';
import { handleQuickLogAction, quickLogContent, type Habits } from './quicklog.js';

const NOTICE_EVERY_MS = 10 * 60_000;
const lastNotice = new Map<string, number>();

function setting(key: string): string | undefined {
  return (process.env[key] || readEnvFile([key])[key] || '').trim() || undefined;
}
const ownerId = (): string | undefined => setting('TELEGRAM_OWNER_ID');

/** POST to the data server's host routes. Throws when it is not configured, unreachable, or answers with an error. */
async function data(path: string, body?: unknown): Promise<any> {
  const base = setting('JARVIS_DATA_URL');
  const token = setting('JARVIS_HOST_TOKEN');
  if (!base || !token) throw new Error('data server not configured');
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`data server answered ${res.status}`);
  return res.json();
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

async function send(event: InboundEvent, kind: string, content: string): Promise<void> {
  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.warn('Jarvis command: no delivery adapter, reply not sent');
    return;
  }
  await adapter.deliver(event.channelType, event.platformId, null, kind, content, undefined, event.instance);
}
const reply = (event: InboundEvent, text: string) => send(event, 'chat-sdk', JSON.stringify({ text }));

const deps: CommandDeps = {
  isPaused: isHostPaused,
  setPaused: setHostPaused,
  killAll: killAllContainers,
  runningCount: getActiveContainerCount,
  uptimeSeconds: () => process.uptime(),
  data: (path) => data(path),
};

registerMessageInterceptor(async (event: InboundEvent): Promise<boolean> => {
  const owner = ownerId();
  if (!owner) return false; // not configured: never act
  const { text, sender } = parse(event);
  if (handleTail(sender) !== owner) return false; // anyone else: normal routing and its policy

  const command = parseCommand(text);
  if (command) {
    const started = Date.now();
    try {
      if (command === 'log') {
        const habits = (await data('/host/habits')) as Habits;
        await send(event, 'chat-sdk', quickLogContent(habits));
      } else {
        const answer = await runCommand(command, deps);
        if (answer) await reply(event, answer);
      }
    } catch (err) {
      log.error('Jarvis command failed', { command, err });
      await reply(event, 'That did not work (the data service may be down).').catch(() => undefined);
    }
    log.info('Jarvis command', { command, ms: Date.now() - started });
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

registerQuestionActionHandler((event, adapter) =>
  handleQuickLogAction(event, adapter, {
    data,
    ownerId,
    now: () => new Date(),
    warn: (msg, extra) => log.warn(msg, { extra }),
    trace: (msg, extra) => log.info(msg, { extra }),
  }),
);

// ── Approvals topic ──
// Cards are posted into the Approvals topic (JARVIS_APPROVALS_PLATFORM_ID, set by scripts/telegram-wire.sh) and the owner's taps are handled here.
let lastApprovalWarn = 0;
const approvalDeps: ApprovalDeps = {
  data,
  ownerId,
  now: () => new Date(),
  trace: (msg, extra) => log.info(msg, { extra }),
  warn: (msg, extra) => {
    // quiet while the data service restarts: at most one line per 10 minutes
    if (Date.now() - lastApprovalWarn > 10 * 60_000) {
      lastApprovalWarn = Date.now();
      log.warn(msg, { extra });
    }
  },
  post: async (kind, content) => {
    const target = setting('JARVIS_APPROVALS_PLATFORM_ID');
    const adapter = getDeliveryAdapter();
    if (!target || !adapter) throw new Error('approvals topic or delivery adapter not available');
    return adapter.deliver('telegram', target, null, kind, content);
  },
};
registerQuestionActionHandler((event, adapter) => handleApprovalAction(event, adapter, approvalDeps));
setInterval(() => {
  if (setting('JARVIS_APPROVALS_PLATFORM_ID') && ownerId()) void syncApprovals(approvalDeps);
}, 5000).unref();
