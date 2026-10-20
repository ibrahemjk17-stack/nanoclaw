import { beforeEach, describe, expect, it, vi } from 'vitest';

const paused = vi.hoisted(() => ({ value: true }));
const logs = vi.hoisted(() => ({ debug: [] as string[], warn: [] as string[] }));
vi.mock('./pause.js', () => ({ isHostPaused: () => paused.value, setHostPaused: () => undefined }));
vi.mock('../../log.js', () => ({
  log: {
    info: () => undefined,
    error: () => undefined,
    debug: (m: string) => logs.debug.push(m),
    warn: (m: string) => logs.warn.push(m),
  },
}));

import { getActiveContainerCount, killAllContainers, wakeContainer } from '../../container-runner.js';
import type { Session } from '../../types.js';

const session = { id: 'sess-paused-test', agent_group_id: 'g', messaging_group_id: null } as unknown as Session;

beforeEach(() => {
  logs.debug = [];
  logs.warn = [];
});

describe('wakeContainer while Jarvis is stopped', () => {
  it('refuses before any spawn is attempted, so queued messages and schedules simply wait', async () => {
    paused.value = true;
    expect(await wakeContainer(session)).toBe(false);
    expect(logs.debug.some((m) => m.includes('Host paused'))).toBe(true);
    // a spawn attempt (even a failing one) would log this warning: it must not have been tried
    expect(logs.warn.filter((m) => m.includes('wakeContainer failed'))).toEqual([]);
    expect(getActiveContainerCount()).toBe(0);
  });
  it('does try to spawn when not stopped (so the check above can tell the difference)', async () => {
    paused.value = false;
    await wakeContainer(session); // fails in this test environment, which is fine: we only look at whether it tried
    expect(logs.debug.some((m) => m.includes('Host paused'))).toBe(false);
    expect(logs.warn.some((m) => m.includes('wakeContainer failed'))).toBe(true);
  });
  it('killAllContainers with nothing running is a harmless zero', () => {
    expect(killAllContainers('test')).toBe(0);
  });
});
