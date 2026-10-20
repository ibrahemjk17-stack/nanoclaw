import fs from 'fs';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const dir = vi.hoisted(() => {
  // hoisted so the mock factory can see it
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsx = require('fs') as typeof import('fs');
  const osx = require('os') as typeof import('os'); // eslint-disable-line @typescript-eslint/no-require-imports
  const px = require('path') as typeof import('path'); // eslint-disable-line @typescript-eslint/no-require-imports
  return fsx.mkdtempSync(px.join(osx.tmpdir(), 'jarvis-pause-'));
});
vi.mock('../../config.js', () => ({ DATA_DIR: dir }));

import { isHostPaused, setHostPaused } from './pause.js';

const flag = path.join(dir, 'jarvis-paused');

beforeEach(() => {
  delete process.env.JARVIS_PAUSE_FILE; // these tests are about the default location (data dir); the global setup overrides it
  fs.rmSync(flag, { force: true });
});

describe('pause flag', () => {
  it('starts not paused', () => {
    expect(isHostPaused()).toBe(false);
  });
  it('is the file: a stop survives a restart, because there is no other state', () => {
    setHostPaused(true);
    expect(isHostPaused()).toBe(true);
    expect(fs.existsSync(flag)).toBe(true);
  });
  it('resume removes the file', () => {
    setHostPaused(true);
    setHostPaused(false);
    expect(isHostPaused()).toBe(false);
    expect(fs.existsSync(flag)).toBe(false);
  });
  it('an emergency stop from a shell (creating the file) is seen at once, and removing it resumes', () => {
    fs.writeFileSync(flag, '');
    expect(isHostPaused()).toBe(true);
    fs.rmSync(flag);
    expect(isHostPaused()).toBe(false);
  });
  it('is safe to set twice, and to resume when not paused', () => {
    setHostPaused(true);
    setHostPaused(true);
    setHostPaused(false);
    setHostPaused(false);
    expect(isHostPaused()).toBe(false);
  });
});
