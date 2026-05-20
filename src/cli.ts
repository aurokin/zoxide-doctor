#!/usr/bin/env bun

import packageJson from "../package.json" with { type: "json" };
import { dirname, parse } from "node:path";
import { buildCandidates, type Candidate } from "./candidates.js";
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
import type { SelectionResult } from "./provider/select.js";
import { appendTelemetryEvent, readTelemetryEvents, type TelemetryEvent, type TelemetryInput } from "./telemetry.js";

type CommandResult = {
  code: number;
};

type SelectCandidate = (input: {
  state: FinishedZState;
  candidates: Candidate[];
  rejectedPaths?: string[];
}) => Promise<SelectionResult>;

type CliDeps = {
  lookupCorrection: (query: string) => Promise<CorrectionLookup>;
  inspectCorrection: (query: string) => Promise<CorrectionInspection>;
  storeCorrection: (input: { query: string; path: string; now?: Date }) => Promise<CorrectionEntry>;
  loadZoxideEntries: () => Promise<ZoxideEntry[]>;
  selectCandidate: SelectCandidate;
  runPicker: (input: PickerInput) => Promise<PickerResult>;
  appendTelemetryEvent: (input: TelemetryInput) => Promise<unknown>;
  readTelemetryEvents: (input?: { limit?: number }) => Promise<TelemetryEvent[]>;
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
      return debugSelectCommand(args);
    case "debug-corrections":
      return debugCorrectionsCommand();
    case "debug-events":
      return debugEventsCommand(args, deps);
    case "debug-timing":
      return debugTimingCommand(args, deps);
    case "forget":
      return forgetCommand(args);
    case "provider-smoke":
      return providerSmokeCommand(args);
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
  cwd: () => process.cwd(),
  now: () => new Date(),
};

function initCommand(args: string[]): CommandResult {
  const [shell] = args;
  if (shell !== "zsh") {
    console.error("zdr: only `zdr init zsh` is scaffolded right now");
    return { code: 2 };
  }

  console.log(zshInitScript());
  return { code: 0 };
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

async function debugSelectCommand(args: string[]): Promise<CommandResult> {
  const limit = parseLimit(args);
  if (!limit.ok) {
    console.error(`zdr: ${limit.error}`);
    return { code: 2 };
  }

  try {
    const { state, result, rejectedPaths } = await runDebugSelection(limit.value);
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
  const data: Record<string, unknown> = {
    query: input.state?.query_argv.join(" ") ?? null,
    mode: input.mode,
    rejected_path_count: input.retry?.rejected_paths.length ?? 0,
    ...(input.selectedPath === undefined ? {} : { selected_path: input.selectedPath }),
    ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
    ...(input.candidateCount === undefined ? {} : { candidate_count: input.candidateCount }),
    ...(input.usage === undefined || input.usage === null ? {} : { usage: input.usage }),
    ...(input.error === undefined ? {} : { error: input.error }),
  };
  try {
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
  const data: Record<string, unknown> = {
    query: input.query,
    cache_status: input.cacheStatus,
    ...(input.selectedPath === undefined ? {} : { selected_path: input.selectedPath }),
    ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
    ...(input.cached === undefined ? {} : { cached: input.cached }),
    ...(input.usage === undefined || input.usage === null ? {} : { usage: input.usage }),
    ...(input.error === undefined ? {} : { error: input.error }),
  };
  try {
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
  const candidates = buildCandidates({
    state,
    entries,
    limit: 50,
  });
  if (candidates.length === 0) {
    throw new Error("no zoxide candidates found");
  }
  return deps.selectCandidate({ state, candidates });
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
  const candidates = buildCandidates({
    state,
    entries,
    limit,
    rejectedPaths,
  });
  const result = await deps.selectCandidate({ state, candidates, rejectedPaths });
  return { candidates, result, rejectedPaths };
}

async function runDebugSelection(limit: number) {
  const state = await readLastZState();
  if (!state) {
    throw new Error("no recorded z attempt found");
  }

  const entries = await loadZoxideEntries();
  const retry = await readRecoveryRetryForAttempt(state);
  const rejectedPaths = retry?.rejected_paths ?? [];
  const candidates = buildCandidates({
    state,
    entries,
    limit,
    rejectedPaths,
  });
  const { selectCandidate } = await import("./provider/select.js");
  const result = await selectCandidate({ state, candidates, rejectedPaths });
  return { state, candidates, result, retry, rejectedPaths };
}

async function providerSmokeCommand(args: string[]): Promise<CommandResult> {
  const { smokePiOpenRouter } = await import("./provider/pi.js");
  return smokePiOpenRouter({ live: args.includes("--live") });
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
  zdr debug-events [--limit <count>]
                      Print local telemetry events as JSON
  zdr debug-timing [query]
                      Measure local timing paths as JSON
  zdr debug-timing [query] --budget-ms <ms>
                      Include local timing budget status in JSON
  zdr forget <query> Remove one exact direct-query correction
  zdr provider-smoke  Verify Pi/OpenRouter import and model lookup
  zdr provider-smoke --live
                      Make a tiny live OpenRouter completion
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
    "    init|record-z|finish-z|clear-recovery-retry|debug-state|debug-candidates|debug-select|debug-corrections|debug-events|debug-timing|forget|provider-smoke|--*|-*)",
    "      command zdr \"$@\"",
    "      return $?",
    "      ;;",
    "  esac",
    "",
    "  local __zdr_target",
    '  __zdr_target=$(command zdr "$@")',
    "  local __zdr_status=$?",
    '  if [ $__zdr_status -eq 0 ] && [ -n "$__zdr_target" ]; then',
    '    cd "$__zdr_target"',
    "    return $?",
    "  fi",
    "  return $__zdr_status",
    "}",
    "",
    "_zdr_preexec() {",
    '  case "$1" in',
    "    zdr) ;;",
    "    *)",
    '      local __zdr_retry="${XDG_STATE_HOME:-$HOME/.local/state}/zdr/recovery_retry.json"',
    '      [[ -e "$__zdr_retry" ]] && rm -f "$__zdr_retry"',
    "      ;;",
    "  esac",
    "}",
    "",
    'if [[ -z "${preexec_functions[(r)_zdr_preexec]}" ]]; then',
    "  preexec_functions+=(_zdr_preexec)",
    "fi",
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
