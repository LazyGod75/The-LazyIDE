/* Summarize usage_events rows for the Account credits block. */

export interface UsageSummary {
  count: number;
  totalChargedUsd: number;
  totalTokens: number;
}

export interface UsageEventRow {
  cost_charged_usd: number | string | null;
  input_tokens: number | null;
  output_tokens: number | null;
}

export const EMPTY_USAGE: UsageSummary = {
  count: 0,
  totalChargedUsd: 0,
  totalTokens: 0,
};

export function summarizeUsageRows(rows: UsageEventRow[]): UsageSummary {
  return rows.reduce<UsageSummary>(
    (acc, r) => ({
      count: acc.count + 1,
      totalChargedUsd: acc.totalChargedUsd + Number(r.cost_charged_usd ?? 0),
      totalTokens: acc.totalTokens + (r.input_tokens ?? 0) + (r.output_tokens ?? 0),
    }),
    EMPTY_USAGE,
  );
}
