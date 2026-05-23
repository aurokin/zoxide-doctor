#!/usr/bin/env bun

import packageJson from "../package.json" with { type: "json" };
import { dirname, parse } from "node:path";
import {
  runProviderBenchmark,
  runProviderSelectionForTiming,
  type ProviderBenchmarkContext,
  type ProviderBenchmarkIteration,
  type ProviderBenchmarkResult,
} from "./benchmark.js";
import { buildCandidates, shouldAddLocalScanCandidates, type Candidate } from "./candidates.js";
import { getConfigPaths, loadConfig, setProviderConfig, type LoadedConfig, type ZdrConfig } from "./config.js";
import {
  defaultBenchmarkSuiteProviders,
  parseBenchmarkProviderArgs,
  parseBenchmarkSuiteArgs,
  parseDebugEventsArgs,
  parseDebugProviderTimingArgs,
  parseDebugTimingArgs,
  parseFinishZArgs,
  parseLimit,
  parsePruneEventsArgs,
  parseRecordZArgs,
} from "./cli-args.js";
import {
  forgetCorrection,
  inspectCorrection,
  lookupCorrection,
  readCorrectionCache,
  storeCorrection,
  type CorrectionEntry,
  type CorrectionInspection,
  type CorrectionLookup,
} from "./corrections.js";
import {
  clearRecoveryRetry,
  type FinishedZState,
  finishZAttempt,
  readLastZState,
  readRecoveryRetryForAttempt,
  recordZAttempt,
  writeRecoveryRetry,
} from "./shell-state.js";
import { loadZoxideEntries, type ZoxideEntry } from "./zoxide.js";
import type { PickerInput, PickerResult } from "./picker.js";
import type { OAuthLoginCallbacks, ProviderAuthStatus } from "./provider/auth.js";
import {
  configProviderCommand,
  doctorCommand,
  providerAuthStatusCommand,
  providerListCommand,
  providerLoginCommand,
  providerLogoutCommand,
  providerSmokeCommand,
} from "./provider/commands.js";
import type { ProviderReasoning, SelectionResult } from "./provider/select.js";
import { summarizeProviderUsage } from "./provider/usage.js";
import { scanLocalDirectories } from "./local-scan.js";
import { bashInitScript, fishInitScript, zshInitScript } from "./shell-init.js";
import {
  appendTelemetryEvent,
  pruneTelemetryEvents,
  readTelemetryEvents,
  telemetryEnabled,
  type TelemetryEvent,
  type TelemetryInput,
  type TelemetryPruneResult,
} from "./telemetry.js";

type CommandResult = {
  code: number;
};

type SelectCandidate = (input: {
  state: FinishedZState;
  candidates: Candidate[];
  rejectedPaths?: string[];
  provider?: ZdrConfig["provider"];
  privacy?: ZdrConfig["privacy"];
  reasoning?: ProviderReasoning;
}) => Promise<SelectionResult>;

type CliDeps = {
  lookupCorrection: (query: string) => Promise<CorrectionLookup>;
  inspectCorrection: (query: string) => Promise<CorrectionInspection>;
  storeCorrection: (input: { query: string; path: string; now?: Date }) => Promise<CorrectionEntry>;
  loadZoxideEntries: () => Promise<ZoxideEntry[]>;
  scanLocalDirectories: (input: { query: string; roots: string[]; maxResults?: number }) => Promise<string[]>;
  selectCandidate: SelectCandidate;
  runPicker: (input: PickerInput) => Promise<PickerResult>;
  appendTelemetryEvent: (input: TelemetryInput) => Promise<unknown>;
  readTelemetryEvents: (input?: { limit?: number }) => Promise<TelemetryEvent[]>;
  pruneTelemetryEvents: (input: { maxEvents: number }) => Promise<TelemetryPruneResult>;
  loadConfig: () => Promise<LoadedConfig>;
  setProviderConfig: (provider: ZdrConfig["provider"]) => Promise<LoadedConfig>;
  providerLogin: (provider: string, callbacks: OAuthLoginCallbacks) => Promise<void>;
  providerLogout: (provider: string) => Promise<boolean>;
  providerAuthStatuses: (providers?: string[]) => Promise<ProviderAuthStatus[]>;
  commandExists: (command: string) => boolean;
  cwd: () => string;
  now: () => Date;
};

const DIRECT_QUERY_CACHE_CONFIDENCE = 0.75;
const VERSION = packageJson.version;

export async function main(argv: string[], deps: CliDeps = defaultDeps): Promise<CommandResult> {
  const [command, ...args] = argv;

  if (command === "--help" || command === "-h") {
    printHelp();
    return { code: 0 };
  }

  if (!command) {
    return recoverCommand(deps);
  }

  if (command === "--version" || command === "-V") {
    console.log(VERSION);
    return { code: 0 };
  }

  switch (command) {
    case "init":
      return initCommand(args);
    case "record-z":
      return recordZCommand(args);
    case "finish-z":
      return finishZCommand(args);
    case "clear-recovery-retry":
      return clearRecoveryRetryCommand();
    case "debug-state":
      return debugStateCommand();
    case "debug-candidates":
      return debugCandidatesCommand(args);
    case "debug-select":
      return debugSelectCommand(args, deps);
    case "debug-corrections":
      return debugCorrectionsCommand();
    case "debug-config":
      return debugConfigCommand(deps);
    case "debug-events":
      return debugEventsCommand(args, deps);
    case "debug-timing":
      return debugTimingCommand(args, deps);
    case "debug-provider-timing":
      return debugProviderTimingCommand(args, deps);
    case "benchmark-provider":
      return benchmarkProviderCommand(args, deps);
    case "benchmark-suite":
      return benchmarkSuiteCommand(args, deps);
    case "doctor":
      return doctorCommand(args, deps);
    case "config-provider":
      return configProviderCommand(args, deps);
    case "prune-events":
      return pruneEventsCommand(args, deps);
    case "forget":
      return forgetCommand(args);
    case "provider-smoke":
      return providerSmokeCommand(args, deps);
    case "provider-list":
      return providerListCommand(args);
    case "provider-login":
      return providerLoginCommand(args, deps);
    case "provider-logout":
      return providerLogoutCommand(args, deps);
    case "provider-auth-status":
      return providerAuthStatusCommand(args, deps);
    default:
      if (command.startsWith("-")) {
        console.error(`zdr: unknown option: ${command}`);
        return { code: 2 };
      }
      return directQueryCommand([command, ...args], deps);
  }
}

const defaultDeps: CliDeps = {
  lookupCorrection,
  inspectCorrection,
  storeCorrection,
  loadZoxideEntries,
  scanLocalDirectories,
  selectCandidate: async (input) => {
    const { selectCandidate } = await import("./provider/select.js");
    return selectCandidate(input);
  },
  runPicker: async (input) => {
    const { runPicker } = await import("./picker.js");
    return runPicker(input);
  },
  appendTelemetryEvent,
  readTelemetryEvents,
  pruneTelemetryEvents,
  loadConfig,
  setProviderConfig,
  providerLogin: async (provider, callbacks) => {
    const { loginProvider } = await import("./provider/auth.js");
    return loginProvider(provider, callbacks);
  },
  providerLogout: async (provider) => {
    const { logoutProvider } = await import("./provider/auth.js");
    return logoutProvider(provider);
  },
  providerAuthStatuses: async (providers) => {
    const { getProviderAuthStatuses } = await import("./provider/auth.js");
    return getProviderAuthStatuses(providers);
  },
  commandExists,
  cwd: () => process.cwd(),
  now: () => new Date(),
};

function initCommand(args: string[]): CommandResult {
  const [shell] = args;
  switch (shell) {
    case "zsh":
      console.log(zshInitScript());
      return { code: 0 };
    case "bash":
      console.log(bashInitScript());
      return { code: 0 };
    case "fish":
      console.log(fishInitScript());
      return { code: 0 };
    default:
      console.error("zdr: supported shells: zsh, bash, fish");
      return { code: 2 };
  }
}

async function recordZCommand(args: string[]): Promise<CommandResult> {
  const parsed = parseRecordZArgs(args);
  if (!parsed.ok) {
    console.error(`zdr: ${parsed.error}`);
    return { code: 2 };
  }

  await clearRecoveryRetry();
  await recordZAttempt({
    attemptId: parsed.attemptId,
    beforePwd: parsed.beforePwd,
    queryArgv: parsed.queryArgv,
    ...(parsed.shell ? { shell: parsed.shell } : {}),
  });
  return { code: 0 };
}

async function clearRecoveryRetryCommand(): Promise<CommandResult> {
  await clearRecoveryRetry();
  return { code: 0 };
}

async function finishZCommand(args: string[]): Promise<CommandResult> {
  const parsed = parseFinishZArgs(args);
  if (!parsed.ok) {
    console.error(`zdr: ${parsed.error}`);
    return { code: 2 };
  }

  try {
    await finishZAttempt({
      attemptId: parsed.attemptId,
      afterPwd: parsed.afterPwd,
      exitStatus: parsed.exitStatus,
    });
    return { code: 0 };
  } catch (error) {
    console.error(`zdr: ${error instanceof Error ? error.message : String(error)}`);
    return { code: 1 };
  }
}

async function debugStateCommand(): Promise<CommandResult> {
  const state = await readLastZState();
  if (!state) {
    console.error("zdr: no recorded z attempt found");
    return { code: 1 };
  }
  console.log(JSON.stringify(state, null, 2));
  return { code: 0 };
}

async function debugCandidatesCommand(args: string[]): Promise<CommandResult> {
  const limit = parseLimit(args);
  if (!limit.ok) {
    console.error(`zdr: ${limit.error}`);
    return { code: 2 };
  }

  const state = await readLastZState();
  if (!state) {
    console.error("zdr: no recorded z attempt found");
    return { code: 1 };
  }

  try {
    const entries = await loadZoxideEntries();
    const candidates = buildCandidates({
      state,
      entries,
      limit: limit.value,
    });
    console.log(
      JSON.stringify(
        {
          query: state.query_argv.join(" "),
          before_pwd: state.before_pwd,
          after_pwd: state.after_pwd,
          candidate_count: candidates.length,
          candidates,
        },
        null,
        2,
      ),
    );
    return { code: 0 };
  } catch (error) {
    console.error(`zdr: ${error instanceof Error ? error.message : String(error)}`);
    return { code: 1 };
  }
}

async function debugSelectCommand(args: string[], deps: CliDeps): Promise<CommandResult> {
  const limit = parseLimit(args);
  if (!limit.ok) {
    console.error(`zdr: ${limit.error}`);
    return { code: 2 };
  }

  try {
    const { state, result, rejectedPaths } = await runDebugSelection(limit.value, deps);
    console.log(
      JSON.stringify(
        {
          query: state.query_argv.join(" "),
          rejected_paths: rejectedPaths,
          selected_candidate_id: result.selection.candidate_id,
          confidence: result.selection.confidence,
          reason: result.selection.reason,
          candidate: result.candidate,
          usage: result.usage,
          raw_text: result.raw_text,
        },
        null,
        2,
      ),
    );
    return { code: 0 };
  } catch (error) {
    console.error(`zdr: ${error instanceof Error ? error.message : String(error)}`);
    return { code: 1 };
  }
}

async function debugCorrectionsCommand(): Promise<CommandResult> {
  try {
    console.log(JSON.stringify(await readCorrectionCache(), null, 2));
    return { code: 0 };
  } catch (error) {
    console.error(`zdr: ${error instanceof Error ? error.message : String(error)}`);
    return { code: 1 };
  }
}

async function debugConfigCommand(deps: CliDeps): Promise<CommandResult> {
  try {
    console.log(JSON.stringify(await deps.loadConfig(), null, 2));
    return { code: 0 };
  } catch (error) {
    console.error(`zdr: ${error instanceof Error ? error.message : String(error)}`);
    return { code: 1 };
  }
}

async function debugEventsCommand(args: string[], deps: CliDeps): Promise<CommandResult> {
  const parsed = parseDebugEventsArgs(args);
  if (!parsed.ok) {
    console.error(`zdr: ${parsed.error}`);
    return { code: 2 };
  }

  try {
    const options = parsed.limit === undefined ? {} : { limit: parsed.limit };
    console.log(JSON.stringify(await deps.readTelemetryEvents(options), null, 2));
    return { code: 0 };
  } catch (error) {
    console.error(`zdr: ${error instanceof Error ? error.message : String(error)}`);
    return { code: 1 };
  }
}

async function pruneEventsCommand(args: string[], deps: CliDeps): Promise<CommandResult> {
  const parsed = parsePruneEventsArgs(args);
  if (!parsed.ok) {
    console.error(`zdr: ${parsed.error}`);
    return { code: 2 };
  }

  try {
    const maxEvents = parsed.maxEvents ?? (await deps.loadConfig()).config.telemetry.max_events;
    console.log(JSON.stringify(await deps.pruneTelemetryEvents({ maxEvents }), null, 2));
    return { code: 0 };
  } catch (error) {
    console.error(`zdr: ${error instanceof Error ? error.message : String(error)}`);
    return { code: 1 };
  }
}

async function forgetCommand(args: string[]): Promise<CommandResult> {
  const query = args.join(" ").trim();
  if (query.length === 0) {
    console.error("zdr: forget requires a query");
    return { code: 2 };
  }

  try {
    if (await forgetCorrection(query)) {
      console.error(`zdr: forgot correction for ${JSON.stringify(query)}`);
      return { code: 0 };
    }
    console.error(`zdr: no cached correction for ${JSON.stringify(query)}`);
    return { code: 1 };
  } catch (error) {
    console.error(`zdr: ${error instanceof Error ? error.message : String(error)}`);
    return { code: 1 };
  }
}

async function debugTimingCommand(args: string[], deps: CliDeps): Promise<CommandResult> {
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
      version: VERSION,
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

async function debugProviderTimingCommand(args: string[], deps: CliDeps): Promise<CommandResult> {
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

async function benchmarkProviderCommand(args: string[], deps: CliDeps): Promise<CommandResult> {
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

async function benchmarkSuiteCommand(args: string[], deps: CliDeps): Promise<CommandResult> {
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
  deps: CliDeps,
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

async function measureRecoveryContext(deps: CliDeps): Promise<Record<string, unknown>> {
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

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

async function recoverCommand(deps: CliDeps): Promise<CommandResult> {
  const start = performance.now();
  let state: FinishedZState | null = null;
  let mode: RecoveryMode | null = null;
  let retry: Awaited<ReturnType<typeof readRecoveryRetryForAttempt>> = null;
  try {
    state = await readLastZState();
    if (!state) {
      throw new Error("no recorded z attempt found");
    }
    retry = await readRecoveryRetryForAttempt(state);
    mode = chooseRecoveryMode(retry);
    if (mode === "picker") {
      if (!retry) {
        throw new Error("no recovery retry state found");
      }
      return pickerRecoveryCommand(state, retry, deps, start);
    }
    const { result, candidates } = await runSelection(state, retry, 50, deps, { announceRetry: mode === "retry-model" });
    if (!result.candidate) {
      await recordRecoveryTelemetry(deps, {
        state,
        retry,
        mode,
        start,
        outcome: "no-selection",
        confidence: result.selection.confidence,
        candidateCount: candidates.length,
        usage: result.usage,
      });
      console.error(result.selection.reason ? `zdr: ${result.selection.reason}` : "zdr: no candidate selected");
      return { code: 1 };
    }
    await writeRecoveryRetry({
      state,
      rejectedPath: result.candidate.path,
      existing: retry,
    });
    await recordRecoveryTelemetry(deps, {
      state,
      retry,
      mode,
      start,
      outcome: "selected",
      selectedPath: result.candidate.path,
      confidence: result.selection.confidence,
      candidateCount: candidates.length,
      usage: result.usage,
    });
    console.log(result.candidate.path);
    return { code: 0 };
  } catch (error) {
    await recordRecoveryTelemetry(deps, {
      state,
      retry,
      mode,
      start,
      outcome: "error",
      error: error instanceof Error ? error.message : String(error),
    });
    console.error(`zdr: ${error instanceof Error ? error.message : String(error)}`);
    return { code: 1 };
  }
}

async function pickerRecoveryCommand(
  state: FinishedZState,
  retry: NonNullable<Awaited<ReturnType<typeof readRecoveryRetryForAttempt>>>,
  deps: CliDeps,
  start: number,
): Promise<CommandResult> {
  const entries = await deps.loadZoxideEntries();
  console.error("zdr: opening picker...");
  const result = await deps.runPicker({
    query: state.query_argv.join(" "),
    zoxideEntries: entries,
    rejectedPaths: retry.rejected_paths,
    scanRoots: pickerScanRoots(state, deps),
  });
  switch (result.status) {
    case "selected":
      await recordRecoveryTelemetry(deps, {
        state,
        retry,
        mode: "picker",
        start,
        outcome: "picker-selected",
        selectedPath: result.path,
        candidateCount: entries.length,
      });
      console.log(result.path);
      return { code: 0 };
    case "cancelled":
      await recordRecoveryTelemetry(deps, {
        state,
        retry,
        mode: "picker",
        start,
        outcome: "picker-cancelled",
        candidateCount: entries.length,
      });
      console.error("zdr: picker cancelled");
      return { code: 1 };
    case "unavailable":
      await recordRecoveryTelemetry(deps, {
        state,
        retry,
        mode: "picker",
        start,
        outcome: "picker-unavailable",
        candidateCount: entries.length,
        error: result.reason,
      });
      console.error(`zdr: ${result.reason}`);
      return { code: 1 };
  }
}

async function recordRecoveryTelemetry(
  deps: CliDeps,
  input: {
    state: FinishedZState | null;
    retry: Awaited<ReturnType<typeof readRecoveryRetryForAttempt>>;
    mode: RecoveryMode | null;
    start: number;
    outcome: string;
    selectedPath?: string;
    confidence?: number;
    candidateCount?: number;
    usage?: unknown;
    error?: string;
  },
): Promise<void> {
  const providerUsage = summarizeProviderUsage(input.usage);
  const data: Record<string, unknown> = {
    query: input.state?.query_argv.join(" ") ?? null,
    mode: input.mode,
    rejected_path_count: input.retry?.rejected_paths.length ?? 0,
    ...(input.selectedPath === undefined ? {} : { selected_path: input.selectedPath }),
    ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
    ...(input.candidateCount === undefined ? {} : { candidate_count: input.candidateCount }),
    ...(input.usage === undefined || input.usage === null ? {} : { usage: input.usage }),
    ...(providerUsage === null ? {} : { provider_usage: providerUsage }),
    ...(input.error === undefined ? {} : { error: input.error }),
  };
  try {
    if (!(await telemetryEnabledFromConfig(deps))) {
      return;
    }
    await deps.appendTelemetryEvent({
      kind: "recovery",
      outcome: input.outcome,
      durationMs: elapsedMs(input.start),
      data,
    });
  } catch {
    // Telemetry must never break navigation.
  }
}

function pickerScanRoots(state: FinishedZState, deps: CliDeps): string[] {
  const candidates = [
    deps.cwd(),
    state.before_pwd,
    state.after_pwd,
  ];
  for (const path of [state.before_pwd, state.after_pwd]) {
    if (path.length === 0) {
      continue;
    }
    const parent = dirname(path);
    if (isSpecificScanRoot(parent)) {
      candidates.push(parent);
    }
  }
  return uniqueExistingText(candidates);
}

function uniqueExistingText(values: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (value.length === 0 || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function isSpecificScanRoot(path: string): boolean {
  const parsed = parse(path);
  if (path === parsed.root) {
    return false;
  }
  const relative = path.slice(parsed.root.length);
  const segments = relative.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    return false;
  }
  if (segments.length === 2 && (segments[0] === "Users" || segments[0] === "home")) {
    return false;
  }
  if (segments.length === 1 && (segments[0] === "tmp" || segments[0] === "var")) {
    return false;
  }
  return true;
}

type RecoveryMode = "model" | "retry-model" | "picker";

function chooseRecoveryMode(retry: Awaited<ReturnType<typeof readRecoveryRetryForAttempt>>): RecoveryMode {
  if (!retry || retry.rejected_paths.length === 0) {
    return "model";
  }
  if (retry.rejected_paths.length === 1) {
    return "retry-model";
  }
  return "picker";
}

async function directQueryCommand(queryArgv: string[], deps: CliDeps): Promise<CommandResult> {
  const query = queryArgv.join(" ").trim();
  if (query.length === 0) {
    console.error("zdr: direct query requires a non-empty query");
    return { code: 2 };
  }

  const start = performance.now();
  let cacheStatus: CorrectionLookup["status"] | null = null;
  try {
    const lookup = await deps.lookupCorrection(query);
    cacheStatus = lookup.status;
    if (lookup.status === "hit") {
      await recordDirectQueryTelemetry(deps, {
        query,
        start,
        outcome: "cache-hit",
        cacheStatus,
        selectedPath: lookup.entry.path,
        cached: true,
      });
      console.log(lookup.entry.path);
      return { code: 0 };
    }
    const result = await runDirectQuerySelection(queryArgv, deps);
    if (!result.candidate) {
      await recordDirectQueryTelemetry(deps, {
        query,
        start,
        outcome: "no-selection",
        cacheStatus,
        confidence: result.selection.confidence,
        usage: result.usage,
      });
      console.error(result.selection.reason ? `zdr: ${result.selection.reason}` : "zdr: no candidate selected");
      return { code: 1 };
    }
    const cached = await maybeStoreDirectQueryCorrection({
      query,
      result,
      deps,
    });
    await recordDirectQueryTelemetry(deps, {
      query,
      start,
      outcome: "selected",
      cacheStatus,
      selectedPath: result.candidate.path,
      confidence: result.selection.confidence,
      cached,
      usage: result.usage,
    });
    console.log(result.candidate.path);
    return { code: 0 };
  } catch (error) {
    await recordDirectQueryTelemetry(deps, {
      query,
      start,
      outcome: "error",
      cacheStatus,
      error: error instanceof Error ? error.message : String(error),
    });
    console.error(`zdr: ${error instanceof Error ? error.message : String(error)}`);
    return { code: 1 };
  }
}

async function recordDirectQueryTelemetry(
  deps: CliDeps,
  input: {
    query: string;
    start: number;
    outcome: string;
    cacheStatus: CorrectionLookup["status"] | null;
    selectedPath?: string;
    confidence?: number;
    cached?: boolean;
    usage?: unknown;
    error?: string;
  },
): Promise<void> {
  const providerUsage = summarizeProviderUsage(input.usage);
  const data: Record<string, unknown> = {
    query: input.query,
    cache_status: input.cacheStatus,
    ...(input.selectedPath === undefined ? {} : { selected_path: input.selectedPath }),
    ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
    ...(input.cached === undefined ? {} : { cached: input.cached }),
    ...(input.usage === undefined || input.usage === null ? {} : { usage: input.usage }),
    ...(providerUsage === null ? {} : { provider_usage: providerUsage }),
    ...(input.error === undefined ? {} : { error: input.error }),
  };
  try {
    if (!(await telemetryEnabledFromConfig(deps))) {
      return;
    }
    await deps.appendTelemetryEvent({
      kind: "direct-query",
      outcome: input.outcome,
      durationMs: elapsedMs(input.start),
      data,
    });
  } catch {
    // Telemetry must never break navigation.
  }
}

async function runDirectQuerySelection(queryArgv: string[], deps: CliDeps): Promise<SelectionResult> {
  const entries = await deps.loadZoxideEntries();
  const state = directQueryState(queryArgv, deps);
  const candidates = await buildSelectionCandidates({
    state,
    entries,
    limit: 50,
    rejectedPaths: [],
    deps,
  });
  if (candidates.length === 0) {
    throw new Error("no zoxide candidates found");
  }
  const config = (await deps.loadConfig()).config;
  return deps.selectCandidate({ state, candidates, provider: config.provider, privacy: config.privacy });
}

async function maybeStoreDirectQueryCorrection(input: {
  query: string;
  result: SelectionResult;
  deps: CliDeps;
}): Promise<boolean> {
  if (!input.result.candidate || input.result.selection.confidence < DIRECT_QUERY_CACHE_CONFIDENCE) {
    return false;
  }
  try {
    await input.deps.storeCorrection({
      query: input.query,
      path: input.result.candidate.path,
      now: input.deps.now(),
    });
    return true;
  } catch (error) {
    console.error(`zdr: warning: failed to store correction: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

function directQueryState(queryArgv: string[], deps: CliDeps): FinishedZState {
  const now = deps.now().toISOString();
  return {
    schema_version: 1,
    status: "finished",
    attempt_id: "direct-query",
    query_argv: queryArgv,
    before_pwd: deps.cwd(),
    after_pwd: "",
    exit_status: 0,
    shell: "direct-query",
    started_at: now,
    finished_at: now,
  };
}

async function runSelection(
  state: FinishedZState,
  retry: Awaited<ReturnType<typeof readRecoveryRetryForAttempt>>,
  limit: number,
  deps: CliDeps,
  options: { announceRetry?: boolean } = {},
) {
  const entries = await deps.loadZoxideEntries();
  const rejectedPaths = retry?.rejected_paths ?? [];
  if (options.announceRetry) {
    console.error("zdr: thinking harder...");
  }
  const candidates = await buildSelectionCandidates({
    state,
    entries,
    limit,
    rejectedPaths,
    deps,
  });
  const config = (await deps.loadConfig()).config;
  const result = await deps.selectCandidate({
    state,
    candidates,
    rejectedPaths,
    provider: config.provider,
    privacy: config.privacy,
    reasoning: options.announceRetry ? "high" : "minimal",
  });
  return { candidates, result, rejectedPaths };
}

async function runDebugSelection(limit: number, deps: CliDeps) {
  const state = await readLastZState();
  if (!state) {
    throw new Error("no recorded z attempt found");
  }

  const entries = await loadZoxideEntries();
  const retry = await readRecoveryRetryForAttempt(state);
  const rejectedPaths = retry?.rejected_paths ?? [];
  const candidates = await buildSelectionCandidates({
    state,
    entries,
    limit,
    rejectedPaths,
    deps,
  });
  const config = (await deps.loadConfig()).config;
  const result = await deps.selectCandidate({
    state,
    candidates,
    rejectedPaths,
    provider: config.provider,
    privacy: config.privacy,
  });
  return { state, candidates, result, retry, rejectedPaths };
}

async function buildSelectionCandidates(input: {
  state: FinishedZState;
  entries: ZoxideEntry[];
  limit: number;
  rejectedPaths: string[];
  deps: CliDeps;
}): Promise<Candidate[]> {
  const baseCandidates = buildCandidates({
    state: input.state,
    entries: input.entries,
    limit: input.limit,
    rejectedPaths: input.rejectedPaths,
  });
  if (!shouldAddLocalScanCandidates(baseCandidates)) {
    return baseCandidates;
  }
  const localPaths = await input.deps.scanLocalDirectories({
    query: input.state.query_argv.join(" ").trim(),
    roots: pickerScanRoots(input.state, input.deps),
    maxResults: 50,
  });
  if (localPaths.length === 0) {
    return baseCandidates;
  }
  return buildCandidates({
    state: input.state,
    entries: input.entries,
    localPaths,
    limit: input.limit,
    rejectedPaths: input.rejectedPaths,
  });
}

function commandExists(command: string): boolean {
  const result = Bun.spawnSync({
    cmd: ["bash", "-lc", `command -v "$1" >/dev/null`, "bash", command],
    stdout: "ignore",
    stderr: "ignore",
  });
  return result.exitCode === 0;
}

async function telemetryEnabledFromConfig(deps: CliDeps): Promise<boolean> {
  const envValue = process.env.ZDR_TELEMETRY;
  if (envValue && envValue.length > 0) {
    return telemetryEnabled(process.env);
  }
  try {
    return (await deps.loadConfig()).config.telemetry.enabled;
  } catch {
    return false;
  }
}

function printHelp(): void {
  console.log(`zdr ${VERSION}

Usage:
  zdr                 Repair the last bad zoxide jump
  zdr <query>         Direct lookup from correction cache or model selection
  zdr init zsh        Print zsh integration (placeholder)
  zdr record-z        Internal shell-state command
  zdr finish-z        Internal shell-state command
  zdr clear-recovery-retry
                      Internal shell-state command
  zdr debug-state     Print recorded z state
  zdr debug-candidates
                      Print candidate list for the recorded z state
  zdr debug-select   Ask the model to select from recorded candidates
  zdr debug-corrections
                      Print direct-query correction cache
  zdr debug-config   Print merged config
  zdr debug-events [--limit <count>]
                      Print local telemetry events as JSON
  zdr debug-timing [query]
                      Measure local timing paths as JSON
  zdr debug-timing [query] --budget-ms <ms>
                      Include local timing budget status in JSON
  zdr debug-provider-timing [query]
                      Measure live provider selection timing as JSON
  zdr benchmark-provider [query] [--repeat <count>]
                      Repeat live provider selection and summarize latency
  zdr benchmark-provider [query] --provider <provider> --model <model>
                      Benchmark a provider/model without changing config
  zdr benchmark-provider [query] --jsonl
                      Stream benchmark context, iterations, and summary as JSONL
  zdr benchmark-suite [query] [--repeat <count>]
                      Benchmark the same candidate context across providers
  zdr benchmark-suite [query] --jsonl
                      Stream suite context, iterations, and summaries as JSONL
  zdr doctor         Print setup diagnostics as JSON
  zdr config-provider <provider> <model>
                      Set provider.name and provider.model in config
  zdr prune-events [--max-events <count>]
                      Keep only the newest local telemetry events
  zdr forget <query> Remove one exact direct-query correction
  zdr provider-smoke  Verify Pi provider/model lookup
  zdr provider-smoke --live
                      Make a tiny live provider completion
  zdr provider-list [provider]
                      List Pi providers, OAuth support, and provider models
  zdr provider-login <provider>
                      Log in to an OAuth provider
  zdr provider-logout <provider>
                      Remove stored OAuth credentials
  zdr provider-auth-status [provider]
                      Print OAuth provider auth status
  zdr --version       Print version
`);
}

if (import.meta.main) {
  const result = await main(Bun.argv.slice(2));
  process.exit(result.code);
}
