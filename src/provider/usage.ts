export type ProviderUsageSummary = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  total_tokens?: number;
  cost_input?: number;
  cost_output?: number;
  cost_cache_read?: number;
  cost_cache_write?: number;
  cost_total?: number;
};

export function summarizeProviderUsage(usage: unknown): ProviderUsageSummary | null {
  if (!isRecord(usage)) {
    return null;
  }

  const cost = isRecord(usage.cost) ? usage.cost : {};
  const summary: ProviderUsageSummary = {
    ...numberField(usage.input, "input_tokens"),
    ...numberField(usage.output, "output_tokens"),
    ...numberField(usage.cacheRead, "cache_read_tokens"),
    ...numberField(usage.cacheWrite, "cache_write_tokens"),
    ...numberField(usage.totalTokens, "total_tokens"),
    ...numberField(cost.input, "cost_input"),
    ...numberField(cost.output, "cost_output"),
    ...numberField(cost.cacheRead, "cost_cache_read"),
    ...numberField(cost.cacheWrite, "cost_cache_write"),
    ...numberField(cost.total, "cost_total"),
  };

  return Object.keys(summary).length === 0 ? null : summary;
}

function numberField<K extends keyof ProviderUsageSummary>(value: unknown, key: K): Pick<ProviderUsageSummary, K> | {} {
  return typeof value === "number" && Number.isFinite(value) ? { [key]: value } as Pick<ProviderUsageSummary, K> : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
