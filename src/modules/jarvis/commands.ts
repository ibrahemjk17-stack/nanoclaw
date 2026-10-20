/**
 * Jarvis: owner commands handled on the host, before any agent sees the message (so they never cost a model call).
 * Pure functions: the wiring to the router and the chat is in index.ts.
 */

export type CommandName = 'stop' | 'resume';

const COMMANDS: readonly CommandName[] = ['stop', 'resume'];

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
}

export function runCommand(name: CommandName, deps: CommandDeps): string {
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
  }
}

/** Shown (at most once in a while per chat) when the owner writes while everything is stopped. */
export const PAUSED_NOTICE = '⏸ Jarvis is stopped. Your message is kept; send /resume and it will be handled.';

/** The numeric Telegram id at the end of a sender handle like "5617441184" or "telegram:5617441184". */
export function handleTail(handle: string | undefined): string | undefined {
  return handle?.split(':').pop();
}
