/**
 * The budget gate in front of the REAL wakeContainer: nothing starts unless every gate says yes, and a gate that cannot answer is a no.
 * "Started" here means a spawn was attempted (in this test environment the spawn itself fails, which is fine: we only look at whether
 * it was tried, exactly like wake-paused.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const logs = vi.hoisted(() => ({ debug: [] as string[], info: [] as string[], warn: [] as string[] }));
vi.mock('./pause.js', () => ({ isHostPaused: () => false, setHostPaused: () => undefined }));
vi.mock('../../log.js', () => ({
  log: {
    error: () => undefined,
    debug: (m: string) => logs.debug.push(m),
    info: (m: string) => logs.info.push(m),
    warn: (m: string) => logs.warn.push(m),
  },
}));

import { getActiveContainerCount, wakeContainer } from '../../container-runner.js';
import type { Session } from '../../types.js';

import { createBudgetGate } from './budget.js';
import { _clearWakeGatesForTesting, registerWakeGate, runWakeGates } from './wake-gate.js';

let n = 0;
const fresh = () =>
  ({ id: `sess-gate-${++n}`, agent_group_id: 'g-qaaf', messaging_group_id: null }) as unknown as Session;
const spawnAttempted = () => logs.warn.some((m) => m.includes('wakeContainer failed'));
const refused = () => logs.info.some((m) => m.includes('Wake refused by gate'));

beforeEach(() => {
  logs.debug = [];
  logs.info = [];
  logs.warn = [];
  _clearWakeGatesForTesting();
});

describe('wakeContainer and its gates', () => {
  it('without gates it goes on to spawn (the pre-existing behaviour)', async () => {
    await wakeContainer(fresh());
    expect(spawnAttempted()).toBe(true);
  });

  it('a gate that says no means no spawn is even attempted', async () => {
    registerWakeGate('test', async () => ({ allowed: false, reason: 'over budget' }));
    expect(await wakeContainer(fresh())).toBe(false);
    expect(refused()).toBe(true);
    expect(spawnAttempted()).toBe(false);
    expect(getActiveContainerCount()).toBe(0);
  });

  it('a gate that throws is a no (fail closed): no spawn attempt', async () => {
    registerWakeGate('test', async () => {
      throw new Error('cannot check');
    });
    expect(await wakeContainer(fresh())).toBe(false);
    expect(spawnAttempted()).toBe(false);
    expect(logs.warn.some((m) => m.includes('fail closed'))).toBe(true);
  });

  it('a gate that says yes lets it go on to spawn', async () => {
    registerWakeGate('test', async () => ({ allowed: true }));
    await wakeContainer(fresh());
    expect(spawnAttempted()).toBe(true);
  });

  it('every gate must agree: one no is enough, and the later gates are not even asked', async () => {
    const second = vi.fn(async () => ({ allowed: true }));
    registerWakeGate('first', async () => ({ allowed: false, reason: 'no' }));
    registerWakeGate('second', second);
    expect(await runWakeGates(fresh())).toBe(false);
    expect(second).not.toHaveBeenCalled();
  });
});

describe('the budget gate in front of the real wakeContainer', () => {
  const gate = (data: (path: string, body?: unknown) => Promise<unknown>) =>
    createBudgetGate({
      data: data as never,
      resolve: async () => ({ group: 'qaaf', model: 'sonnet' }),
      notify: async () => undefined,
      now: () => Date.now(),
      warn: () => undefined,
    });

  it('BLOCKS when the group is over its limit: nothing starts', async () => {
    registerWakeGate(
      'budget',
      gate(async () => ({ allowed: false, reason: 'qaaf daily limit reached', notice: null })),
    );
    expect(await wakeContainer(fresh())).toBe(false);
    expect(spawnAttempted()).toBe(false);
  });

  it('BLOCKS when the budget service is unreachable: nothing starts', async () => {
    registerWakeGate(
      'budget',
      gate(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    expect(await wakeContainer(fresh())).toBe(false);
    expect(spawnAttempted()).toBe(false);
  });

  it('BLOCKS on an answer that is not a clear yes', async () => {
    registerWakeGate(
      'budget',
      gate(async () => ({ allowed: 'maybe' })),
    );
    expect(await wakeContainer(fresh())).toBe(false);
    expect(spawnAttempted()).toBe(false);
  });

  it('lets a start through only on a clear yes', async () => {
    registerWakeGate(
      'budget',
      gate(async () => ({ allowed: true, reason: '', notice: null })),
    );
    await wakeContainer(fresh());
    expect(spawnAttempted()).toBe(true);
  });
});
