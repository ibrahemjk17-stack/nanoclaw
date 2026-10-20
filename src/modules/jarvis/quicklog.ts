/**
 * Jarvis: the quick-log buttons. `/log` posts a card (one button per habit); a tap logs one step of that habit through the data
 * server and updates the card. No model is involved at any point.
 *
 * Button ids are `ncq:jv-log-<signature>:<index>`: NanoClaw's own card format (so it renders and routes like its other cards),
 * with a signature of the habit list the card was built from, so a button on an old card cannot log against a changed list.
 */
import { Actions, Button, Card, CardText, type ActionEvent, type Adapter } from 'chat';

import { handleTail } from './commands.js';

export interface QuickLogDeps {
  /** POST to /host/<path> with a JSON body; throws when unreachable. */
  data: (path: string, body?: unknown) => Promise<any>;
  ownerId: () => string | undefined;
  now: () => Date;
  warn: (msg: string, extra?: unknown) => void;
  /** Leaves a visible line for every tap that reaches us, so a tap can never disappear without a trace. */
  trace?: (msg: string, extra?: unknown) => void;
}

export interface Habits {
  signature: string;
  labels: string[];
}

export const ACTION_ID = /^ncq:jv-log-([0-9a-f]{6}):(\d+)$/;
export const TITLE = 'Quick log';

/** The content for NanoClaw's delivery adapter: an ask_question card with one option per habit. */
export function quickLogContent(h: Habits): string {
  return JSON.stringify({
    type: 'ask_question',
    questionId: `jv-log-${h.signature}`,
    title: TITLE,
    question: 'Tap to log. No assistant involved.',
    options: h.labels.map((label) => ({ label, value: label })),
  });
}

/** The same card as a chat-sdk card, for updating it in place after a tap. */
export function quickLogCard(h: Habits, status: string) {
  return Card({
    title: TITLE,
    children: [
      CardText(status),
      Actions(h.labels.map((label, i) => Button({ id: `ncq:jv-log-${h.signature}:${i}`, label, value: String(i) }))),
    ],
  });
}

const hhmm = (d: Date, tz?: string) =>
  d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, ...(tz ? { timeZone: tz } : {}) });

/** The handler for a button tap. Returns false when the event is not ours, true when it is (even if ignored). */
export async function handleQuickLogAction(event: ActionEvent, adapter: Adapter, deps: QuickLogDeps): Promise<boolean> {
  const m = ACTION_ID.exec(event.actionId);
  if (!m) return false;
  const owner = deps.ownerId();
  deps.trace?.('Jarvis quick-log tap', { index: Number(m[2]), user: event.user?.userId ?? null });
  if (!owner || handleTail(event.user?.userId) !== owner) {
    deps.trace?.('Jarvis quick-log tap ignored: not the owner', {
      user: event.user?.userId ?? null,
      ownerConfigured: Boolean(owner),
    });
    return true; // ours, but not the owner: nothing happens, no reply
  }

  let status: string;
  let fresh: Habits | null = null;
  try {
    const r = (await deps.data('/host/habit-log', { signature: m[1], index: Number(m[2]) })) as {
      ok: boolean;
      text: string;
    };
    status = r.text;
    fresh = (await deps.data('/host/habits')) as Habits; // also heals a card whose habit list has changed
  } catch {
    status = 'The data service is not reachable right now.';
  }
  if (!fresh) return true;
  try {
    const stamp = hhmm(deps.now());
    await adapter.editMessage(event.threadId, event.messageId, {
      card: quickLogCard(fresh, `${status}  ·  ${stamp}`),
      fallbackText: status,
    });
  } catch (err) {
    deps.warn('Quick-log: could not update the card (the tap was still logged)', err);
  }
  return true;
}
