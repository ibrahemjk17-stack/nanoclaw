import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  interceptor: null as null | ((e: unknown) => Promise<boolean>),
  actionHandler: null as null | ((e: unknown, a: unknown) => Promise<boolean>),
  paused: false,
  killed: [] as string[],
  sent: [] as { platformId: string; kind: string; content: string }[],
  order: [] as string[],
  env: {
    TELEGRAM_OWNER_ID: '555',
    JARVIS_DATA_URL: 'http://data.test:3300',
    JARVIS_HOST_TOKEN: 'host-token',
  } as Record<string, string>,
  fetched: [] as { url: string; auth: string | null }[],
  dataDown: false,
}));

vi.mock('../../router.js', () => ({
  registerMessageInterceptor: (fn: (e: unknown) => Promise<boolean>) => {
    state.interceptor = fn;
  },
}));
vi.mock('../../channels/question-render-registry.js', () => ({
  registerQuestionActionHandler: (fn: (e: unknown, a: unknown) => Promise<boolean>) => {
    state.actionHandler = fn;
  },
}));
vi.mock('../../container-runner.js', () => ({
  killAllContainers: (reason: string) => {
    state.order.push('kill');
    state.killed.push(reason);
    return 3;
  },
  getActiveContainerCount: () => 2,
  killContainer: () => undefined,
  listActiveSessionIds: () => [],
}));
vi.mock('../../db/sessions.js', () => ({ getSession: async () => undefined }));
vi.mock('../../db/agent-groups.js', () => ({ getAgentGroup: async () => undefined }));
vi.mock('../../guard/index.js', () => ({ unguarded: (reason: string) => ({ reason }) }));
vi.mock('./resolve.js', () => ({ resolveSession: async () => null }));
vi.mock('../../delivery.js', () => ({
  registerDeliveryAction: () => undefined,
  getDeliveryAdapter: () => ({
    deliver: async (_c: string, platformId: string, _t: null, kind: string, content: string) => {
      state.sent.push({ platformId, kind, content });
    },
  }),
}));
vi.mock('../../env.js', () => ({
  readEnvFile: (keys: string[]) => Object.fromEntries(keys.filter((k) => k in state.env).map((k) => [k, state.env[k]])),
}));
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

// the data server, as the host sees it
vi.stubGlobal(
  'fetch',
  vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
    state.fetched.push({ url, auth: init.headers.authorization ?? null });
    if (state.dataDown) throw new Error('ECONNREFUSED');
    const path = new URL(url).pathname;
    const body =
      path === '/host/habits'
        ? { signature: 'abc123', labels: ['💧 Water +1', '🏃 Exercise'] }
        : { text: `text for ${path}` };
    return { ok: true, status: 200, json: async () => body };
  }),
);

await import('./index.js');

const text = (s: (typeof state.sent)[number]) => (JSON.parse(s.content) as { text: string }).text;
const event = (msg: string, sender: string | undefined, platformId = 'telegram:-100:21') => ({
  channelType: 'telegram',
  platformId,
  threadId: null,
  message: {
    id: 'm',
    kind: 'chat-sdk',
    timestamp: 'now',
    content: JSON.stringify({ text: msg, ...(sender ? { author: { userId: sender } } : {}) }),
  },
});

beforeEach(() => {
  state.paused = false;
  state.killed = [];
  state.sent = [];
  state.order = [];
  state.fetched = [];
  state.dataDown = false;
  state.env = { TELEGRAM_OWNER_ID: '555', JARVIS_DATA_URL: 'http://data.test:3300', JARVIS_HOST_TOKEN: 'host-token' };
  delete process.env.TELEGRAM_OWNER_ID;
});

describe('the owner commands, intercepted before any agent', () => {
  it('registers a message interceptor and a button handler', () => {
    expect(state.interceptor).toBeTypeOf('function');
    expect(state.actionHandler).toBeTypeOf('function');
  });

  it('/stop from the owner pauses, kills, answers in the same chat, and consumes the message', async () => {
    const consumed = await state.interceptor!(event('/stop', '555', 'telegram:-100:25'));
    expect(consumed).toBe(true);
    expect(state.order).toEqual(['pause=true', 'kill']);
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0]).toMatchObject({ platformId: 'telegram:-100:25' });
    expect(text(state.sent[0]!)).toContain('3 agents halted');
    expect(state.fetched).toEqual([]); // /stop needs no data service
  });
  it('accepts the owner id with a channel prefix', async () => {
    expect(await state.interceptor!(event('/stop', 'telegram:555'))).toBe(true);
  });
  it('does nothing at all for anyone else, for every command: no pause, no kill, no data call, no reply, not consumed', async () => {
    for (const cmd of ['/stop', '/resume', '/today', '/status', '/budget', '/log']) {
      for (const sender of ['556', '5550', 'telegram:1', undefined]) {
        expect(await state.interceptor!(event(cmd, sender)), `${cmd} from ${sender}`).toBe(false);
      }
    }
    expect(state.order).toEqual([]);
    expect(state.sent).toEqual([]);
    expect(state.fetched).toEqual([]);
  });
  it('does nothing when no owner id is configured, even for a matching-looking sender', async () => {
    state.env = {};
    expect(await state.interceptor!(event('/stop', '555'))).toBe(false);
    expect(await state.interceptor!(event('/stop', ''))).toBe(false);
    expect(state.order).toEqual([]);
  });
  it('/resume lifts the pause', async () => {
    state.paused = true;
    expect(await state.interceptor!(event('/resume', '555'))).toBe(true);
    expect(state.paused).toBe(false);
    expect(text(state.sent[0]!)).toContain('Resumed');
  });

  it('/today asks the data server with the host token and replies with its text', async () => {
    expect(await state.interceptor!(event('/today', '555', 'telegram:-100:4'))).toBe(true);
    expect(state.fetched).toEqual([{ url: 'http://data.test:3300/host/today', auth: 'Bearer host-token' }]);
    expect(state.sent[0]).toMatchObject({ platformId: 'telegram:-100:4' });
    expect(text(state.sent[0]!)).toBe('text for /host/today');
  });
  it('/status adds the host facts (running agents) to the data', async () => {
    await state.interceptor!(event('/status', '555'));
    const t = text(state.sent[0]!);
    expect(t).toContain('Agents running now: 2');
    expect(t).toContain('text for /host/status');
  });
  it('/budget works; and a data service that is down gives a plain message, not silence', async () => {
    await state.interceptor!(event('/budget', '555'));
    expect(text(state.sent[0]!)).toBe('text for /host/budget');
    state.sent = [];
    state.dataDown = true;
    expect(await state.interceptor!(event('/today', '555'))).toBe(true);
    expect(text(state.sent[0]!)).toMatch(/not reachable/);
  });
  it('/log posts the quick-log card as buttons in the same chat', async () => {
    expect(await state.interceptor!(event('/log', '555', 'telegram:-100:4'))).toBe(true);
    expect(state.sent).toHaveLength(1);
    const c = JSON.parse(state.sent[0]!.content);
    expect(c).toMatchObject({ type: 'ask_question', questionId: 'jv-log-abc123', title: 'Quick log' });
    expect(c.options).toHaveLength(2);
  });
  it('/log with the data service down says so instead of posting empty buttons', async () => {
    state.dataDown = true;
    await state.interceptor!(event('/log', '555'));
    expect(state.sent).toHaveLength(1);
    expect(text(state.sent[0]!)).toMatch(/did not work/);
  });

  it('an ordinary owner message passes through untouched while running', async () => {
    expect(await state.interceptor!(event('finished the home page', '555'))).toBe(false);
    expect(state.sent).toEqual([]);
  });
  it('commands that are not ours (for example /clear) pass through untouched', async () => {
    expect(await state.interceptor!(event('/clear', '555'))).toBe(false);
    expect(state.sent).toEqual([]);
  });
  it('while stopped, an ordinary owner message is queued (not consumed) and the owner is told once per chat', async () => {
    state.paused = true;
    expect(await state.interceptor!(event('hello', '555', 'telegram:-100:30'))).toBe(false);
    expect(state.sent).toHaveLength(1);
    expect(text(state.sent[0]!)).toContain('/resume');
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
