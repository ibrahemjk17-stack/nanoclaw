/**
 * Jarvis: owner commands handled on the host, before any agent sees the message (so they never cost a model call).
 * Pure functions: the wiring to the router and the chat is in index.ts.
 *
 *   /stop /resume   control the host (here, no data needed)
 *   /today /status /budget   text from the data server (our packages/mcp-jarvis-data, /host/*)
 *   /log            posts the quick-log buttons (handled in quicklog.ts)
 */

export type CommandName = 'stop' | 'resume' | 'today' | 'status' | 'budget' | 'log';

const COMMANDS: readonly CommandName[] = ['stop', 'resume', 'today', 'status', 'budget', 'log'];

/** `/stop`, `/stop@BotName`, case-insensitive, optionally followed by text. Anything else is not a command of ours. */
export function parseCommand(text: string): CommandName | null {
  const m = /^\/([a-z]+)(?:@\w+)?(?:\s|$)/i.exec(text.trim());
  const name = m?.[1]?.toLowerCase();
  return COMMANDS.find((c) => c === name) ?? null;
}

export interface CommandDeps {
  isPaused: () => boolean;
  setPaused: (paused: boolean) => void;
  /** Kills every running agent container; returns how many. */
  killAll: (reason: string) => number;
  runningCount: () => number;
  uptimeSeconds: () => number;
  /** POST to the data server's /host/<path>; throws when it cannot be reached. */
  data: (path: string) => Promise<{ text?: string }>;
}

export const DATA_DOWN =
  'The data service is not reachable right now. Try again in a moment, or run scripts/doctor.sh on the host.';

const duration = (s: number): string => {
  const d = Math.floor(s / 86400),
    h = Math.floor((s % 86400) / 3600),
    m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
};

async function fromData(deps: CommandDeps, path: string): Promise<string> {
  try {
    return (await deps.data(path)).text ?? DATA_DOWN;
  } catch {
    return DATA_DOWN;
  }
}

/** The text answer to a command. `log` has no text answer (it posts buttons) and returns null. */
export async function runCommand(name: CommandName, deps: CommandDeps): Promise<string | null> {
  switch (name) {
    case 'stop': {
      // Pause first, so nothing can start between "kill" and "pause"
      deps.setPaused(true);
      const n = deps.killAll('owner /stop');
      return n === 0
        ? '⛔ Stopped. No agent was running; schedules are paused too. Nothing starts until /resume.'
        : `⛔ Stopped. ${n} agent${n === 1 ? '' : 's'} halted and schedules paused. Nothing starts until /resume.`;
    }
    case 'resume':
      if (!deps.isPaused()) return '▶️ Already running.';
      deps.setPaused(false);
      return '▶️ Resumed. Queued messages and schedules will run now.';
    case 'today':
      return fromData(deps, '/host/today');
    case 'budget':
      return fromData(deps, '/host/budget');
    case 'status': {
      const host = [
        `Host: ${deps.isPaused() ? '⏸ stopped (/resume to continue)' : '▶️ running'}, up ${duration(deps.uptimeSeconds())}`,
        `Agents running now: ${deps.runningCount()}`,
      ];
      return `${host.join('\n')}\n${await fromData(deps, '/host/status')}`;
    }
    case 'log':
      return null;
  }
}

/** Shown (at most once in a while per chat) when the owner writes while everything is stopped. */
export const PAUSED_NOTICE = '⏸ Jarvis is stopped. Your message is kept; send /resume and it will be handled.';

/** The numeric Telegram id at the end of a sender handle like "5617441184" or "telegram:5617441184". */
export function handleTail(handle: string | undefined): string | undefined {
  return handle?.split(':').pop();
}
