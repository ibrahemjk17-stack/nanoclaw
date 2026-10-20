import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '../../types.js';

import {
  appendToSpool,
  createUsageHandler,
  flushSpool,
  readSpool,
  spoolGate,
  spoolPath,
  spoolPending,
  type UsageDeps,
} from './usage.js';

const session = (id = 'sess-1', group = 'g-qaaf') => ({ id, agent_group_id: group }) as unknown as Session;
const usage = (n = 1) => ({
  models: { sonnet: { input: 100 * n, output: 10 * n, cacheRead: 0, cacheWrite: 0, costUsd: 0.01 * n } },
  totalCostUsd: 0.01 * n,
  turn: null,
});

beforeEach(() => {
  process.env.JARVIS_USAGE_SPOOL = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jv-spool-')), 'spool.jsonl');
});

function make(
  over: Partial<UsageDeps> = {},
  answer: unknown = { recorded: 1, allowed: true, reason: '', notice: null },
) {
  const calls: { path: string; body: any }[] = [];
  const notices: string[] = [];
  const killed: string[] = [];
  const warns: string[] = [];
  let reply: unknown = answer;
  const deps: UsageDeps = {
    data: async (p, body) => {
      calls.push({ path: p, body });
      if (reply instanceof Error) throw reply;
      return reply;
    },
    groupName: async (id) => (id === 'g-qaaf' ? 'qaaf' : id === 'g-life' ? 'life' : null),
    notify: async (t) => void notices.push(t),
    kill: (id, reason) => void killed.push(`${id}:${reason}`),
    warn: (m) => void warns.push(m),
    ...over,
  };
  return { deps, calls, notices, killed, warns, setReply: (r: unknown) => (reply = r) };
}

describe('a usage report from a container', () => {
  it('goes to the data server with the session, the group NAME and the usage as reported', async () => {
    const m = make();
    await createUsageHandler(m.deps)({ action: 'usage', usage: usage() }, session());
    expect(m.calls).toEqual([{ path: '/host/usage', body: { session_id: 'sess-1', group: 'qaaf', usage: usage() } }]);
    expect(m.killed).toEqual([]);
    expect(spoolPending()).toBe(false);
  });

  it('passes the owner notice on', async () => {
    const m = make({}, { recorded: 1, allowed: true, reason: '', notice: '⚠️ qaaf is at 85%' });
    await createUsageHandler(m.deps)({ usage: usage() }, session());
    expect(m.notices).toEqual(['⚠️ qaaf is at 85%']);
  });

  it('STOPS the container at once when the report takes the group over its limit', async () => {
    const m = make(
      {},
      {
        recorded: 1,
        allowed: false,
        reason: 'qaaf daily limit reached ($0.21 of $0.20 estimated)',
        notice: '⛔ qaaf reached its daily limit',
      },
    );
    await createUsageHandler(m.deps)({ usage: usage() }, session('sess-9'));
    expect(m.killed).toEqual(['sess-9:budget: qaaf daily limit reached ($0.21 of $0.20 estimated)']);
    expect(m.notices).toEqual(['⛔ qaaf reached its daily limit']);
  });

  it('a failing owner notice does not stop the kill', async () => {
    const m = make(
      {
        notify: async () => {
          throw new Error('telegram down');
        },
      },
      { recorded: 1, allowed: false, reason: 'over', notice: 'n' },
    );
    await createUsageHandler(m.deps)({ usage: usage() }, session());
    expect(m.killed).toHaveLength(1);
  });

  it('ignores a message with no usage object (and says so)', async () => {
    const m = make();
    for (const bad of [{}, { usage: null }, { usage: 'x' }]) await createUsageHandler(m.deps)(bad as never, session());
    expect(m.calls).toEqual([]);
    expect(m.warns).toHaveLength(3);
  });
});

describe('when the data server cannot be reached: nothing is lost, nothing new starts', () => {
  it('spools the report and refuses new starts until it is recorded', async () => {
    const m = make({}, new Error('ECONNREFUSED'));
    await createUsageHandler(m.deps)({ usage: usage() }, session());
    expect(readSpool()).toEqual([{ session_id: 'sess-1', agent_group_id: 'g-qaaf', usage: usage() }]);
    expect(await spoolGate()).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/usage reports are pending/),
    });
    expect(m.killed).toEqual([]); // an outage is not a budget decision about the running container
  });

  it('the gate says yes when nothing is waiting', async () => {
    expect(await spoolGate()).toEqual({ allowed: true });
  });

  it('keeps reports in order: later ones queue behind a pending one, and nothing is sent out of order', async () => {
    const m = make({}, new Error('ECONNREFUSED'));
    const h = createUsageHandler(m.deps);
    await h({ usage: usage(1) }, session());
    await h({ usage: usage(2) }, session());
    await h({ usage: usage(3) }, session());
    expect(readSpool().map((i) => (i.usage as any).totalCostUsd)).toEqual([0.01, 0.02, 0.03]);
  });

  it('a flush clears the spool once the server is back, oldest first, and the gate opens', async () => {
    const m = make({}, new Error('ECONNREFUSED'));
    const h = createUsageHandler(m.deps);
    await h({ usage: usage(1) }, session());
    await h({ usage: usage(2) }, session());
    m.calls.length = 0;
    m.setReply({ recorded: 1, allowed: true, reason: '', notice: null });
    expect(await flushSpool(m.deps)).toBe(2);
    expect(m.calls.map((c) => c.body.usage.totalCostUsd)).toEqual([0.01, 0.02]);
    expect(spoolPending()).toBe(false);
    expect(fs.existsSync(spoolPath())).toBe(false);
    expect(await spoolGate()).toEqual({ allowed: true });
  });

  it('a flush stops at the first report that still cannot be sent, keeping the rest in order', async () => {
    const m = make({}, new Error('ECONNREFUSED'));
    await createUsageHandler(m.deps)({ usage: usage(1) }, session());
    appendToSpool({ session_id: 'sess-2', agent_group_id: 'g-life', usage: usage(2) });
    expect(await flushSpool(m.deps)).toBe(0);
    expect(readSpool()).toHaveLength(2);
    expect(m.calls).toHaveLength(2); // the handler's own try, plus one attempt now: the second was never tried out of order
  });

  it('a flushed report that takes a group over the limit stops its container too', async () => {
    const m = make({}, new Error('ECONNREFUSED'));
    await createUsageHandler(m.deps)({ usage: usage() }, session('sess-7'));
    m.setReply({ recorded: 1, allowed: false, reason: 'over', notice: null });
    await flushSpool(m.deps);
    expect(m.killed).toEqual(['sess-7:budget: over']);
  });

  it('survives a torn last line in the spool file (a crash mid-write)', async () => {
    appendToSpool({ session_id: 's', agent_group_id: 'g-qaaf', usage: usage() });
    fs.appendFileSync(spoolPath(), '{"session_id":"half');
    expect(readSpool()).toHaveLength(1);
    const m = make();
    expect(await flushSpool(m.deps)).toBe(1);
  });
});

describe('reports that can never succeed are dropped, not retried forever', () => {
  it('a rejection (HTTP 400) is dropped with a warning and nothing is spooled', async () => {
    const m = make({}, new Error('data server answered 400'));
    await createUsageHandler(m.deps)({ usage: usage() }, session());
    expect(spoolPending()).toBe(false);
    expect(m.warns.join('\n')).toMatch(/rejected by the data server; dropped/);
  });
  it('a server error (HTTP 500) is retried, not dropped', async () => {
    const m = make({}, new Error('data server answered 500'));
    await createUsageHandler(m.deps)({ usage: usage() }, session());
    expect(spoolPending()).toBe(true);
  });
  it('an unknown agent group is dropped', async () => {
    const m = make();
    await createUsageHandler(m.deps)({ usage: usage() }, session('s', 'g-unknown'));
    expect(m.calls).toEqual([]);
    expect(spoolPending()).toBe(false);
    expect(m.warns.join('\n')).toMatch(/unknown agent group/);
  });
  it('a failing group lookup is retried (spooled), not dropped', async () => {
    const m = make({
      groupName: async () => {
        throw new Error('db locked');
      },
    });
    await createUsageHandler(m.deps)({ usage: usage() }, session());
    expect(spoolPending()).toBe(true);
  });
});
