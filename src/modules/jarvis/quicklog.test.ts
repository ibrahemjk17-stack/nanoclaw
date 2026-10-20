import { describe, expect, it, vi } from 'vitest';

import { ACTION_ID, handleQuickLogAction, quickLogCard, quickLogContent, type QuickLogDeps } from './quicklog.js';

const habits = { signature: 'abc123', labels: ['🏃 Exercise', '📖 Reading +10 pages', '💧 Water +1'] };

const make = (over: Partial<QuickLogDeps> = {}) => {
  const calls: { path: string; body?: unknown }[] = [];
  const deps: QuickLogDeps = {
    data: async (path, body) => {
      calls.push({ path, body });
      return path === '/host/habit-log' ? { ok: true, text: '• Water 3/8 cups' } : habits;
    },
    ownerId: () => '555',
    now: () => new Date('2026-10-20T16:05:00Z'),
    warn: () => undefined,
    ...over,
  };
  return { deps, calls };
};
const event = (actionId: string, userId = '555') =>
  ({ actionId, value: '2', user: { userId }, threadId: 'telegram:-100:4', messageId: 'm1' }) as any;
const adapter = () => ({ editMessage: vi.fn(async () => undefined) }) as any;

describe('the card', () => {
  it('is an ask_question card whose id carries the habit-list signature', () => {
    const c = JSON.parse(quickLogContent(habits));
    expect(c).toMatchObject({ type: 'ask_question', questionId: 'jv-log-abc123', title: 'Quick log' });
    expect(c.options.map((o: any) => o.label)).toEqual(habits.labels);
  });
  it('re-renders with button ids NanoClaw routes back to us', () => {
    const json = JSON.stringify(quickLogCard(habits, 'x'));
    for (let i = 0; i < habits.labels.length; i++) expect(json).toContain(`ncq:jv-log-abc123:${i}`);
  });
  it('the action pattern matches only our ids', () => {
    expect(ACTION_ID.test('ncq:jv-log-abc123:2')).toBe(true);
    for (const id of [
      'ncq:other:1',
      'ncq:jv-log-xyz123:1',
      'ncq:jv-log-abc123:x',
      'jv-log-abc123:1',
      'ncq:jv-log-abc1234:1',
    ])
      expect(ACTION_ID.test(id), id).toBe(false);
  });
});

describe('a tap', () => {
  it("logs through the data server with the card's signature and index, then updates the card in place", async () => {
    const { deps, calls } = make();
    const a = adapter();
    expect(await handleQuickLogAction(event('ncq:jv-log-abc123:2'), a, deps)).toBe(true);
    expect(calls[0]).toEqual({ path: '/host/habit-log', body: { signature: 'abc123', index: 2 } });
    expect(a.editMessage).toHaveBeenCalledTimes(1);
    const [tid, mid, content] = a.editMessage.mock.calls[0];
    expect([tid, mid]).toEqual(['telegram:-100:4', 'm1']);
    expect(JSON.stringify(content.card)).toContain('Water 3/8 cups');
    expect(content.fallbackText).toBe('• Water 3/8 cups');
  });
  it('does not claim events that are not ours', async () => {
    const { deps, calls } = make();
    const a = adapter();
    expect(await handleQuickLogAction(event('ncq:some-question:1'), a, deps)).toBe(false);
    expect(calls).toEqual([]);
    expect(a.editMessage).not.toHaveBeenCalled();
  });
  it('ignores a tap by anyone but the owner: claimed, but nothing logged and nothing changed', async () => {
    const { deps, calls } = make();
    const a = adapter();
    expect(await handleQuickLogAction(event('ncq:jv-log-abc123:2', '999'), a, deps)).toBe(true);
    expect(calls).toEqual([]);
    expect(a.editMessage).not.toHaveBeenCalled();
  });
  it('does nothing when no owner is configured', async () => {
    const { deps, calls } = make({ ownerId: () => undefined });
    expect(await handleQuickLogAction(event('ncq:jv-log-abc123:0'), adapter(), deps)).toBe(true);
    expect(calls).toEqual([]);
  });
  it('accepts the owner id with a channel prefix', async () => {
    const { deps, calls } = make();
    await handleQuickLogAction(event('ncq:jv-log-abc123:0', 'telegram:555'), adapter(), deps);
    expect(calls[0]!.path).toBe('/host/habit-log');
  });
  it('survives an unreachable data service: no crash, no card change', async () => {
    const { deps } = make({
      data: async () => {
        throw new Error('down');
      },
    });
    const a = adapter();
    expect(await handleQuickLogAction(event('ncq:jv-log-abc123:0'), a, deps)).toBe(true);
    expect(a.editMessage).not.toHaveBeenCalled();
  });
  it('survives Telegram refusing the edit (for example, identical content)', async () => {
    const warn = vi.fn();
    const { deps } = make({ warn });
    const a = {
      editMessage: vi.fn(async () => {
        throw new Error('message is not modified');
      }),
    } as any;
    expect(await handleQuickLogAction(event('ncq:jv-log-abc123:0'), a, deps)).toBe(true);
    expect(warn).toHaveBeenCalled();
  });
  it('heals a stale card: the update carries the fresh signature', async () => {
    const fresh = { signature: 'def456', labels: ['💧 Water +1'] };
    const { deps } = make({
      data: async (path) =>
        path === '/host/habit-log'
          ? { ok: false, text: 'These buttons are out of date. Send /log for a fresh set.' }
          : fresh,
    });
    const a = adapter();
    await handleQuickLogAction(event('ncq:jv-log-abc123:0'), a, deps);
    const json = JSON.stringify(a.editMessage.mock.calls[0][2].card);
    expect(json).toContain('ncq:jv-log-def456:0');
    expect(json).toContain('out of date');
  });
});
