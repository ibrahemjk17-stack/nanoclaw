import { describe, expect, it, vi } from 'vitest';

import { handleTail, parseCommand, runCommand } from './commands.js';

describe('parseCommand', () => {
  it('recognises /stop and /resume in any case, with a bot suffix or trailing text', () => {
    expect(parseCommand('/stop')).toBe('stop');
    expect(parseCommand('/STOP')).toBe('stop');
    expect(parseCommand('  /stop@JarvisBot  ')).toBe('stop');
    expect(parseCommand('/stop now please')).toBe('stop');
    expect(parseCommand('/resume')).toBe('resume');
  });
  it('ignores anything else, including lookalikes', () => {
    for (const t of [
      '',
      'stop',
      'please /stop',
      '/stopp',
      '/stops',
      '/st op',
      '/clear',
      '/today',
      '\\stop',
      '/ stop',
    ]) {
      expect(parseCommand(t), t).toBeNull();
    }
  });
});

describe('runCommand', () => {
  const make = (over: Partial<Parameters<typeof runCommand>[1]> = {}) => {
    const calls: string[] = [];
    let paused = false;
    return {
      calls,
      deps: {
        isPaused: () => paused,
        setPaused: (p: boolean) => {
          calls.push(`pause=${p}`);
          paused = p;
        },
        killAll: (r: string) => {
          calls.push(`kill:${r}`);
          return 2;
        },
        ...over,
      },
    };
  };
  it('/stop pauses BEFORE killing, so nothing can start in between, and reports the count', () => {
    const { calls, deps } = make();
    const text = runCommand('stop', deps);
    expect(calls).toEqual(['pause=true', 'kill:owner /stop']);
    expect(text).toContain('2 agents halted');
  });
  it('/stop with nothing running still pauses and says so', () => {
    const { calls, deps } = make({ killAll: () => 0 });
    expect(runCommand('stop', deps)).toContain('No agent was running');
    expect(calls).toEqual(['pause=true']);
  });
  it('/stop is safe to repeat', () => {
    const { deps } = make();
    runCommand('stop', deps);
    expect(() => runCommand('stop', deps)).not.toThrow();
  });
  it('/resume lifts the pause, and says so when there was none', () => {
    const { calls, deps } = make();
    expect(runCommand('resume', deps)).toContain('Already running');
    runCommand('stop', deps);
    expect(runCommand('resume', deps)).toContain('Resumed');
    expect(calls.at(-1)).toBe('pause=false');
  });
  it('uses singular wording for one agent', () => {
    const { deps } = make({ killAll: vi.fn(() => 1) });
    expect(runCommand('stop', deps)).toContain('1 agent halted');
  });
});

describe('handleTail', () => {
  it('takes the numeric id from a bare or prefixed handle', () => {
    expect(handleTail('5617441184')).toBe('5617441184');
    expect(handleTail('telegram:5617441184')).toBe('5617441184');
    expect(handleTail(undefined)).toBeUndefined();
  });
});
