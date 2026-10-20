/**
 * Jarvis: hands a turn's usage to the host. Written as a `system` outbound message with action `usage`; the host's delivery-action handler
 * forwards it to the data server, which records it against the agent group's budget.
 *
 * A failure here must never fail or delay the turn: the worst case is a missing report, which the host and the data server treat
 * conservatively (see docs/UPSTREAM_PATCHES.md #7).
 */
import type { WriteMessageOut } from './db/messages-out.js';
import type { ReportedUsage } from './providers/usage.js';

export async function reportUsage(
  usage: ReportedUsage,
  write: (msg: WriteMessageOut) => Promise<unknown>,
  log: (line: string) => void,
): Promise<boolean> {
  try {
    await write({
      id: `usage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'system',
      content: JSON.stringify({ action: 'usage', usage }),
    });
    return true;
  } catch (err) {
    log(`Usage report not written: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
