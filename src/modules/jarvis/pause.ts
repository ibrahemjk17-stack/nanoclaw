/**
 * Jarvis: the host-wide pause flag behind /stop and /resume.
 *
 * While paused, no agent container may start (messages and scheduled tasks stay queued, nothing is lost). The flag is a file in
 * the data directory, read every time (a stat per container start is negligible), so:
 *  - a stop survives a restart of the service: a stopped assistant must stay stopped;
 *  - `touch data/jarvis-paused` from a shell is an emergency stop that needs no Telegram, and `rm` lifts it.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';

const flagPath = (): string => path.join(DATA_DIR, 'jarvis-paused');

export function isHostPaused(): boolean {
  return fs.existsSync(flagPath());
}

export function setHostPaused(value: boolean): void {
  if (value) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(flagPath(), `${new Date().toISOString()}\n`);
  } else {
    fs.rmSync(flagPath(), { force: true });
  }
}
