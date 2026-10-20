import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  interceptor: null as null | ((e: unknown) => Promise<boolean>),
  paused: false,
  killed: [] as string[],
  sent: [] as { platformId: string; text: string }[],
  order: [] as string[],
  ownerEnv: { TELEGRAM_OWNER_ID: '555' } as Record<string, string>,
}));

vi.mock('../../router.js', () => ({
  registerMessageInterceptor: (fn: (e: unknown) => Promise<boolean>) => {
    state.interceptor = fn;
  },
}));
vi.mock('../../container-runner.js', () => ({
  killAllContainers: (reason: string) => {
    state.order.push('kill');
    state.killed.push(reason);
    return 3;
  },
}));
vi.mock('../../delivery.js', () => ({
  getDeliveryAdapter: () => ({
    deliver: async (_c: string, platformId: string, _t: null, _k: string, content: string) => {
      state.sent.push({ platformId, text: (JSON.parse(content) as { text: string }).text });
    },
  }),
}));
vi.mock('../../env.js', () => ({ readEnvFile: () => state.ownerEnv }));
vi.mock('./pause.js', () => ({
  isHostPaused: () => state.paused,
  setHostPaused: (p: boolean) => {
    state.order.push(`pause=${p}`);
    state.paused = p;
  },
}));
vi.mock('../../log.js', () => ({
  log: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
}));

await import('./index.js');

const event = (text: string, sender: string | undefined, platformId = 'telegram:-100:21') => ({
  channelType: 'telegram',
  platformId,
  threadId: null,
  message: {
    id: 'm',
    kind: 'chat-sdk',
    timestamp: 'now',
    content: JSON.stringify({ text, ...(sender ? { author: { userId: sender } } : {}) }),
  },
});

beforeEach(() => {
  state.paused = false;
  state.killed = [];
  state.sent = [];
  state.order = [];
  state.ownerEnv = { TELEGRAM_OWNER_ID: '555' };
  delete process.env.TELEGRAM_OWNER_ID;
});

describe('the owner commands, intercepted before any agent', () => {
  it('registers an interceptor', () => {
    expect(state.interceptor).toBeTypeOf('function');
  });

  it('/stop from the owner pauses, kills, answers in the same chat, and consumes the message', async () => {
    const consumed = await state.interceptor!(event('/stop', '555', 'telegram:-100:25'));
    expect(consumed).toBe(true);
    expect(state.order).toEqual(['pause=true', 'kill']);
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0]).toMatchObject({ platformId: 'telegram:-100:25' });
    expect(state.sent[0]!.text).toContain('3 agents halted');
  });
  it('accepts the owner id with a channel prefix', async () => {
    expect(await state.interceptor!(event('/stop', 'telegram:555'))).toBe(true);
  });
  it('does nothing at all for anyone else: no pause, no kill, no reply, not consumed', async () => {
    for (const sender of ['556', '5550', 'telegram:1', undefined]) {
      expect(await state.interceptor!(event('/stop', sender))).toBe(false);
    }
    expect(state.order).toEqual([]);
    expect(state.sent).toEqual([]);
  });
  it('does nothing when no owner id is configured, even for a matching-looking sender', async () => {
    state.ownerEnv = {};
    expect(await state.interceptor!(event('/stop', '555'))).toBe(false);
    expect(await state.interceptor!(event('/stop', ''))).toBe(false);
    expect(state.order).toEqual([]);
  });
  it('/resume lifts the pause', async () => {
    state.paused = true;
    expect(await state.interceptor!(event('/resume', '555'))).toBe(true);
    expect(state.paused).toBe(false);
    expect(state.sent[0]!.text).toContain('Resumed');
  });
  it('an ordinary owner message passes through untouched while running', async () => {
    expect(await state.interceptor!(event('finished the home page', '555'))).toBe(false);
    expect(state.sent).toEqual([]);
  });
  it('while stopped, an ordinary owner message is queued (not consumed) and the owner is told once per chat', async () => {
    state.paused = true;
    expect(await state.interceptor!(event('hello', '555', 'telegram:-100:30'))).toBe(false);
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0]!.text).toContain('/resume');
    expect(await state.interceptor!(event('hello again', '555', 'telegram:-100:30'))).toBe(false);
    expect(state.sent).toHaveLength(1); // throttled
    expect(await state.interceptor!(event('other topic', '555', 'telegram:-100:31'))).toBe(false);
    expect(state.sent).toHaveLength(2); // a different chat is told separately
  });
  it('while stopped, a stranger gets no notice either', async () => {
    state.paused = true;
    expect(await state.interceptor!(event('hello', '999'))).toBe(false);
    expect(state.sent).toEqual([]);
  });
  it('survives malformed content', async () => {
    const bad = {
      channelType: 'telegram',
      platformId: 'p',
      threadId: null,
      message: { id: 'm', kind: 'chat-sdk', timestamp: 'now', content: 'not json' },
    };
    expect(await state.interceptor!(bad)).toBe(false);
  });
});
