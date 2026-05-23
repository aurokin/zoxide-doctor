#!/usr/bin/env bun

import packageJson from "../package.json" with { type: "json" };
import {
  runProviderBenchmark,
  runProviderSelectionForTiming,
  type ProviderBenchmarkContext,
  type ProviderBenchmarkIteration,
  type ProviderBenchmarkResult,
} from "./benchmark.js";
import { buildCandidates, type Candidate } from "./candidates.js";
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
} from "./shell-state.js";
import { loadZoxideEntries, type ZoxideEntry } from "./zoxide.js";
import type { PickerInput, PickerResult } from "./picker.js";
import type { OAuthLoginCallbacks, ProviderAuthStatus } from "./provider/auth.js";
import {
  buildSelectionCandidates,
  directQueryCommand,
  directQueryState,
  recoverCommand,
  runDebugSelection,
} from "./navigation.js";
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
import { scanLocalDirectories } from "./local-scan.js";
import { bashInitScript, fishInitScript, zshInitScript } from "./shell-init.js";
import {
  appendTelemetryEvent,
  pruneTelemetryEvents,
  readTelemetryEvents,
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

function commandExists(command: string): boolean {
  const result = Bun.spawnSync({
    cmd: ["bash", "-lc", `command -v "$1" >/dev/null`, "bash", command],
    stdout: "ignore",
    stderr: "ignore",
  });
  return result.exitCode === 0;
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
