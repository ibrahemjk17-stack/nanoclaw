import { describe, expect, it, vi } from 'vitest';

import type { Session } from '../../types.js';

import {
  createBudgetCheck,
  createBudgetGate,
  createBudgetSweep,
  SWEEPS_BEFORE_UNREACHABLE_KILL,
  UNREACHABLE,
  type BudgetGateDeps,
} from './budget.js';

const session = (id: string, group = 'g-qaaf') => ({ id, agent_group_id: group }) as unknown as Session;

function make(over: Partial<BudgetGateDeps> = {}, answer: unknown = { allowed: true, reason: '', notice: null }) {
  const calls: { path: string; body: unknown }[] = [];
  const notices: string[] = [];
  let clock = 1_000_000;
  const deps: BudgetGateDeps = {
    data: async (path, body) => {
      calls.push({ path, body });
      if (answer instanceof Error) throw answer;
      return answer;
    },
    resolve: async (s) =>
      s.agent_group_id === 'g-qaaf'
        ? { group: 'qaaf', model: 'sonnet' }
        : s.agent_group_id === 'g-none'
          ? null
          : { group: 'life', model: undefined },
    notify: async (t) => {
      notices.push(t);
    },
    now: () => clock,
    warn: () => undefined,
    ...over,
  };
  return { deps, calls, notices, tick: (ms: number) => (clock += ms) };
}

describe('the pre-run check', () => {
  it('asks the data server with the group and model, and allows what it allows', async () => {
    const { deps, calls } = make();
    expect(await createBudgetGate(deps)(session('s1'))).toEqual({ allowed: true, reason: '' });
    expect(calls).toEqual([{ path: '/host/budget/check', body: { group: 'qaaf', model: 'sonnet' } }]);
  });
  it('sends no-model as null, so the server can refuse it', async () => {
    const { deps, calls } = make();
    await createBudgetGate(deps)(session('s2', 'g-life'));
    expect(calls[0]!.body).toEqual({ group: 'life', model: null });
  });
  it('refuses what the data server refuses, with its reason', async () => {
    const { deps } = make(
      {},
      { allowed: false, reason: 'qaaf daily limit reached ($0.20 of $0.20 estimated)', notice: null },
    );
    expect(await createBudgetGate(deps)(session('s1'))).toEqual({
      allowed: false,
      reason: 'qaaf daily limit reached ($0.20 of $0.20 estimated)',
    });
  });
  it("passes the server's notice on to the owner, and a failing notice never changes the decision", async () => {
    const a = make({}, { allowed: false, reason: 'x', notice: '⛔ qaaf reached its daily limit' });
    await createBudgetGate(a.deps)(session('s1'));
    expect(a.notices).toEqual(['⛔ qaaf reached its daily limit']);
    const b = make(
      {
        notify: async () => {
          throw new Error('telegram down');
        },
      },
      { allowed: false, reason: 'x', notice: 'n' },
    );
    expect((await createBudgetGate(b.deps)(session('s1'))).allowed).toBe(false);
    const c = make(
      {
        notify: async () => {
          throw new Error('telegram down');
        },
      },
      { allowed: true, reason: '', notice: 'warn' },
    );
    expect((await createBudgetGate(c.deps)(session('s1'))).allowed).toBe(true);
  });
});

describe('fail closed', () => {
  it('refuses when the data server cannot be reached, and tells the owner (at most every 30 minutes)', async () => {
    const m = make({}, new Error('ECONNREFUSED'));
    const gate = createBudgetGate(m.deps);
    expect(await gate(session('s1'))).toEqual({ allowed: false, reason: UNREACHABLE });
    expect(m.notices).toHaveLength(1);
    expect(m.notices[0]).toMatch(/budget check is not available/);
    await gate(session('s1'));
    expect(m.notices).toHaveLength(1);
    m.tick(31 * 60_000);
    await gate(session('s1'));
    expect(m.notices).toHaveLength(2);
  });
  it('refuses an answer that is not a clear yes/no', async () => {
    for (const bad of [null, {}, 'yes', { allowed: 'true' }, { allowed: 1 }, []]) {
      expect((await createBudgetGate(make({}, bad).deps)(session('s1'))).allowed, JSON.stringify(bad)).toBe(false);
    }
  });
  it('refuses a session whose agent group is unknown', async () => {
    const { deps, calls } = make();
    expect(await createBudgetGate(deps)(session('s3', 'g-none'))).toEqual({
      allowed: false,
      reason: 'unknown agent group',
    });
    expect(calls).toEqual([]);
  });
  it('refuses when the group lookup itself fails', async () => {
    const { deps } = make({
      resolve: async () => {
        throw new Error('db locked');
      },
    });
    await expect(createBudgetGate(deps)(session('s1'))).rejects.toThrow(); // the wake-gate registry turns a throw into a refusal (tested there)
  });
});

describe('remembering a refusal', () => {
  it('does not ask the server again for 30 seconds, then asks again', async () => {
    const m = make({}, { allowed: false, reason: 'limit', notice: null });
    const check = createBudgetCheck(m.deps);
    await check('qaaf', 'sonnet');
    await check('qaaf', 'sonnet');
    await check('qaaf', 'sonnet');
    expect(m.calls).toHaveLength(1);
    m.tick(31_000);
    await check('qaaf', 'sonnet');
    expect(m.calls).toHaveLength(2);
  });
  it('is per group and model: another group is asked on its own', async () => {
    const m = make({}, { allowed: false, reason: 'limit', notice: null });
    const check = createBudgetCheck(m.deps);
    await check('qaaf', 'sonnet');
    await check('life', 'haiku');
    expect(m.calls).toHaveLength(2);
  });
  it('never remembers a yes: a later start is checked again', async () => {
    const m = make();
    const check = createBudgetCheck(m.deps);
    await check('qaaf', 'sonnet');
    await check('qaaf', 'sonnet');
    expect(m.calls).toHaveLength(2);
  });
});

describe('the sweep over running agents', () => {
  const sweepDeps = (m: ReturnType<typeof make>, active: string[], killed: string[] = []) => ({
    ...m.deps,
    listActive: () => active,
    getSession: async (id: string) =>
      id === 'gone' ? undefined : session(id, id.startsWith('life') ? 'g-life' : 'g-qaaf'),
    kill: (id: string, reason: string) => {
      killed.push(`${id}:${reason}`);
    },
  });
  it('stops a running agent whose group is over its limit, and leaves the others', async () => {
    const m = make({}, { allowed: true, reason: '', notice: null });
    const killed: string[] = [];
    m.deps.data = async (_p, body) =>
      (body as { group: string }).group === 'qaaf'
        ? { allowed: false, reason: 'qaaf daily limit reached', notice: null }
        : { allowed: true, reason: '', notice: null };
    const sweep = createBudgetSweep({ ...sweepDeps(m, ['qaaf-1', 'life-1'], killed), data: m.deps.data });
    expect(await sweep()).toBe(1);
    expect(killed).toEqual(['qaaf-1:budget: qaaf daily limit reached']);
  });
  it('stops nothing when everything is allowed', async () => {
    const m = make();
    const killed: string[] = [];
    expect(await createBudgetSweep(sweepDeps(m, ['qaaf-1', 'life-1'], killed))()).toBe(0);
    expect(killed).toEqual([]);
  });
  it('stops a running agent whose session or group has vanished', async () => {
    const m = make();
    const killed: string[] = [];
    expect(await createBudgetSweep(sweepDeps(m, ['gone'], killed))()).toBe(1);
    expect(killed[0]).toMatch(/unknown agent group/);
  });
  it('is patient with a short outage of the budget service, but stops agents once it has lasted', async () => {
    const m = make({}, new Error('ECONNREFUSED'));
    const killed: string[] = [];
    const sweep = createBudgetSweep(sweepDeps(m, ['qaaf-1'], killed));
    for (let i = 1; i < SWEEPS_BEFORE_UNREACHABLE_KILL; i++) {
      m.tick(31_000);
      expect(await sweep(), `sweep ${i}`).toBe(0);
    }
    m.tick(31_000);
    expect(await sweep()).toBe(1);
    expect(killed[0]).toMatch(/budget service unreachable/);
  });
  it('an answered sweep resets the patience', async () => {
    let down = true;
    const m = make({
      data: async () => {
        if (down) throw new Error('ECONNREFUSED');
        return { allowed: true, reason: '', notice: null };
      },
    });
    const killed: string[] = [];
    const sweep = createBudgetSweep(sweepDeps(m, ['qaaf-1'], killed));
    m.tick(31_000);
    await sweep();
    m.tick(31_000);
    await sweep();
    down = false;
    m.tick(31_000);
    await sweep(); // back up
    down = true;
    m.tick(31_000);
    await sweep();
    m.tick(31_000);
    expect(await sweep()).toBe(0); // two failures again, not three
    expect(killed).toEqual([]);
  });
  it('never throws, even when one agent cannot be checked', async () => {
    const m = make();
    const killed: string[] = [];
    const sweep = createBudgetSweep({
      ...sweepDeps(m, ['qaaf-1', 'qaaf-2'], killed),
      getSession: vi.fn(async (id: string) => {
        if (id === 'qaaf-1') throw new Error('db');
        return session(id);
      }),
    });
    await expect(sweep()).resolves.toBe(0);
  });
});
