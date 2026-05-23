#!/usr/bin/env bun

import packageJson from "../package.json" with { type: "json" };
import { dirname, parse } from "node:path";
import { buildCandidates, shouldAddLocalScanCandidates, type Candidate } from "./candidates.js";
import { getConfigPaths, loadConfig, setProviderConfig, type LoadedConfig, type ZdrConfig } from "./config.js";
import {
  getCachePaths,
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
  getStatePaths,
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
import type { ProviderReasoning, SelectionResult } from "./provider/select.js";
import { summarizeProviderUsage } from "./provider/usage.js";
import { scanLocalDirectories } from "./local-scan.js";
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

type DebugEventsArgs = { ok: true; limit?: number } | { ok: false; error: string };

function parseDebugEventsArgs(args: string[]): DebugEventsArgs {
  let limit: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      return { ok: false, error: "unexpected missing argument" };
    }
    if (arg === "--limit") {
      const value = args[index + 1];
      if (!value) {
        return { ok: false, error: "--limit requires a value" };
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        return { ok: false, error: "--limit must be a positive integer" };
      }
      limit = parsed;
      index += 1;
      continue;
    }
    if (arg.startsWith("--limit=")) {
      const parsed = Number(arg.slice("--limit=".length));
      if (!Number.isInteger(parsed) || parsed < 1) {
        return { ok: false, error: "--limit must be a positive integer" };
      }
      limit = parsed;
      continue;
    }
    return { ok: false, error: `unknown debug-events argument: ${arg}` };
  }

  return limit === undefined ? { ok: true } : { ok: true, limit };
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

type PruneEventsArgs = { ok: true; maxEvents?: number } | { ok: false; error: string };

function parsePruneEventsArgs(args: string[]): PruneEventsArgs {
  let maxEvents: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      return { ok: false, error: "unexpected missing argument" };
    }
    if (arg === "--max-events") {
      const value = args[index + 1];
      if (!value || value.trim().length === 0) {
        return { ok: false, error: "--max-events requires a value" };
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) {
        return { ok: false, error: "--max-events must be a non-negative integer" };
      }
      maxEvents = parsed;
      index += 1;
      continue;
    }
    if (arg.startsWith("--max-events=")) {
      const value = arg.slice("--max-events=".length);
      if (!value || value.trim().length === 0) {
        return { ok: false, error: "--max-events requires a value" };
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) {
        return { ok: false, error: "--max-events must be a non-negative integer" };
      }
      maxEvents = parsed;
      continue;
    }
    return { ok: false, error: `unknown prune-events argument: ${arg}` };
  }

  return maxEvents === undefined ? { ok: true } : { ok: true, maxEvents };
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
      await measureStep("provider-selection", () => runProviderSelectionForTiming(selectionState, candidates, rejectedPaths, deps)),
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

  const iterations: ProviderBenchmarkIteration[] = [];
  for (let index = 0; index < parsed.repeat; index += 1) {
    const start = performance.now();
    try {
      const metadata = await runProviderSelectionForTiming(context.state, context.candidates, context.rejectedPaths, deps, {
        provider,
        privacy: config.privacy,
      });
      iterations.push({
        index: index + 1,
        ok: true,
        duration_ms: elapsedMs(start),
        metadata,
      });
    } catch (error) {
      iterations.push({
        index: index + 1,
        ok: false,
        duration_ms: elapsedMs(start),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  console.log(
    JSON.stringify(
      {
        schema_version: 1,
        command: "benchmark-provider",
        query: context.state.query_argv.join(" "),
        mode: parsed.queryArgv.length > 0 ? "direct-query" : "recovery",
        repeat: parsed.repeat,
        provider,
        ok: iterations.every((iteration) => iteration.ok),
        total_duration_ms: elapsedMs(commandStart),
        context: {
          duration_ms: contextDurationMs,
          zoxide_entry_count: context.entryCount,
          candidate_count: context.candidates.length,
          rejected_path_count: context.rejectedPaths.length,
        },
        summary: summarizeProviderBenchmark(iterations),
        iterations,
      },
      null,
      2,
    ),
  );
  return { code: iterations.every((iteration) => iteration.ok) ? 0 : 1 };
}

async function runProviderSelectionForTiming(
  state: FinishedZState,
  candidates: Candidate[],
  rejectedPaths: string[],
  deps: CliDeps,
  options: { provider?: ZdrConfig["provider"]; privacy?: ZdrConfig["privacy"] } = {},
): Promise<Record<string, unknown>> {
  const config = options.provider && options.privacy ? undefined : (await deps.loadConfig()).config;
  const provider = options.provider ?? config?.provider;
  const privacy = options.privacy ?? config?.privacy;
  if (!provider || !privacy) {
    throw new Error("provider configuration is unavailable");
  }
  const result = await deps.selectCandidate({
    state,
    candidates,
    rejectedPaths,
    provider,
    privacy,
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

type ProviderBenchmarkIteration = {
  index: number;
  ok: boolean;
  duration_ms: number;
  metadata?: Record<string, unknown>;
  error?: string;
};

type BenchmarkProviderArgs =
  | { ok: true; queryArgv: string[]; repeat: number; provider?: ZdrConfig["provider"] }
  | { ok: false; error: string };

const DEFAULT_PROVIDER_BENCHMARK_REPEAT = 3;
const MAX_PROVIDER_BENCHMARK_REPEAT = 20;

function parseBenchmarkProviderArgs(args: string[]): BenchmarkProviderArgs {
  const queryArgv: string[] = [];
  let repeat = DEFAULT_PROVIDER_BENCHMARK_REPEAT;
  let providerName: string | undefined;
  let model: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      return { ok: false, error: "unexpected missing argument" };
    }
    if (arg === "--repeat") {
      const value = args[index + 1];
      if (!value) {
        return { ok: false, error: "--repeat requires a value" };
      }
      const parsed = parseProviderBenchmarkRepeat(value);
      if (!parsed.ok) {
        return parsed;
      }
      repeat = parsed.value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--repeat=")) {
      const parsed = parseProviderBenchmarkRepeat(arg.slice("--repeat=".length));
      if (!parsed.ok) {
        return parsed;
      }
      repeat = parsed.value;
      continue;
    }
    if (arg === "--provider") {
      const value = args[index + 1];
      if (!value || value.trim().length === 0 || value.startsWith("-")) {
        return { ok: false, error: "--provider requires a value" };
      }
      providerName = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--provider=")) {
      const value = arg.slice("--provider=".length);
      if (value.trim().length === 0) {
        return { ok: false, error: "--provider requires a value" };
      }
      providerName = value;
      continue;
    }
    if (arg === "--model") {
      const value = args[index + 1];
      if (!value || value.trim().length === 0 || value.startsWith("-")) {
        return { ok: false, error: "--model requires a value" };
      }
      model = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--model=")) {
      const value = arg.slice("--model=".length);
      if (value.trim().length === 0) {
        return { ok: false, error: "--model requires a value" };
      }
      model = value;
      continue;
    }
    if (arg.startsWith("-")) {
      return { ok: false, error: `unknown benchmark-provider option: ${arg}` };
    }
    queryArgv.push(arg);
  }

  if ((providerName && !model) || (!providerName && model)) {
    return { ok: false, error: "--provider and --model must be provided together" };
  }

  return providerName && model
    ? { ok: true, queryArgv, repeat, provider: { name: providerName, model } }
    : { ok: true, queryArgv, repeat };
}

function parseProviderBenchmarkRepeat(value: string): { ok: true; value: number } | { ok: false; error: string } {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return { ok: false, error: "--repeat must be a positive integer" };
  }
  if (parsed > MAX_PROVIDER_BENCHMARK_REPEAT) {
    return { ok: false, error: `--repeat must be ${MAX_PROVIDER_BENCHMARK_REPEAT} or less` };
  }
  return { ok: true, value: parsed };
}

function summarizeProviderBenchmark(iterations: ProviderBenchmarkIteration[]): Record<string, unknown> {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type DebugProviderTimingArgs =
  | { ok: true; queryArgv: string[] }
  | { ok: false; error: string };

function parseDebugProviderTimingArgs(args: string[]): DebugProviderTimingArgs {
  for (const arg of args) {
    if (arg.startsWith("-")) {
      return { ok: false, error: `unknown debug-provider-timing option: ${arg}` };
    }
  }
  return { ok: true, queryArgv: args };
}

async function buildProviderTimingContext(
  queryArgv: string[],
  deps: CliDeps,
): Promise<{ state: FinishedZState; rejectedPaths: string[]; candidates: Candidate[]; entryCount: number }> {
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

type DebugTimingArgs =
  | { ok: true; queryArgv: string[]; budgetMs?: number }
  | { ok: false; error: string };

function parseDebugTimingArgs(args: string[]): DebugTimingArgs {
  const queryArgv: string[] = [];
  let budgetMs: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      return { ok: false, error: "unexpected missing argument" };
    }
    if (arg === "--budget-ms") {
      const value = args[index + 1];
      if (!value) {
        return { ok: false, error: "--budget-ms requires a value" };
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return { ok: false, error: "--budget-ms must be a positive number" };
      }
      budgetMs = parsed;
      index += 1;
      continue;
    }
    if (arg.startsWith("--budget-ms=")) {
      const value = arg.slice("--budget-ms=".length);
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return { ok: false, error: "--budget-ms must be a positive number" };
      }
      budgetMs = parsed;
      continue;
    }
    if (arg.startsWith("-")) {
      return { ok: false, error: `unknown debug-timing option: ${arg}` };
    }
    queryArgv.push(arg);
  }

  return budgetMs === undefined ? { ok: true, queryArgv } : { ok: true, queryArgv, budgetMs };
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

async function providerSmokeCommand(args: string[], deps: CliDeps): Promise<CommandResult> {
  const { smokePiOpenRouter } = await import("./provider/pi.js");
  try {
    const config = (await deps.loadConfig()).config;
    return smokePiOpenRouter({ live: args.includes("--live"), provider: config.provider });
  } catch (error) {
    console.error(`zdr: ${error instanceof Error ? error.message : String(error)}`);
    return { code: 1 };
  }
}

async function doctorCommand(args: string[], deps: CliDeps): Promise<CommandResult> {
  if (args.length > 0) {
    console.error(`zdr: unknown doctor option: ${args[0]}`);
    return { code: 2 };
  }

  const configPaths = getConfigPaths();
  const statePaths = getStatePaths();
  const cachePaths = getCachePaths();
  const { getAuthPath, isKnownOAuthProvider } = await import("./provider/auth.js");
  const { getTelemetryPaths } = await import("./telemetry.js");
  const telemetryPaths = getTelemetryPaths();
  const checks: DoctorCheck[] = [];
  let loaded: LoadedConfig | null = null;

  try {
    loaded = await deps.loadConfig();
    checks.push({ name: "config", ok: true, message: loaded.source, path: loaded.path });
  } catch (error) {
    checks.push({
      name: "config",
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      path: configPaths.config,
    });
  }

  const provider = loaded?.config.provider ?? null;
  let providerInfo: Record<string, unknown> | null = null;
  if (provider) {
    const { findEnvKeys } = await import("@earendil-works/pi-ai");
    const { resolveConfiguredModel } = await import("./provider/model.js");
    const model = await resolveConfiguredModel(provider);
    checks.push({
      name: "provider_model",
      ok: model !== null,
      message: model ? `${model.provider}/${model.id}` : `${provider.name}/${provider.model} not found`,
    });

    const envKeys = findEnvKeys(provider.name) ?? [];
    const oauth = isKnownOAuthProvider(provider.name) ? (await deps.providerAuthStatuses([provider.name]))[0] : undefined;
    const authOk = oauth ? oauth.authenticated && oauth.expired !== true : envKeys.length > 0;
    checks.push({
      name: "provider_auth",
      ok: authOk,
      message: oauth
        ? oauth.authenticated
          ? oauth.expired
            ? "OAuth credentials expired"
            : "OAuth credentials available"
          : `run 'zdr provider-login ${provider.name}'`
        : envKeys.length > 0
          ? `env: ${envKeys.join(", ")}`
          : `set provider API key for ${provider.name}`,
    });

    providerInfo = {
      ...provider,
      known_model: model !== null,
      api: model?.api ?? null,
      auth: oauth
        ? {
            type: "oauth",
            authenticated: oauth.authenticated,
            expired: oauth.expired ?? null,
            expires_at: oauth.expires_at ?? null,
            refresh_available: oauth.refresh_available ?? null,
          }
        : {
            type: "env",
            env_keys: envKeys,
            authenticated: envKeys.length > 0,
          },
    };
  }

  const zoxideAvailable = deps.commandExists("zoxide");
  checks.push({
    name: "zoxide",
    ok: zoxideAvailable,
    message: zoxideAvailable ? "available" : "zoxide command not found",
  });

  const fzfAvailable = deps.commandExists("fzf");
  const fdAvailable = deps.commandExists("fd");
  const lastZ = await readLastZState().catch(() => null);
  const requiredOk = checks.every((check) => check.ok);
  console.log(
    JSON.stringify(
      {
        schema_version: 1,
        command: "doctor",
        ok: requiredOk,
        checks,
        provider: providerInfo,
        shell: {
          detected: detectedShell(),
          recorded_z_attempt: lastZ !== null,
          note: "A child process cannot inspect whether the current shell has sourced `zdr init`; recorded_z_attempt shows whether shell integration has captured a z jump.",
        },
        tools: {
          zoxide: zoxideAvailable,
          fzf: fzfAvailable,
          fd: fdAvailable,
        },
        paths: {
          config: configPaths.config,
          auth: getAuthPath(),
          state_dir: statePaths.stateDir,
          last_z: statePaths.lastZ,
          recovery_retry: statePaths.recoveryRetry,
          corrections: cachePaths.corrections,
          telemetry_events: telemetryPaths.events,
        },
      },
      null,
      2,
    ),
  );
  return { code: requiredOk ? 0 : 1 };
}

type DoctorCheck = {
  name: string;
  ok: boolean;
  message: string;
  path?: string;
};

async function configProviderCommand(args: string[], deps: CliDeps): Promise<CommandResult> {
  const parsed = parseConfigProviderArgs(args);
  if (!parsed.ok) {
    console.error(`zdr: ${parsed.error}`);
    return { code: 2 };
  }
  try {
    const { resolveConfiguredModel } = await import("./provider/model.js");
    const model = await resolveConfiguredModel(parsed.provider);
    if (!model) {
      console.error(`zdr: Pi did not return configured ${parsed.provider.name} model ${parsed.provider.model}`);
      return { code: 1 };
    }
    const config = await deps.setProviderConfig(parsed.provider);
    console.log(
      JSON.stringify(
        {
          schema_version: 1,
          path: config.path,
          provider: config.config.provider,
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

type ConfigProviderArgs = { ok: true; provider: ZdrConfig["provider"] } | { ok: false; error: string };

function parseConfigProviderArgs(args: string[]): ConfigProviderArgs {
  if (args.length !== 2) {
    return { ok: false, error: "config-provider requires provider and model" };
  }
  const [name, model] = args;
  if (!name || name.startsWith("-")) {
    return { ok: false, error: `unknown config-provider option: ${name ?? ""}` };
  }
  if (!model || model.startsWith("-")) {
    return { ok: false, error: `unknown config-provider option: ${model ?? ""}` };
  }
  return { ok: true, provider: { name, model } };
}

async function providerLoginCommand(args: string[], deps: CliDeps): Promise<CommandResult> {
  const parsed = parseSingleProviderArg("provider-login", args);
  if (!parsed.ok) {
    console.error(`zdr: ${parsed.error}`);
    return { code: 2 };
  }

  try {
    const loginAbort = new AbortController();
    try {
      await deps.providerLogin(parsed.provider, {
        onAuth: (info) => {
          console.error(`zdr: open this URL to log in to ${parsed.provider}:`);
          console.error(info.url);
          if (info.instructions) {
            console.error(`zdr: ${info.instructions}`);
          }
          openBrowser(info.url);
        },
        onPrompt: async (prompt) => {
          return promptForOAuthInput(prompt.message, loginAbort.signal);
        },
        onProgress: (message) => console.error(`zdr: ${message}`),
        onManualCodeInput: async () => promptForOAuthInput("Paste redirect URL or authorization code:", loginAbort.signal),
      });
    } finally {
      loginAbort.abort();
    }
    console.log(JSON.stringify({ schema_version: 1, provider: parsed.provider, authenticated: true }, null, 2));
    return { code: 0 };
  } catch (error) {
    console.error(`zdr: ${error instanceof Error ? error.message : String(error)}`);
    return { code: 1 };
  }
}

async function promptForOAuthInput(message: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) {
    throw new Error("OAuth login completed");
  }
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    if (signal) {
      return await rl.question(`zdr: ${message} `, { signal });
    }
    return await rl.question(`zdr: ${message} `);
  } finally {
    rl.close();
  }
}

async function providerLogoutCommand(args: string[], deps: CliDeps): Promise<CommandResult> {
  const parsed = parseSingleProviderArg("provider-logout", args);
  if (!parsed.ok) {
    console.error(`zdr: ${parsed.error}`);
    return { code: 2 };
  }
  try {
    const removed = await deps.providerLogout(parsed.provider);
    console.log(JSON.stringify({ schema_version: 1, provider: parsed.provider, removed }, null, 2));
    return { code: 0 };
  } catch (error) {
    console.error(`zdr: ${error instanceof Error ? error.message : String(error)}`);
    return { code: 1 };
  }
}

async function providerAuthStatusCommand(args: string[], deps: CliDeps): Promise<CommandResult> {
  if (args.length > 1) {
    console.error("zdr: provider-auth-status accepts at most one provider");
    return { code: 2 };
  }
  if (args[0]?.startsWith("-")) {
    console.error(`zdr: unknown provider-auth-status option: ${args[0]}`);
    return { code: 2 };
  }
  try {
    const statuses = await deps.providerAuthStatuses(args[0] ? [args[0]] : undefined);
    console.log(JSON.stringify({ schema_version: 1, providers: statuses }, null, 2));
    return { code: 0 };
  } catch (error) {
    console.error(`zdr: ${error instanceof Error ? error.message : String(error)}`);
    return { code: 1 };
  }
}

type ProviderArg = { ok: true; provider: string } | { ok: false; error: string };

function parseSingleProviderArg(command: string, args: string[]): ProviderArg {
  if (args.length !== 1) {
    return { ok: false, error: `${command} requires exactly one provider` };
  }
  if (args[0]?.startsWith("-")) {
    return { ok: false, error: `unknown ${command} option: ${args[0]}` };
  }
  return { ok: true, provider: args[0] as string };
}

function openBrowser(url: string): void {
  if (process.env.ZDR_NO_OPEN_BROWSER === "1") {
    return;
  }
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    Bun.spawn([command, ...args], {
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    // The printed URL is the fallback.
  }
}

function commandExists(command: string): boolean {
  const result = Bun.spawnSync({
    cmd: ["bash", "-lc", `command -v "$1" >/dev/null`, "bash", command],
    stdout: "ignore",
    stderr: "ignore",
  });
  return result.exitCode === 0;
}

function detectedShell(): string {
  const shell = process.env.SHELL;
  if (!shell) {
    return "unknown";
  }
  return shell.split("/").at(-1) || shell;
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
  zdr doctor         Print setup diagnostics as JSON
  zdr config-provider <provider> <model>
                      Set provider.name and provider.model in config
  zdr prune-events [--max-events <count>]
                      Keep only the newest local telemetry events
  zdr forget <query> Remove one exact direct-query correction
  zdr provider-smoke  Verify Pi provider/model lookup
  zdr provider-smoke --live
                      Make a tiny live provider completion
  zdr provider-login <provider>
                      Log in to an OAuth provider
  zdr provider-logout <provider>
                      Remove stored OAuth credentials
  zdr provider-auth-status [provider]
                      Print OAuth provider auth status
  zdr --version       Print version
`);
}

function zshInitScript(): string {
  return [
    "# zoxide-doctor zsh integration",
    "#",
    "# Source this after zoxide has initialized its z function.",
    "",
    "if ! typeset -f z >/dev/null 2>&1; then",
    '  echo "zdr: zoxide function \'z\' is not defined; run zoxide init before zdr init" >&2',
    "else",
    "  if ! typeset -f __zdr_original_z >/dev/null 2>&1; then",
    "    functions[__zdr_original_z]=$functions[z]",
    "  fi",
    "",
    "  z() {",
    '    local __zdr_attempt="zsh-${$}-${EPOCHREALTIME}-${RANDOM}"',
    '    __zdr_attempt="${__zdr_attempt//[^A-Za-z0-9_.-]/_}"',
    '    local __zdr_before="$PWD"',
    '    command zdr record-z --attempt "$__zdr_attempt" --before "$__zdr_before" --shell zsh -- "$@"',
    '    __zdr_original_z "$@"',
    "    local __zdr_status=$?",
    '    command zdr finish-z --attempt "$__zdr_attempt" --after "$PWD" --status "$__zdr_status"',
    '    return "$__zdr_status"',
    "  }",
    "fi",
    "",
    "zdr() {",
    "  case \"$1\" in",
    "    init|record-z|finish-z|clear-recovery-retry|debug-state|debug-candidates|debug-select|debug-corrections|debug-config|debug-events|debug-timing|debug-provider-timing|benchmark-provider|doctor|config-provider|prune-events|forget|provider-smoke|provider-login|provider-logout|provider-auth-status|--*|-*)",
    "      command zdr \"$@\"",
    "      return $?",
    "      ;;",
    "  esac",
    "",
    "  local __zdr_target",
    '  __zdr_target=$(command zdr "$@")',
    "  local __zdr_status=$?",
    '  if [ $__zdr_status -eq 0 ] && [ -n "$__zdr_target" ]; then',
    '    cd -- "$__zdr_target"',
    "    return $?",
    "  fi",
    "  return $__zdr_status",
    "}",
    "",
    "_zdr_is_no_arg_zdr_command() {",
    "  local __zdr_command=$1",
    "  local __zdr_pattern='^[[:space:]]*(command[[:space:]]+)?zdr[[:space:]]*$'",
    "  [[ \"$__zdr_command\" =~ $__zdr_pattern ]]",
    "}",
    "",
    "_zdr_preexec() {",
    '  if _zdr_is_no_arg_zdr_command "$1"; then',
    "    :",
    "  else",
    '      local __zdr_retry="${XDG_STATE_HOME:-$HOME/.local/state}/zdr/recovery_retry.json"',
    '      [[ -e "$__zdr_retry" ]] && rm -f "$__zdr_retry"',
    "  fi",
    "}",
    "",
    'if [[ -z "${preexec_functions[(r)_zdr_preexec]}" ]]; then',
    "  preexec_functions+=(_zdr_preexec)",
    "fi",
  ].join("\n");
}

function bashInitScript(): string {
  return [
    "# zoxide-doctor bash integration",
    "#",
    "# Source this after zoxide has initialized its z function.",
    "",
    "__zdr_clear_recovery_retry_file() {",
    '  local __zdr_retry="${XDG_STATE_HOME:-$HOME/.local/state}/zdr/recovery_retry.json"',
    '  [ -e "$__zdr_retry" ] && rm -f "$__zdr_retry"',
    "}",
    "",
    "if ! declare -F z >/dev/null 2>&1; then",
    '  echo "zdr: zoxide function \'z\' is not defined; run zoxide init before zdr init" >&2',
    "else",
    "  if ! declare -F __zdr_original_z >/dev/null 2>&1; then",
    "    eval \"$(declare -f z | sed -E '1{s/^z[[:space:]]*\\(\\)/__zdr_original_z()/;s/^function[[:space:]]+z[[:space:]]*\\(\\)/function __zdr_original_z()/;}')\"",
    "  fi",
    "",
    "  z() {",
    '    local __zdr_pid="${BASHPID:-$$}"',
    '    local __zdr_attempt="bash-${__zdr_pid}-${SECONDS}-${RANDOM}"',
    '    __zdr_attempt="${__zdr_attempt//[^A-Za-z0-9_.-]/_}"',
    '    local __zdr_before="$PWD"',
    '    command zdr record-z --attempt "$__zdr_attempt" --before "$__zdr_before" --shell bash -- "$@"',
    '    __zdr_original_z "$@"',
    "    local __zdr_status=$?",
    '    command zdr finish-z --attempt "$__zdr_attempt" --after "$PWD" --status "$__zdr_status"',
    '    return "$__zdr_status"',
    "  }",
    "fi",
    "",
    "zdr() {",
    "  __zdr_inside_zdr=1",
    "  case \"$1\" in",
    "    init|record-z|finish-z|clear-recovery-retry|debug-state|debug-candidates|debug-select|debug-corrections|debug-config|debug-events|debug-timing|debug-provider-timing|benchmark-provider|doctor|config-provider|prune-events|forget|provider-smoke|provider-login|provider-logout|provider-auth-status|--*|-*)",
    "      command zdr \"$@\"",
    "      local __zdr_status=$?",
    "      __zdr_last_command=\"zdr-other\"",
    "      __zdr_inside_zdr=0",
    "      return $__zdr_status",
    "      ;;",
    "  esac",
    "",
    '  if [ "$#" -gt 0 ]; then',
    "    __zdr_clear_recovery_retry_file",
    "  fi",
    "",
    "  local __zdr_target",
    '  __zdr_target=$(command zdr "$@")',
    "  local __zdr_status=$?",
    '  if [ "$#" -eq 0 ]; then',
    '    __zdr_last_command="zdr"',
    "  else",
    '    __zdr_last_command="zdr-other"',
    "  fi",
    "  __zdr_inside_zdr=0",
    '  if [ $__zdr_status -eq 0 ] && [ -n "$__zdr_target" ]; then',
    '    cd -- "$__zdr_target"',
    "    return $?",
    "  fi",
    "  return $__zdr_status",
    "}",
    "",
    "__zdr_prompt_command() {",
    "  local __zdr_status=$?",
    '  case "${__zdr_last_command:-}" in',
    "    zdr) ;;",
    "    *) __zdr_clear_recovery_retry_file ;;",
    "  esac",
    "  __zdr_last_command=",
    "  return $__zdr_status",
    "}",
    "",
    "if declare -p PROMPT_COMMAND 2>/dev/null | grep -q '^declare -a'; then",
    '  case " ${PROMPT_COMMAND[*]} " in',
    "    *' __zdr_prompt_command '*) ;;",
    "    *) PROMPT_COMMAND=(__zdr_prompt_command \"${PROMPT_COMMAND[@]}\") ;;",
    "  esac",
    "else",
    '  case ";${PROMPT_COMMAND:-};" in',
    "    *';__zdr_prompt_command;'*) ;;",
    "    *) PROMPT_COMMAND=\"__zdr_prompt_command${PROMPT_COMMAND:+;$PROMPT_COMMAND}\" ;;",
    "  esac",
    "fi",
  ].join("\n");
}

function fishInitScript(): string {
  return [
    "# zoxide-doctor fish integration",
    "#",
    "# Source this after zoxide has initialized its z function.",
    "",
    "function __zdr_clear_recovery_retry_file",
    '    set -l __zdr_retry "$XDG_STATE_HOME/zdr/recovery_retry.json"',
    '    if test -z "$XDG_STATE_HOME"',
    '        set __zdr_retry "$HOME/.local/state/zdr/recovery_retry.json"',
    "    end",
    '    test -e "$__zdr_retry"; and rm -f "$__zdr_retry"',
    "end",
    "",
    "if not functions --query z",
    '    echo "zdr: zoxide function \'z\' is not defined; run zoxide init before zdr init" >&2',
    "else",
    "    if not functions --query __zdr_original_z",
    "        functions --copy z __zdr_original_z",
    "    end",
    "",
    "    function z",
    "        set -l __zdr_attempt fish-$fish_pid-(date +%s%N)-(random)",
    "        set __zdr_attempt (string replace --regex --all '[^A-Za-z0-9_.-]' '_' -- $__zdr_attempt)",
    '        set -l __zdr_before "$PWD"',
    '        command zdr record-z --attempt "$__zdr_attempt" --before "$__zdr_before" --shell fish -- $argv',
    "        __zdr_original_z $argv",
    "        set -l __zdr_status $status",
    '        command zdr finish-z --attempt "$__zdr_attempt" --after "$PWD" --status "$__zdr_status"',
    "        return $__zdr_status",
    "    end",
    "end",
    "",
    "function zdr",
    '    switch "$argv[1]"',
    "        case init record-z finish-z clear-recovery-retry debug-state debug-candidates debug-select debug-corrections debug-config debug-events debug-timing debug-provider-timing benchmark-provider doctor config-provider prune-events forget provider-smoke provider-login provider-logout provider-auth-status '--*' '-*'",
    "            command zdr $argv",
    "            return $status",
    "    end",
    "",
    "    if test (count $argv) -gt 0",
    "        __zdr_clear_recovery_retry_file",
    "    end",
    "",
    "    set -l __zdr_target (command zdr $argv)",
    "    set -l __zdr_status $status",
    '    if test $__zdr_status -eq 0 -a -n "$__zdr_target"',
    '        cd -- "$__zdr_target"',
    "        return $status",
    "    end",
    "    return $__zdr_status",
    "end",
    "",
    "function __zdr_is_no_arg_zdr_command",
    "    set -l __zdr_commandline (string trim -- \"$argv[1]\")",
    "    string match --regex --quiet '^(command[[:space:]]+)?zdr$' -- \"$__zdr_commandline\"",
    "end",
    "",
    "function __zdr_preexec --on-event fish_preexec",
    '    set -l __zdr_commandline (string join " " -- $argv)',
    '    if not __zdr_is_no_arg_zdr_command "$__zdr_commandline"',
    "        __zdr_clear_recovery_retry_file",
    "    end",
    "end",
  ].join("\n");
}

type RecordZArgs =
  | { ok: true; attemptId: string; beforePwd: string; shell?: string; queryArgv: string[] }
  | { ok: false; error: string };

function parseRecordZArgs(args: string[]): RecordZArgs {
  let attemptId: string | undefined;
  let beforePwd: string | undefined;
  let shell: string | undefined;
  const queryArgv: string[] = [];
  let passthrough = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      return { ok: false, error: "unexpected missing argument" };
    }
    if (passthrough) {
      queryArgv.push(arg);
      continue;
    }
    if (arg === "--") {
      passthrough = true;
      continue;
    }
    if (arg === "--before") {
      const value = args[index + 1];
      if (!value) {
        return { ok: false, error: "record-z requires a value after --before" };
      }
      beforePwd = value;
      index += 1;
      continue;
    }
    if (arg === "--attempt") {
      const value = args[index + 1];
      if (!value) {
        return { ok: false, error: "record-z requires a value after --attempt" };
      }
      attemptId = value;
      index += 1;
      continue;
    }
    if (arg === "--shell") {
      const value = args[index + 1];
      if (!value) {
        return { ok: false, error: "record-z requires a value after --shell" };
      }
      shell = value;
      index += 1;
      continue;
    }
    return { ok: false, error: `unknown record-z argument: ${arg}` };
  }

  if (!beforePwd) {
    return { ok: false, error: "record-z requires --before <pwd>" };
  }
  if (!attemptId) {
    return { ok: false, error: "record-z requires --attempt <id>" };
  }
  return {
    ok: true,
    attemptId,
    beforePwd,
    queryArgv,
    ...(shell ? { shell } : {}),
  };
}

type LimitArgs = { ok: true; value: number } | { ok: false; error: string };

function parseLimit(args: string[]): LimitArgs {
  let value = 50;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--limit") {
      const raw = args[index + 1];
      if (!raw) {
        return { ok: false, error: "limit requires a value after --limit" };
      }
      value = Number.parseInt(raw, 10);
      index += 1;
      continue;
    }
    return { ok: false, error: `unknown debug-candidates argument: ${arg ?? ""}` };
  }
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    return { ok: false, error: "--limit must be between 1 and 200" };
  }
  return { ok: true, value };
}

type FinishZArgs =
  | { ok: true; attemptId: string; afterPwd: string; exitStatus: number }
  | { ok: false; error: string };

function parseFinishZArgs(args: string[]): FinishZArgs {
  let attemptId: string | undefined;
  let afterPwd: string | undefined;
  let statusText: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      return { ok: false, error: "unexpected missing argument" };
    }
    if (arg === "--after") {
      const value = args[index + 1];
      if (!value) {
        return { ok: false, error: "finish-z requires a value after --after" };
      }
      afterPwd = value;
      index += 1;
      continue;
    }
    if (arg === "--attempt") {
      const value = args[index + 1];
      if (!value) {
        return { ok: false, error: "finish-z requires a value after --attempt" };
      }
      attemptId = value;
      index += 1;
      continue;
    }
    if (arg === "--status") {
      const value = args[index + 1];
      if (!value) {
        return { ok: false, error: "finish-z requires a value after --status" };
      }
      statusText = value;
      index += 1;
      continue;
    }
    return { ok: false, error: `unknown finish-z argument: ${arg}` };
  }

  if (!afterPwd) {
    return { ok: false, error: "finish-z requires --after <pwd>" };
  }
  if (!attemptId) {
    return { ok: false, error: "finish-z requires --attempt <id>" };
  }
  if (!statusText) {
    return { ok: false, error: "finish-z requires --status <exit_status>" };
  }
  const exitStatus = Number.parseInt(statusText, 10);
  if (!Number.isInteger(exitStatus) || exitStatus < 0) {
    return { ok: false, error: `invalid exit status: ${statusText}` };
  }
  return { ok: true, attemptId, afterPwd, exitStatus };
}

if (import.meta.main) {
  const result = await main(Bun.argv.slice(2));
  process.exit(result.code);
}
