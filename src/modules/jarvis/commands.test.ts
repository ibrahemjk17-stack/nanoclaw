import { describe, expect, it, vi } from 'vitest';

import { DATA_DOWN, handleTail, parseCommand, runCommand, type CommandDeps } from './commands.js';

describe('parseCommand', () => {
  it('recognises our commands in any case, with a bot suffix or trailing text', () => {
    expect(parseCommand('/stop')).toBe('stop');
    expect(parseCommand('/STOP')).toBe('stop');
    expect(parseCommand('  /stop@JarvisBot  ')).toBe('stop');
    expect(parseCommand('/stop now please')).toBe('stop');
    for (const c of ['resume', 'today', 'status', 'budget', 'log']) expect(parseCommand(`/${c}`)).toBe(c);
  });
  it('ignores anything else, including lookalikes and commands that are not ours', () => {
    for (const t of [
      '',
      'stop',
      'please /stop',
      '/stopp',
      '/stops',
      '/st op',
      '/clear',
      '/start',
      '/help',
      '\\stop',
      '/ stop',
      '/todayx',
    ]) {
      expect(parseCommand(t), t).toBeNull();
    }
  });
});

function make(over: Partial<CommandDeps> = {}) {
  const calls: string[] = [];
  let paused = false;
  const deps: CommandDeps = {
    isPaused: () => paused,
    setPaused: (p) => {
      calls.push(`pause=${p}`);
      paused = p;
    },
    killAll: (r) => {
      calls.push(`kill:${r}`);
      return 2;
    },
    runningCount: () => 1,
    uptimeSeconds: () => 3 * 3600 + 25 * 60,
    data: async (path) => ({ text: `data for ${path}` }),
    ...over,
  };
  return { calls, deps };
}

describe('/stop and /resume', () => {
  it('/stop pauses BEFORE killing, so nothing can start in between, and reports the count', async () => {
    const { calls, deps } = make();
    const text = await runCommand('stop', deps);
    expect(calls).toEqual(['pause=true', 'kill:owner /stop']);
    expect(text).toContain('2 agents halted');
  });
  it('/stop with nothing running still pauses and says so', async () => {
    const { calls, deps } = make({ killAll: () => 0 });
    expect(await runCommand('stop', deps)).toContain('No agent was running');
    expect(calls).toEqual(['pause=true']);
  });
  it('/stop needs no data service: it works when that is down', async () => {
    const { deps } = make({
      data: async () => {
        throw new Error('down');
      },
    });
    await expect(runCommand('stop', deps)).resolves.toContain('Stopped');
  });
  it('/resume lifts the pause, and says so when there was none', async () => {
    const { calls, deps } = make();
    expect(await runCommand('resume', deps)).toContain('Already running');
    await runCommand('stop', deps);
    expect(await runCommand('resume', deps)).toContain('Resumed');
    expect(calls.at(-1)).toBe('pause=false');
  });
  it('uses singular wording for one agent', async () => {
    const { deps } = make({ killAll: vi.fn(() => 1) });
    expect(await runCommand('stop', deps)).toContain('1 agent halted');
  });
});

describe('/today, /budget, /status', () => {
  it("passes the data server's text through", async () => {
    const { deps } = make();
    expect(await runCommand('today', deps)).toBe('data for /host/today');
    expect(await runCommand('budget', deps)).toBe('data for /host/budget');
  });
  it('says plainly when the data service is down, instead of failing or inventing', async () => {
    const { deps } = make({
      data: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(await runCommand('today', deps)).toBe(DATA_DOWN);
    expect(await runCommand('budget', deps)).toBe(DATA_DOWN);
  });
  it('/status puts the host facts first, then the data', async () => {
    const { deps } = make();
    const t = (await runCommand('status', deps))!;
    expect(t).toContain('Host: ▶️ running, up 3h 25m');
    expect(t).toContain('Agents running now: 1');
    expect(t.endsWith('data for /host/status')).toBe(true);
  });
  it('/status still reports the host when data is down, and shows a stop', async () => {
    const { deps } = make({ isPaused: () => true, data: async () => ({}) });
    const t = (await runCommand('status', deps))!;
    expect(t).toContain('⏸ stopped');
    expect(t).toContain(DATA_DOWN);
  });
  it('/log has no text answer (it posts buttons)', async () => {
    const { deps } = make();
    expect(await runCommand('log', deps)).toBeNull();
  });
});

describe('handleTail', () => {
  it('takes the numeric id from a bare or prefixed handle', () => {
    expect(handleTail('5617441184')).toBe('5617441184');
    expect(handleTail('telegram:5617441184')).toBe('5617441184');
    expect(handleTail(undefined)).toBeUndefined();
  });
});
