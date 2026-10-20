/**
 * Jarvis patch #6: the Telegram adapter must name the update types it needs. Without an explicit list Telegram keeps the LAST
 * setting any client used, which silently dropped button taps (callback_query) on the owner's bot.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const created = vi.hoisted(() => ({ configs: [] as Record<string, unknown>[] }));

vi.mock('@chat-adapter/telegram', () => ({
  createTelegramAdapter: (config: Record<string, unknown>) => {
    created.configs.push(config);
    return { name: 'telegram', channelIdFromThreadId: (t: string) => t };
  },
}));
vi.mock('./chat-sdk-bridge.js', () => ({ createChatSdkBridge: () => ({ name: 'telegram', type: 'telegram' }) }));
vi.mock('../env.js', () => ({
  readEnvFile: (keys: string[]) =>
    Object.fromEntries(keys.map((k) => [k, k === 'TELEGRAM_BOT_TOKEN' ? '111:test-token' : undefined])),
}));

import { createTelegramBridge, TELEGRAM_ALLOWED_UPDATES } from './telegram.js';

beforeEach(() => {
  created.configs = [];
});

describe('Telegram update types', () => {
  it('always includes button taps, plain messages and edits', () => {
    for (const t of ['callback_query', 'message', 'edited_message']) expect(TELEGRAM_ALLOWED_UPDATES).toContain(t);
  });
  it('are passed to the adapter, so Telegram does not fall back to a stale earlier setting', () => {
    createTelegramBridge({ instanceKey: 'telegram-test-1' });
    expect(created.configs).toHaveLength(1);
    expect(created.configs[0]).toMatchObject({
      mode: 'polling',
      longPolling: { allowedUpdates: expect.arrayContaining(['callback_query']) },
    });
  });
});
