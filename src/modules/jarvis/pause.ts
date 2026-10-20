/**
 * Jarvis: the host-wide pause flag behind /stop and /resume.
 *
 * While paused, no agent container may start (messages and scheduled tasks stay queued, nothing is lost). The flag is a file in
 * the data directory so a stop survives a restart of the service: a stopped assistant must stay stopped.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';

const flagPath = (): string => path.join(DATA_DIR, 'jarvis-paused');
let paused: boolean | null = null;

export function isHostPaused(): boolean {
  if (paused === null) paused = fs.existsSync(flagPath());
  return paused;
}

export function setHostPaused(value: boolean): void {
  if (value) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(flagPath(), `${new Date().toISOString()}\n`);
  } else {
    fs.rmSync(flagPath(), { force: true });
  }
  paused = value;
}

/** Test helper: forget the cached value so the next read goes to the file. */
export function _resetPauseCacheForTesting(): void {
  paused = null;
}
