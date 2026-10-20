/**
 * Jarvis: the usage of a turn, taken from the Claude SDK's result message.
 *
 * The SDK's per-model totals (`modelUsage`) and `total_cost_usd` are RUNNING TOTALS for the session: each result carries the total so far
 * (a resumed session starts from its saved total, /clear resets it). This module does NOT difference them: it reports them as they are,
 * and the data server (which keeps a baseline per session) records each turn's share exactly once. Never sums across results.
 *
 * Nothing here can throw: a malformed or missing field becomes 0 / null, never a reason to fail the turn.
 */

export interface ReportedModelTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}

export interface ReportedUsage {
  /** Identifies the SDK query() call these running totals belong to. A new id means the totals started over, whatever their values. */
  queryId: string;
  /** Running totals per model for this session, as the SDK reports them. */
  models: Record<string, ReportedModelTotals>;
  totalCostUsd: number | null;
  /** This turn's main-loop tokens alone (the SDK's per-turn `usage`), used by the data server only if there are no per-model totals. */
  turn: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
}

const MAX_MODELS = 12;

/** A finite, non-negative number, else 0. */
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

interface SdkResultLike {
  modelUsage?: unknown;
  usage?: unknown;
  total_cost_usd?: unknown;
}

export function extractUsage(message: SdkResultLike, queryId: string): ReportedUsage {
  const models: Record<string, ReportedModelTotals> = {};
  const raw = message.modelUsage;
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const entries = Object.entries(raw as Record<string, unknown>)
      .filter(([model, u]) => model.length > 0 && model.length <= 120 && typeof u === 'object' && u !== null)
      .map(([model, u]) => {
        const x = u as Record<string, unknown>;
        return [
          model,
          {
            input: num(x.inputTokens),
            output: num(x.outputTokens),
            cacheRead: num(x.cacheReadInputTokens),
            cacheWrite: num(x.cacheCreationInputTokens),
            costUsd: num(x.costUSD),
          },
        ] as const;
      })
      // keep the biggest spenders if a session somehow used many models
      .sort((a, b) => b[1].costUsd - a[1].costUsd)
      .slice(0, MAX_MODELS);
    for (const [model, totals] of entries) models[model] = totals;
  }

  const u = message.usage;
  const turn =
    typeof u === 'object' && u !== null
      ? (() => {
          const x = u as Record<string, unknown>;
          return {
            input: num(x.input_tokens),
            output: num(x.output_tokens),
            cacheRead: num(x.cache_read_input_tokens),
            cacheWrite: num(x.cache_creation_input_tokens),
          };
        })()
      : null;

  const total = message.total_cost_usd;
  return { queryId, models, totalCostUsd: typeof total === 'number' && Number.isFinite(total) && total >= 0 ? total : null, turn };
}
