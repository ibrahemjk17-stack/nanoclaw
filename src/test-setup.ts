import os from 'os';
import path from 'path';

import { beforeEach } from 'vitest';

// Jarvis: tests must never read the live pause file in data/ (a stopped host would make unrelated tests fail). Each test process gets its own.
process.env.JARVIS_PAUSE_FILE ||= path.join(os.tmpdir(), `jarvis-paused-test-${process.pid}`);
process.env.JARVIS_USAGE_SPOOL ||= path.join(os.tmpdir(), `jarvis-usage-spool-test-${process.pid}`);

import type { GatewayProviderDefinition } from './gateway-providers/gateway-provider-registry.js';

const gateway: GatewayProviderDefinition = {
  kind: 'test-gateway',
  agentSkills: [],
  sessions: {
    async ensure() {
      return { contribution: { networkAccess: { endpoint: 'localhost', target: { kind: 'host' } } } };
    },
  },
  approvals: {
    async subscribe(_decide, signal) {
      if (signal.aborted) return;
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    },
  },
};

beforeEach(async () => {
  await import('./mailbox/compose.js');
  (await import('./gateway-providers/index.js')).resetGatewayProvider(gateway);
});
