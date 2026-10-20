/**
 * Jarvis: gates that must all say yes before an agent container may start (the pre-run budget check is one).
 *
 * `wakeContainer` is the single place containers start, so a gate here covers messages, scheduled tasks and retries alike.
 * A gate that throws counts as a NO: when a check cannot be made, nothing starts (fail closed).
 * Kept free of imports from the runtime so container-runner can use it without a cycle.
 */
import { log } from '../../log.js';
import type { Session } from '../../types.js';

export interface WakeVerdict {
  allowed: boolean;
  reason?: string;
}
export type WakeGate = (session: Session) => Promise<WakeVerdict>;

const gates: { name: string; gate: WakeGate }[] = [];

export function registerWakeGate(name: string, gate: WakeGate): void {
  gates.push({ name, gate });
}

/** True only if every registered gate allows the start. The first refusal (or failure) stops the check. */
export async function runWakeGates(session: Session): Promise<boolean> {
  for (const { name, gate } of gates) {
    try {
      const verdict = await gate(session);
      if (!verdict.allowed) {
        log.info('Wake refused by gate', { gate: name, sessionId: session.id, reason: verdict.reason });
        return false;
      }
    } catch (err) {
      log.warn('Wake gate failed; refusing to start (fail closed)', { gate: name, sessionId: session.id, err });
      return false;
    }
  }
  return true;
}

/** Test helper. */
export function _clearWakeGatesForTesting(): void {
  gates.length = 0;
}
