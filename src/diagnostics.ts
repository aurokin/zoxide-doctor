import {
  runProviderBenchmark,
  runProviderSelectionForTiming,
  type ProviderBenchmarkContext,
  type ProviderBenchmarkIteration,
  type ProviderBenchmarkResult,
} from "./benchmark.js";
import { buildCandidates, type Candidate } from "./candidates.js";
import type { LoadedConfig, ZdrConfig } from "./config.js";
import {
  defaultBenchmarkSuiteProviders,
  parseBenchmarkProviderArgs,
  parseBenchmarkSuiteArgs,
  parseDebugProviderTimingArgs,
  parseDebugTimingArgs,
} from "./cli-args.js";
import { readCorrectionCache, type CorrectionInspection } from "./corrections.js";
import { directQueryState } from "./direct-query.js";
import type { ProviderReasoning, SelectionResult } from "./provider/select.js";
import { buildSelectionCandidates, type NavigationDeps } from "./selection-context.js";
import { type FinishedZState, readLastZState, readRecoveryRetryForAttempt } from "./shell-state.js";
import type { ZoxideEntry } from "./zoxide.js";

export type DiagnosticsCommandResult = {
  code: number;
};

export type DiagnosticsDeps = NavigationDeps & {
  inspectCorrection: (query: string) => Promise<CorrectionInspection>;
  loadZoxideEntries: () => Promise<ZoxideEntry[]>;
  selectCandidate: (input: {
    state: FinishedZState;
    candidates: Candidate[];
    rejectedPaths?: string[];
    provider?: ZdrConfig["provider"];
    privacy?: ZdrConfig["privacy"];
    reasoning?: ProviderReasoning;
  }) => Promise<SelectionResult>;
  loadConfig: () => Promise<LoadedConfig>;
};

export async function debugTimingCommand(
  args: string[],
  deps: DiagnosticsDeps,
  version: string,
): Promise<DiagnosticsCommandResult> {
  const parsed = parseDebugTimingArgs(args);
  if (!parsed.ok) {
    console.error(`zdr: ${parsed.error}`);
    return { code: 2 };
  }
  const query = parsed.queryArgv.join(" ").trim();
  const commandStart = performance.now();
  const measurements: TimingMeasurement[] = [];

  measurements.push(
    await measureStep("version", async () => ({
      version,
    })),
  );
  measurements.push(
    await measureStep("debug-corrections", async () => {
      const cache = await readCorrectionCache();
      return {
        correction_count: Object.keys(cache).length,
      };
    }),
  );
  if (query.length > 0) {
    measurements.push(
      await measureStep("direct-query-cache-lookup", async () => {
        const lookup = await deps.inspectCorrection(query);
        return {
          query,
          status: lookup.status,
        };
      }),
    );
  } else {
    measurements.push({
      name: "direct-query-cache-lookup",
      ok: false,
      skipped: true,
      duration_ms: 0,
      error: "provide a query to measure direct-query cache lookup",
    });
  }
  measurements.push(await measureStep("recovery-context", () => measureRecoveryContext(deps)));
  const totalDurationMs = elapsedMs(commandStart);

  console.log(
    JSON.stringify(
      {
        schema_version: 1,
        command: "debug-timing",
        total_duration_ms: totalDurationMs,
        ...(parsed.budgetMs === undefined
          ? {}
          : {
              budget_ms: parsed.budgetMs,
              within_budget: totalDurationMs <= parsed.budgetMs,
            }),
        measurements,
      },
      null,
      2,
    ),
  );
  return { code: 0 };
}

export async function debugProviderTimingCommand(
  args: string[],
  deps: DiagnosticsDeps,
): Promise<DiagnosticsCommandResult> {
  const parsed = parseDebugProviderTimingArgs(args);
  if (!parsed.ok) {
    console.error(`zdr: ${parsed.error}`);
    return { code: 2 };
  }

  const commandStart = performance.now();
  const measurements: TimingMeasurement[] = [];
  let state: FinishedZState | null = null;
  let rejectedPaths: string[] = [];
  let candidates: Candidate[] = [];

  measurements.push(
    await measureStep("provider-context", async () => {
      const context = await buildProviderTimingContext(parsed.queryArgv, deps);
      state = context.state;
      rejectedPaths = context.rejectedPaths;
      candidates = context.candidates;
      return {
        query: state.query_argv.join(" "),
        mode: parsed.queryArgv.length > 0 ? "direct-query" : "recovery",
        zoxide_entry_count: context.entryCount,
        candidate_count: candidates.length,
        rejected_path_count: rejectedPaths.length,
      };
    }),
  );

  const selectionState = state;
  if (selectionState && candidates.length > 0) {
    measurements.push(
      await measureStep("provider-selection", async () => {
        const config = (await deps.loadConfig()).config;
        return runProviderSelectionForTiming({
          state: selectionState,
          candidates,
          rejectedPaths,
          provider: config.provider,
          privacy: config.privacy,
          selectCandidate: deps.selectCandidate,
        });
      }),
    );
  } else {
    measurements.push({
      name: "provider-selection",
      ok: false,
      skipped: true,
      duration_ms: 0,
      error: "provider context did not produce candidates",
    });
  }

  console.log(
    JSON.stringify(
      {
        schema_version: 1,
        command: "debug-provider-timing",
        total_duration_ms: elapsedMs(commandStart),
        measurements,
      },
      null,
      2,
    ),
  );
  return { code: 0 };
}

export async function benchmarkProviderCommand(
  args: string[],
  deps: DiagnosticsDeps,
): Promise<DiagnosticsCommandResult> {
  const parsed = parseBenchmarkProviderArgs(args);
  if (!parsed.ok) {
    console.error(`zdr: ${parsed.error}`);
    return { code: 2 };
  }

  const commandStart = performance.now();
  const contextStart = performance.now();
  let context: Awaited<ReturnType<typeof buildProviderTimingContext>>;
  try {
    context = await buildProviderTimingContext(parsed.queryArgv, deps);
  } catch (error) {
    console.error(`zdr: ${error instanceof Error ? error.message : String(error)}`);
    return { code: 1 };
  }
  const contextDurationMs = elapsedMs(contextStart);
  let config: ZdrConfig;
  try {
    config = (await deps.loadConfig()).config;
  } catch (error) {
    console.error(`zdr: ${error instanceof Error ? error.message : String(error)}`);
    return { code: 1 };
  }
  const provider = parsed.provider ?? config.provider;

  const commonPayload = {
    query: context.state.query_argv.join(" "),
    mode: parsed.queryArgv.length > 0 ? "direct-query" : "recovery",
    repeat: parsed.repeat,
    provider,
    context: providerBenchmarkContextPayload(context, contextDurationMs),
  };
  if (parsed.jsonl) {
    emitJsonLine({
      schema_version: 1,
      command: "benchmark-provider",
      event: "context",
      ...commonPayload,
    });
  }
  const benchmark = await runProviderBenchmark({
    context,
    provider,
    repeat: parsed.repeat,
    privacy: config.privacy,
    selectCandidate: deps.selectCandidate,
    ...(parsed.jsonl
      ? {
          onIteration: (iteration: ProviderBenchmarkIteration) =>
            emitJsonLine({
              schema_version: 1,
              command: "benchmark-provider",
              event: "iteration",
              provider,
              iteration,
            }),
        }
      : {}),
  });

  if (parsed.jsonl) {
    emitJsonLine({
      schema_version: 1,
      command: "benchmark-provider",
      event: "summary",
      provider,
      ok: benchmark.ok,
      total_duration_ms: elapsedMs(commandStart),
      summary: benchmark.summary,
    });
    return { code: benchmark.ok ? 0 : 1 };
  }

  console.log(
    JSON.stringify(
      {
        schema_version: 1,
        command: "benchmark-provider",
        ...commonPayload,
        total_duration_ms: elapsedMs(commandStart),
        ok: benchmark.ok,
        summary: benchmark.summary,
        iterations: benchmark.iterations,
      },
      null,
      2,
    ),
  );
  return { code: benchmark.ok ? 0 : 1 };
}

export async function benchmarkSuiteCommand(
  args: string[],
  deps: DiagnosticsDeps,
): Promise<DiagnosticsCommandResult> {
  const parsed = parseBenchmarkSuiteArgs(args);
  if (!parsed.ok) {
    console.error(`zdr: ${parsed.error}`);
    return { code: 2 };
  }

  const commandStart = performance.now();
  const contextStart = performance.now();
  let context: Awaited<ReturnType<typeof buildProviderTimingContext>>;
  try {
    context = await buildProviderTimingContext(parsed.queryArgv, deps);
  } catch (error) {
    console.error(`zdr: ${error instanceof Error ? error.message : String(error)}`);
    return { code: 1 };
  }
  const contextDurationMs = elapsedMs(contextStart);
  let config: ZdrConfig;
  try {
    config = (await deps.loadConfig()).config;
  } catch (error) {
    console.error(`zdr: ${error instanceof Error ? error.message : String(error)}`);
    return { code: 1 };
  }

  const providers = parsed.providers.length > 0 ? parsed.providers : defaultBenchmarkSuiteProviders(config.provider);
  const commonPayload = {
    query: context.state.query_argv.join(" "),
    mode: parsed.queryArgv.length > 0 ? "direct-query" : "recovery",
    repeat: parsed.repeat,
    providers,
    context: providerBenchmarkContextPayload(context, contextDurationMs),
  };
  if (parsed.jsonl) {
    emitJsonLine({
      schema_version: 1,
      command: "benchmark-suite",
      event: "context",
      ...commonPayload,
    });
  }
  const benchmarks: ProviderBenchmarkResult[] = [];
  for (const provider of providers) {
    const benchmark = await runProviderBenchmark({
      context,
      provider,
      repeat: parsed.repeat,
      privacy: config.privacy,
      selectCandidate: deps.selectCandidate,
      ...(parsed.jsonl
        ? {
            onIteration: (iteration: ProviderBenchmarkIteration) =>
              emitJsonLine({
                schema_version: 1,
                command: "benchmark-suite",
                event: "iteration",
                provider,
                iteration,
              }),
          }
        : {}),
    });
    benchmarks.push(benchmark);
    if (parsed.jsonl) {
      emitJsonLine({
        schema_version: 1,
        command: "benchmark-suite",
        event: "provider-summary",
        provider,
        ok: benchmark.ok,
        total_duration_ms: benchmark.total_duration_ms,
        summary: benchmark.summary,
      });
    }
  }

  const ok = benchmarks.every((benchmark) => benchmark.ok);
  if (parsed.jsonl) {
    emitJsonLine({
      schema_version: 1,
      command: "benchmark-suite",
      event: "summary",
      ok,
      total_duration_ms: elapsedMs(commandStart),
      benchmarks: benchmarks.map((benchmark) => ({
        provider: benchmark.provider,
        ok: benchmark.ok,
        total_duration_ms: benchmark.total_duration_ms,
        summary: benchmark.summary,
      })),
    });
    return { code: ok ? 0 : 1 };
  }

  console.log(
    JSON.stringify(
      {
        schema_version: 1,
        command: "benchmark-suite",
        ...commonPayload,
        ok,
        total_duration_ms: elapsedMs(commandStart),
        benchmarks,
      },
      null,
      2,
    ),
  );
  return { code: ok ? 0 : 1 };
}

function providerBenchmarkContextPayload(
  context: ProviderBenchmarkContext,
  durationMs: number,
): Record<string, unknown> {
  return {
    duration_ms: durationMs,
    zoxide_entry_count: context.entryCount,
    candidate_count: context.candidates.length,
    rejected_path_count: context.rejectedPaths.length,
  };
}

function emitJsonLine(payload: Record<string, unknown>): void {
  console.log(JSON.stringify(payload));
}

async function buildProviderTimingContext(
  queryArgv: string[],
  deps: DiagnosticsDeps,
): Promise<ProviderBenchmarkContext> {
  const query = queryArgv.join(" ").trim();
  const state = query.length > 0 ? directQueryState(queryArgv, deps) : await requireRecordedZState();
  const retry = query.length > 0 ? null : await readRecoveryRetryForAttempt(state);
  const rejectedPaths = retry?.rejected_paths ?? [];
  const entries = await deps.loadZoxideEntries();
  const candidates = await buildSelectionCandidates({
    state,
    entries,
    limit: 50,
    rejectedPaths,
    deps,
  });
  if (candidates.length === 0) {
    throw new Error("no zoxide candidates found");
  }
  return { state, rejectedPaths, candidates, entryCount: entries.length };
}

async function requireRecordedZState(): Promise<FinishedZState> {
  const state = await readLastZState();
  if (!state) {
    throw new Error("no recorded z attempt found");
  }
  return state;
}

type TimingMeasurement = {
  name: string;
  ok: boolean;
  skipped?: boolean;
  duration_ms: number;
  metadata?: Record<string, unknown>;
  error?: string;
};

async function measureStep(
  name: string,
  fn: () => Promise<Record<string, unknown>> | Record<string, unknown>,
): Promise<TimingMeasurement> {
  const start = performance.now();
  try {
    const metadata = await fn();
    return {
      name,
      ok: true,
      duration_ms: elapsedMs(start),
      metadata,
    };
  } catch (error) {
    return {
      name,
      ok: false,
      duration_ms: elapsedMs(start),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function measureRecoveryContext(deps: DiagnosticsDeps): Promise<Record<string, unknown>> {
  const state = await readLastZState();
  if (!state) {
    throw new Error("no recorded z attempt found");
  }
  const entries = await deps.loadZoxideEntries();
  const retry = await readRecoveryRetryForAttempt(state);
  const candidates = buildCandidates({
    state,
    entries,
    limit: 50,
    rejectedPaths: retry?.rejected_paths ?? [],
  });
  return {
    query: state.query_argv.join(" "),
    zoxide_entry_count: entries.length,
    candidate_count: candidates.length,
    rejected_path_count: retry?.rejected_paths.length ?? 0,
  };
}

function elapsedMs(start: number): number {
  return Math.max(0, Math.round((performance.now() - start) * 1000) / 1000);
}
