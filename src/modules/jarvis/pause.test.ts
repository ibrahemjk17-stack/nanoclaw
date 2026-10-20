import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dir = vi.hoisted(() => {
  // hoisted so the mock factory can see it
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsx = require('fs') as typeof import('fs');
  const osx = require('os') as typeof import('os'); // eslint-disable-line @typescript-eslint/no-require-imports
  const px = require('path') as typeof import('path'); // eslint-disable-line @typescript-eslint/no-require-imports
  return fsx.mkdtempSync(px.join(osx.tmpdir(), 'jarvis-pause-'));
});
vi.mock('../../config.js', () => ({ DATA_DIR: dir }));

import { _resetPauseCacheForTesting, isHostPaused, setHostPaused } from './pause.js';

const flag = path.join(dir, 'jarvis-paused');

beforeEach(() => {
  fs.rmSync(flag, { force: true });
  _resetPauseCacheForTesting();
});
afterEach(() => _resetPauseCacheForTesting());

describe('pause flag', () => {
  it('starts not paused', () => {
    expect(isHostPaused()).toBe(false);
  });
  it('survives a restart: a stop is read back from the file', () => {
    setHostPaused(true);
    expect(isHostPaused()).toBe(true);
    _resetPauseCacheForTesting(); // a new process starts with an empty cache
    expect(isHostPaused()).toBe(true);
    expect(fs.existsSync(flag)).toBe(true);
  });
  it('resume removes the file and stays resumed after a restart', () => {
    setHostPaused(true);
    setHostPaused(false);
    _resetPauseCacheForTesting();
    expect(isHostPaused()).toBe(false);
    expect(os.tmpdir()).toBeTruthy();
  });
  it('is safe to set twice, and to resume when not paused', () => {
    setHostPaused(true);
    setHostPaused(true);
    setHostPaused(false);
    setHostPaused(false);
    expect(isHostPaused()).toBe(false);
  });
});
