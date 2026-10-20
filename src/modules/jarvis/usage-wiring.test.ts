/**
 * The REAL Jarvis module, loaded the way NanoClaw loads it: it registers the `usage` delivery action, and calling the registered handler
 * (what the delivery loop does with a container's `usage` system message) reaches the data server with the host token, the group NAME and
 * the usage, and stops a container that the data server says is over.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const killed = vi.hoisted(() => [] as string[]);
vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: (id: string, reason: string) => killed.push(`${id}:${reason}`),
  killAllContainers: () => 0,
  getActiveContainerCount: () => 0,
  listActiveSessionIds: () => [],
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: async (id: string) => (id === 'g-qaaf' ? { id, name: 'qaaf' } : undefined),
}));

const fetched = vi.hoisted(() => ({
  calls: [] as { url: string; init: any }[],
  answer: { recorded: 1, allowed: true, reason: '', notice: null } as any,
}));
vi.stubGlobal(
  'fetch',
  vi.fn(async (url: string, init: unknown) => {
    fetched.calls.push({ url, init });
    return { ok: true, status: 200, json: async () => fetched.answer };
  }),
);

process.env.JARVIS_DATA_URL = 'http://data.test:3300';
process.env.JARVIS_HOST_TOKEN = 'host-token-for-the-test';
process.env.TELEGRAM_OWNER_ID = '555';

const { getDeliveryAction } = await import('../../delivery.js');
await import('./index.js');

const session = { id: 'sess-w1', agent_group_id: 'g-qaaf' } as never;
const usage = {
  models: { 'claude-sonnet-5-5': { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, costUsd: 0.01 } },
  totalCostUsd: 0.01,
  turn: null,
};

beforeEach(() => {
  fetched.calls.length = 0;
  killed.length = 0;
  fetched.answer = { recorded: 1, allowed: true, reason: '', notice: null };
});

describe('the usage delivery action, as registered by the real module', () => {
  it('is registered', () => {
    expect(getDeliveryAction('usage')).toBeTypeOf('function');
  });

  it('sends the report to the data server with the host token, the session id and the group name', async () => {
    await getDeliveryAction('usage')!({ action: 'usage', usage }, session);
    expect(fetched.calls).toHaveLength(1);
    const { url, init } = fetched.calls[0]!;
    expect(url).toBe('http://data.test:3300/host/usage');
    expect(init.headers.authorization).toBe('Bearer host-token-for-the-test');
    expect(JSON.parse(init.body)).toEqual({ session_id: 'sess-w1', group: 'qaaf', usage });
    expect(killed).toEqual([]);
  });

  it('stops the container when the data server says the group is now over its limit', async () => {
    fetched.answer = { recorded: 1, allowed: false, reason: 'qaaf daily limit reached', notice: null };
    await getDeliveryAction('usage')!({ action: 'usage', usage }, session);
    expect(killed).toEqual(['sess-w1:budget: qaaf daily limit reached']);
  });
});
