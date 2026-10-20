/**
 * Jarvis: usage reports from agent containers (core patch #7).
 *
 * At the end of every turn the agent runner writes a `usage` system message: the Claude SDK's running totals for the session. This module
 * (the host's delivery action for `usage`) forwards it to the data server, which records the turn's share against the agent group's
 * daily budget and answers whether the group may keep running. If it may not, the container is stopped right now, without waiting for
 * the next sweep.
 *
 * No report is ever lost silently: if the data server cannot be reached the report is written to a spool file and retried, and while
 * anything is spooled NO new agent starts (the spool gate): spend we have not recorded is spend we cannot budget.
 * A report the data server rejects as malformed (HTTP 4xx) is dropped with a warning: retrying it would never succeed.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import type { Session } from '../../types.js';

import type { WakeVerdict } from './wake-gate.js';

export interface SpoolItem {
  session_id: string;
  agent_group_id: string;
  usage: unknown;
}

/** One JSON line per pending report, in a file in the data directory (JARVIS_USAGE_SPOOL overrides, as the test setup does). */
export const spoolPath = (): string => process.env.JARVIS_USAGE_SPOOL || path.join(DATA_DIR, 'usage-spool.jsonl');

export function readSpool(): SpoolItem[] {
  let text: string;
  try {
    text = fs.readFileSync(spoolPath(), 'utf8');
  } catch {
    return [];
  }
  const items: SpoolItem[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      items.push(JSON.parse(line) as SpoolItem);
    } catch {
      // a torn last line after a crash: skip it, never block on it
    }
  }
  return items;
}

export function appendToSpool(item: SpoolItem): void {
  fs.mkdirSync(path.dirname(spoolPath()), { recursive: true });
  fs.appendFileSync(spoolPath(), `${JSON.stringify(item)}\n`);
}

function writeSpool(items: SpoolItem[]): void {
  if (items.length === 0) {
    fs.rmSync(spoolPath(), { force: true });
    return;
  }
  const tmp = `${spoolPath()}.tmp`;
  fs.writeFileSync(tmp, items.map((i) => JSON.stringify(i)).join('\n') + '\n');
  fs.renameSync(tmp, spoolPath());
}

export const spoolPending = (): boolean => readSpool().length > 0;

/** The wake gate: no new agent while reports are waiting to be recorded. */
export const spoolGate = async (): Promise<WakeVerdict> =>
  spoolPending()
    ? { allowed: false, reason: 'usage reports are pending (the data server was unreachable)' }
    : { allowed: true };

export interface UsageDeps {
  /** POST to the data server's /host/<path>; throws when unreachable or on an HTTP error (message contains "answered <status>"). */
  data: (path: string, body?: unknown) => Promise<any>;
  /** The agent group name for a group id; null when unknown. */
  groupName: (agentGroupId: string) => Promise<string | null>;
  notify: (text: string) => Promise<void>;
  kill: (sessionId: string, reason: string) => void;
  warn: (msg: string, extra?: unknown) => void;
}

const isRejection = (err: unknown): boolean => err instanceof Error && /answered 4\d\d/.test(err.message);

type Outcome = 'recorded' | 'dropped' | 'unreachable';

/** Sends one report. Applies the data server's answer (stop the container if over). Never throws. */
async function deliver(deps: UsageDeps, item: SpoolItem): Promise<Outcome> {
  let group: string | null;
  try {
    group = await deps.groupName(item.agent_group_id);
  } catch (err) {
    deps.warn('Usage: could not look up the agent group', err instanceof Error ? err.message : err);
    return 'unreachable';
  }
  if (!group) {
    deps.warn('Usage report dropped: unknown agent group', { agentGroupId: item.agent_group_id });
    return 'dropped';
  }
  let answer: { allowed?: unknown; reason?: unknown; notice?: unknown };
  try {
    answer = await deps.data('/host/usage', { session_id: item.session_id, group, usage: item.usage });
  } catch (err) {
    if (isRejection(err)) {
      deps.warn('Usage report rejected by the data server; dropped', err instanceof Error ? err.message : err);
      return 'dropped';
    }
    return 'unreachable';
  }
  if (typeof answer?.notice === 'string' && answer.notice) await deps.notify(answer.notice).catch(() => undefined);
  if (answer?.allowed === false)
    deps.kill(item.session_id, `budget: ${typeof answer.reason === 'string' ? answer.reason : 'over the limit'}`);
  return 'recorded';
}

/** The delivery-action handler for a `usage` message from a container. Never throws (a throw would lose the report). */
export function createUsageHandler(deps: UsageDeps) {
  return async (content: Record<string, unknown>, session: Session): Promise<void> => {
    if (typeof content.usage !== 'object' || content.usage === null) {
      deps.warn('Usage message without a usage object; ignored', { sessionId: session.id });
      return;
    }
    const item: SpoolItem = { session_id: session.id, agent_group_id: session.agent_group_id, usage: content.usage };
    // Reports already waiting go first, so the data server sees a session's totals in order.
    if (spoolPending()) {
      appendToSpool(item);
      await flushSpool(deps);
      return;
    }
    if ((await deliver(deps, item)) === 'unreachable') {
      appendToSpool(item);
      deps.warn('Usage report spooled: the data server is unreachable; no agent will start until it is recorded');
    }
  };
}

/** Retries the spooled reports in order; stops at the first one that still cannot be sent. Returns how many were cleared. */
export async function flushSpool(deps: UsageDeps): Promise<number> {
  const items = readSpool();
  let cleared = 0;
  for (const item of items) {
    if ((await deliver(deps, item)) === 'unreachable') break;
    cleared++;
  }
  if (cleared > 0) writeSpool(readSpool().slice(cleared));
  return cleared;
}

export const SPOOL_FLUSH_MS = 10_000;
