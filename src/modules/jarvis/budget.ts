/**
 * Jarvis: the budget gate. Before any agent container starts, the data server is asked whether this agent group may run today (its
 * daily limit, the global limit, and an allowed model: Haiku or Sonnet only). While a container runs it is asked again every
 * SWEEP_MS, and a container that has gone over is stopped. The rules live in the data server (packages/mcp-jarvis-data/src/budget.ts);
 * this file only asks, obeys, and tells the owner.
 *
 * FAIL CLOSED: if the data server cannot answer, or answers something unexpected, the answer is no.
 */
import type { Session } from '../../types.js';

import type { WakeGate } from './wake-gate.js';

export interface BudgetGateDeps {
  /** POST to the data server's /host/<path>; throws when unreachable. */
  data: (path: string, body?: unknown) => Promise<any>;
  /** The agent group name (the key of its budget) and effective model for a session; null when unknown. */
  resolve: (session: Session) => Promise<{ group: string; model: string | undefined } | null>;
  /** Sends a line to the owner (Telegram General). May throw; the gate never depends on it succeeding. */
  notify: (text: string) => Promise<void>;
  now: () => number;
  warn: (msg: string, extra?: unknown) => void;
  /** How long a refusal is remembered, so a retrying sweep does not ask the server every few seconds. */
  denyCacheMs?: number;
}

export interface Decision {
  allowed: boolean;
  reason: string;
}

const UNREACHABLE_NOTICE_EVERY_MS = 30 * 60_000;
export const UNREACHABLE = 'budget service unreachable';
/** A running agent is stopped for an unreachable budget service only after this many sweeps in a row; a new start is refused at once. */
export const SWEEPS_BEFORE_UNREACHABLE_KILL = 3;

export function createBudgetCheck(deps: BudgetGateDeps) {
  const cacheMs = deps.denyCacheMs ?? 30_000;
  const denied = new Map<string, { until: number; reason: string }>();
  let lastUnreachableNotice = Number.NEGATIVE_INFINITY;

  const tell = async (text: string) => {
    try {
      await deps.notify(text);
    } catch (err) {
      deps.warn('Budget: could not send the notice to the owner', err instanceof Error ? err.message : err);
    }
  };

  /** May this agent group run now? */
  return async function check(group: string, model: string | undefined): Promise<Decision> {
    const key = `${group}|${model ?? ''}`;
    const cached = denied.get(key);
    if (cached && cached.until > deps.now()) return { allowed: false, reason: cached.reason };

    let v: { allowed?: unknown; reason?: unknown; notice?: unknown };
    try {
      v = await deps.data('/host/budget/check', { group, model: model ?? null });
    } catch (err) {
      deps.warn('Budget check unavailable; refusing (fail closed)', err instanceof Error ? err.message : err);
      if (deps.now() - lastUnreachableNotice > UNREACHABLE_NOTICE_EVERY_MS) {
        lastUnreachableNotice = deps.now();
        await tell(
          '⛔ The budget check is not available, so no agent will start until it is. Run scripts/doctor.sh on the host.',
        );
      }
      return { allowed: false, reason: UNREACHABLE };
    }
    if (typeof v?.allowed !== 'boolean') {
      deps.warn('Budget check answered something unexpected; refusing (fail closed)');
      return { allowed: false, reason: 'unexpected budget answer' };
    }
    if (typeof v.notice === 'string' && v.notice) await tell(v.notice);
    const reason = typeof v.reason === 'string' ? v.reason : '';
    if (!v.allowed) denied.set(key, { until: deps.now() + cacheMs, reason });
    return { allowed: v.allowed, reason };
  };
}

/** The gate registered in front of wakeContainer. */
export function createBudgetGate(deps: BudgetGateDeps): WakeGate {
  const check = createBudgetCheck(deps);
  return async (session) => {
    const who = await deps.resolve(session);
    if (!who) return { allowed: false, reason: 'unknown agent group' };
    return check(who.group, who.model);
  };
}

export interface SweeperDeps extends BudgetGateDeps {
  /** Ids of the sessions whose containers are running now. */
  listActive: () => string[];
  /** Loads a session by id. */
  getSession: (id: string) => Promise<Session | undefined>;
  /** Stops a running container. */
  kill: (sessionId: string, reason: string) => void;
}

/** One pass over the running containers: any whose group is no longer allowed is stopped. Returns how many were stopped. Never throws. */
export function createBudgetSweep(deps: SweeperDeps) {
  const check = createBudgetCheck(deps);
  let unreachableStreak = 0;
  return async function sweep(): Promise<number> {
    let stopped = 0;
    let sawUnreachable = false;
    for (const id of deps.listActive()) {
      try {
        const session = await deps.getSession(id);
        const who = session ? await deps.resolve(session) : null;
        const decision = who ? await check(who.group, who.model) : { allowed: false, reason: 'unknown agent group' };
        if (decision.allowed) continue;
        if (decision.reason === UNREACHABLE) {
          sawUnreachable = true;
          // an outage of the budget service is not the agent's fault: give it a short grace before stopping what is already running
          if (unreachableStreak + 1 < SWEEPS_BEFORE_UNREACHABLE_KILL) continue;
        }
        deps.kill(id, `budget: ${decision.reason}`);
        stopped++;
      } catch (err) {
        deps.warn('Budget sweep: could not check a running agent', err instanceof Error ? err.message : err);
      }
    }
    unreachableStreak = sawUnreachable ? unreachableStreak + 1 : 0;
    return stopped;
  };
}

export const SWEEP_MS = 30_000;
