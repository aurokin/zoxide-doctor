import type { Candidate } from "./candidates.js";
import type { ZdrConfig } from "./config.js";
import type { SelectionResult } from "./provider/select.js";
import { summarizeProviderUsage } from "./provider/usage.js";
import type { FinishedZState } from "./shell-state.js";

export type ProviderBenchmarkContext = {
  state: FinishedZState;
  rejectedPaths: string[];
  candidates: Candidate[];
  entryCount: number;
};

export type BenchmarkSelectCandidate = (input: {
  state: FinishedZState;
  candidates: Candidate[];
  rejectedPaths?: string[];
  provider?: ZdrConfig["provider"];
  privacy?: ZdrConfig["privacy"];
}) => Promise<SelectionResult>;

export type ProviderBenchmarkResult = {
  provider: ZdrConfig["provider"];
  ok: boolean;
  total_duration_ms: number;
  summary: Record<string, unknown>;
  iterations: ProviderBenchmarkIteration[];
};

export type ProviderBenchmarkIteration = {
  index: number;
  ok: boolean;
  duration_ms: number;
  metadata?: Record<string, unknown>;
  error?: string;
};

export async function runProviderSelectionForTiming(input: {
  state: FinishedZState;
  candidates: Candidate[];
  rejectedPaths: string[];
  provider: ZdrConfig["provider"];
  privacy: ZdrConfig["privacy"];
  selectCandidate: BenchmarkSelectCandidate;
}): Promise<Record<string, unknown>> {
  const result = await input.selectCandidate({
    state: input.state,
    candidates: input.candidates,
    rejectedPaths: input.rejectedPaths,
    provider: input.provider,
    privacy: input.privacy,
  });
  const providerUsage = summarizeProviderUsage(result.usage);
  return {
    selected_candidate_id: result.selection.candidate_id,
    selected_path: result.candidate?.path ?? null,
    confidence: result.selection.confidence,
    reason: result.selection.reason,
    ...(result.timings === undefined ? {} : { provider_timings: result.timings }),
    ...(result.usage === null || result.usage === undefined ? {} : { usage: result.usage }),
    ...(providerUsage === null ? {} : { provider_usage: providerUsage }),
  };
}

export async function runProviderBenchmark(input: {
  context: ProviderBenchmarkContext;
  provider: ZdrConfig["provider"];
  repeat: number;
  privacy: ZdrConfig["privacy"];
  selectCandidate: BenchmarkSelectCandidate;
  onIteration?: (iteration: ProviderBenchmarkIteration) => void;
  now?: () => number;
}): Promise<ProviderBenchmarkResult> {
  const now = input.now ?? (() => performance.now());
  const start = now();
  const iterations: ProviderBenchmarkIteration[] = [];
  for (let index = 0; index < input.repeat; index += 1) {
    const iterationStart = now();
    try {
      const metadata = await runProviderSelectionForTiming({
        state: input.context.state,
        candidates: input.context.candidates,
        rejectedPaths: input.context.rejectedPaths,
        provider: input.provider,
        privacy: input.privacy,
        selectCandidate: input.selectCandidate,
      });
      const iteration = {
        index: index + 1,
        ok: true,
        duration_ms: elapsedMs(iterationStart, now),
        metadata,
      };
      iterations.push(iteration);
      input.onIteration?.(iteration);
    } catch (error) {
      const iteration = {
        index: index + 1,
        ok: false,
        duration_ms: elapsedMs(iterationStart, now),
        error: error instanceof Error ? error.message : String(error),
      };
      iterations.push(iteration);
      input.onIteration?.(iteration);
    }
  }

  return {
    provider: input.provider,
    ok: iterations.every((iteration) => iteration.ok),
    total_duration_ms: elapsedMs(start, now),
    summary: summarizeProviderBenchmark(iterations),
    iterations,
  };
}

export function summarizeProviderBenchmark(iterations: ProviderBenchmarkIteration[]): Record<string, unknown> {
  const successful = iterations.filter((iteration) => iteration.ok);
  const selectedPaths = new Map<string, number>();
  const providerCompleteDurations: number[] = [];
  let totalTokens = 0;
  let totalCost = 0;
  let usageCount = 0;

  for (const iteration of successful) {
    const metadata = iteration.metadata ?? {};
    const selectedPath = typeof metadata.selected_path === "string" ? metadata.selected_path : null;
    if (selectedPath) {
      selectedPaths.set(selectedPath, (selectedPaths.get(selectedPath) ?? 0) + 1);
    }
    const providerTimings = metadata.provider_timings;
    if (isRecord(providerTimings) && typeof providerTimings.provider_complete_ms === "number") {
      providerCompleteDurations.push(providerTimings.provider_complete_ms);
    }
    const providerUsage = metadata.provider_usage;
    if (isRecord(providerUsage)) {
      if (typeof providerUsage.total_tokens === "number") {
        totalTokens += providerUsage.total_tokens;
      }
      if (typeof providerUsage.cost_total === "number") {
        totalCost += providerUsage.cost_total;
      }
      usageCount += 1;
    }
  }

  return {
    iteration_count: iterations.length,
    success_count: successful.length,
    failure_count: iterations.length - successful.length,
    selection_duration_ms: summarizeDurations(successful.map((iteration) => iteration.duration_ms)),
    ...(providerCompleteDurations.length === 0
      ? {}
      : { provider_complete_ms: summarizeDurations(providerCompleteDurations) }),
    selected_paths: Object.fromEntries([...selectedPaths.entries()].sort((left, right) => right[1] - left[1])),
    ...(usageCount === 0
      ? {}
      : {
          usage: {
            total_tokens: totalTokens,
            average_tokens: roundMs(totalTokens / usageCount),
            cost_total: totalCost,
            average_cost: totalCost / usageCount,
          },
        }),
  };
}

function summarizeDurations(values: number[]): Record<string, number> | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    min: roundMs(sorted[0] ?? 0),
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: roundMs(sorted.at(-1) ?? 0),
    average: roundMs(total / sorted.length),
  };
}

function percentile(sortedValues: number[], percentileValue: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const index = Math.ceil(sortedValues.length * percentileValue) - 1;
  return roundMs(sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))] ?? 0);
}

function elapsedMs(start: number, now: () => number): number {
  return Math.max(0, Math.round((now() - start) * 1000) / 1000);
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
