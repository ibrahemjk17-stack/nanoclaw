/**
 * Jarvis patch #7: each turn's usage is reported to the host as the SDK's RUNNING TOTALS (never summed or differenced here), through a
 * `system` outbound message with action `usage`, without touching the chat reply or the turn's outcome.
 */
import { afterEach, beforeEach, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getUndeliveredMessages } from '../db/messages-out.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { processQuery } from '../poll-loop.js';
import { reportUsage } from '../usage-report.js';
import { extractUsage } from './usage.js';

const sdkMessages: unknown[] = [];
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () =>
    (async function* () {
      for (const message of sdkMessages) yield message;
    })(),
}));

await import('./index.js');
await import('../provider-contracts/index.js');
const { createProvider } = await import('./factory.js');
const { claudeRuntimeContract } = await import('../provider-contracts/claude.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

let tmp: string;
let previousHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-usage-'));
  previousHome = process.env.HOME;
  process.env.HOME = tmp;
  sdkMessages.length = 0;
  initTestSessionDb();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('main', 'main', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const modelUsage = (input: number, output: number, cost: number, cacheRead = 0, cacheWrite = 0) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadInputTokens: cacheRead,
  cacheCreationInputTokens: cacheWrite,
  webSearchRequests: 0,
  costUSD: cost,
  contextWindow: 200000,
  maxOutputTokens: 8192,
});

async function runTurn() {
  const provider = createProvider('claude');
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const query = provider.query({ prompt: 'hi', cwd: tmp });
  query.push = () => undefined;
  await processQuery(
    query,
    { platformId: 'chan-1', channelType: 'discord', threadId: null, inReplyTo: 'm1' },
    ['m1'],
    'claude',
    () => undefined,
    'hi',
    undefined,
    claudeRuntimeContract.textDelivery === 'mid-turn-complete',
  );
  const rows = getUndeliveredMessages();
  return {
    chat: rows.filter((r) => r.kind !== 'system'),
    usage: rows.filter((r) => r.kind === 'system' && JSON.parse(r.content).action === 'usage').map((r) => JSON.parse(r.content).usage),
  };
}

it('extractUsage reports per-model running totals, the total cost and the turn\'s own tokens, as given', () => {
  const u = extractUsage({
    modelUsage: { 'claude-sonnet-5-5': modelUsage(1200, 300, 0.021, 5000, 800), 'claude-haiku-5-5': modelUsage(40, 5, 0.0004) },
    usage: { input_tokens: 900, output_tokens: 250, cache_read_input_tokens: 4000, cache_creation_input_tokens: 100 },
    total_cost_usd: 0.0214,
  });
  expect(u.models['claude-sonnet-5-5']).toEqual({ input: 1200, output: 300, cacheRead: 5000, cacheWrite: 800, costUsd: 0.021 });
  expect(u.models['claude-haiku-5-5']).toEqual({ input: 40, output: 5, cacheRead: 0, cacheWrite: 0, costUsd: 0.0004 });
  expect(u.totalCostUsd).toBe(0.0214);
  expect(u.turn).toEqual({ input: 900, output: 250, cacheRead: 4000, cacheWrite: 100 });
});

it('extractUsage never throws and never invents: missing, malformed or hostile fields become 0 or null', () => {
  expect(extractUsage({})).toEqual({ models: {}, totalCostUsd: null, turn: null });
  expect(extractUsage({ modelUsage: 'nope', usage: 7, total_cost_usd: 'x' })).toEqual({ models: {}, totalCostUsd: null, turn: null });
  expect(extractUsage({ modelUsage: [1, 2], usage: null })).toEqual({ models: {}, totalCostUsd: null, turn: null });
  const bad = extractUsage({
    modelUsage: { m: { inputTokens: -5, outputTokens: Number.NaN, cacheReadInputTokens: '9', costUSD: Number.POSITIVE_INFINITY }, '': modelUsage(1, 1, 1), n: null },
    total_cost_usd: -1,
  });
  expect(bad.models).toEqual({ m: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 } });
  expect(bad.totalCostUsd).toBeNull();
});

it('extractUsage keeps the 12 biggest spenders if a session used many models', () => {
  const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`m${i}`, modelUsage(1, 1, i)]));
  const u = extractUsage({ modelUsage: many });
  expect(Object.keys(u.models)).toHaveLength(12);
  expect(u.models.m19).toBeDefined();
  expect(u.models.m0).toBeUndefined();
});

it('a successful turn writes exactly one usage report with the totals, and the chat reply is untouched', async () => {
  sdkMessages.push({ type: 'system', subtype: 'init', session_id: 's-usage' });
  sdkMessages.push({ type: 'assistant', message: { content: [{ type: 'text', text: '<message to="main">Done.</message>' }] } });
  sdkMessages.push({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '<message to="main">Done.</message>',
    modelUsage: { 'claude-haiku-5-5': modelUsage(2000, 150, 0.0031, 12000, 900) },
    usage: { input_tokens: 2000, output_tokens: 150, cache_read_input_tokens: 12000, cache_creation_input_tokens: 900 },
    total_cost_usd: 0.0031,
  });
  const { chat, usage } = await runTurn();
  expect(chat.map((r) => JSON.parse(r.content).text)).toEqual(['Done.']);
  expect(usage).toHaveLength(1);
  expect(usage[0].models['claude-haiku-5-5']).toEqual({ input: 2000, output: 150, cacheRead: 12000, cacheWrite: 900, costUsd: 0.0031 });
  expect(usage[0].totalCostUsd).toBe(0.0031);
});

it('two results in one query give two reports, each carrying its own running total (the runner never sums or differences)', async () => {
  sdkMessages.push({ type: 'system', subtype: 'init', session_id: 's-two' });
  sdkMessages.push({ type: 'result', subtype: 'success', is_error: false, result: 'a', modelUsage: { m: modelUsage(100, 10, 0.01) }, total_cost_usd: 0.01 });
  sdkMessages.push({ type: 'result', subtype: 'success', is_error: false, result: 'b', modelUsage: { m: modelUsage(250, 30, 0.025) }, total_cost_usd: 0.025 });
  const { usage } = await runTurn();
  expect(usage.map((u) => u.models.m.input)).toEqual([100, 250]);
  expect(usage.map((u) => u.totalCostUsd)).toEqual([0.01, 0.025]);
});

it('a failed turn still reports what it used', async () => {
  sdkMessages.push({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    errors: ['boom'],
    modelUsage: { m: modelUsage(500, 0, 0.004) },
  });
  const { usage } = await runTurn();
  expect(usage).toHaveLength(1);
  expect(usage[0].models.m.costUsd).toBe(0.004);
});

it('a result with no usage fields at all still produces a (empty) report, so the host sees that a turn happened', async () => {
  sdkMessages.push({ type: 'result', subtype: 'success', is_error: false, result: 'x' });
  const { usage } = await runTurn();
  expect(usage).toEqual([{ models: {}, totalCostUsd: null, turn: null }]);
});

it('reportUsage writes a system message with the action, and never throws when writing fails', async () => {
  const written: unknown[] = [];
  const logs: string[] = [];
  const u = extractUsage({ modelUsage: { m: modelUsage(1, 1, 0.001) } });
  expect(await reportUsage(u, async (m) => void written.push(m), (l) => logs.push(l))).toBe(true);
  const msg = written[0] as { id: string; kind: string; content: string };
  expect(msg.kind).toBe('system');
  expect(msg.id).toMatch(/^usage-/);
  expect(JSON.parse(msg.content)).toEqual({ action: 'usage', usage: u });
  expect(
    await reportUsage(u, async () => {
      throw new Error('disk full');
    }, (l) => logs.push(l)),
  ).toBe(false);
  expect(logs.join('\n')).toMatch(/Usage report not written: disk full/);
});
