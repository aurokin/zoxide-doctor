import { dirname, parse } from "node:path";
import { buildCandidates, shouldAddLocalScanCandidates, type Candidate } from "./candidates.js";
import type { LoadedConfig, ZdrConfig } from "./config.js";
import type { CorrectionEntry, CorrectionLookup } from "./corrections.js";
import type { PickerInput, PickerResult } from "./picker.js";
import type { ProviderReasoning, SelectionResult } from "./provider/select.js";
import { summarizeProviderUsage } from "./provider/usage.js";
import {
  type FinishedZState,
  readLastZState,
  readRecoveryRetryForAttempt,
  writeRecoveryRetry,
} from "./shell-state.js";
import { telemetryEnabled, type TelemetryInput } from "./telemetry.js";
import type { ZoxideEntry } from "./zoxide.js";

export type NavigationCommandResult = {
  code: number;
};

export type NavigationDeps = {
  lookupCorrection: (query: string) => Promise<CorrectionLookup>;
  storeCorrection: (input: { query: string; path: string; now?: Date }) => Promise<CorrectionEntry>;
  loadZoxideEntries: () => Promise<ZoxideEntry[]>;
  scanLocalDirectories: (input: { query: string; roots: string[]; maxResults?: number }) => Promise<string[]>;
  selectCandidate: (input: {
    state: FinishedZState;
    candidates: Candidate[];
    rejectedPaths?: string[];
    provider?: ZdrConfig["provider"];
    privacy?: ZdrConfig["privacy"];
    reasoning?: ProviderReasoning;
  }) => Promise<SelectionResult>;
  runPicker: (input: PickerInput) => Promise<PickerResult>;
  appendTelemetryEvent: (input: TelemetryInput) => Promise<unknown>;
  loadConfig: () => Promise<LoadedConfig>;
  cwd: () => string;
  now: () => Date;
};

const DIRECT_QUERY_CACHE_CONFIDENCE = 0.75;

export async function recoverCommand(deps: NavigationDeps): Promise<NavigationCommandResult> {
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

export async function directQueryCommand(
  queryArgv: string[],
  deps: NavigationDeps,
): Promise<NavigationCommandResult> {
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

export function directQueryState(queryArgv: string[], deps: NavigationDeps): FinishedZState {
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

export async function runDebugSelection(limit: number, deps: NavigationDeps) {
  const state = await readLastZState();
  if (!state) {
    throw new Error("no recorded z attempt found");
  }

  const entries = await deps.loadZoxideEntries();
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

export async function buildSelectionCandidates(input: {
  state: FinishedZState;
  entries: ZoxideEntry[];
  limit: number;
  rejectedPaths: string[];
  deps: NavigationDeps;
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

async function pickerRecoveryCommand(
  state: FinishedZState,
  retry: NonNullable<Awaited<ReturnType<typeof readRecoveryRetryForAttempt>>>,
  deps: NavigationDeps,
  start: number,
): Promise<NavigationCommandResult> {
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
  deps: NavigationDeps,
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

function pickerScanRoots(state: FinishedZState, deps: NavigationDeps): string[] {
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

async function recordDirectQueryTelemetry(
  deps: NavigationDeps,
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

async function runDirectQuerySelection(queryArgv: string[], deps: NavigationDeps): Promise<SelectionResult> {
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
  deps: NavigationDeps;
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

async function runSelection(
  state: FinishedZState,
  retry: Awaited<ReturnType<typeof readRecoveryRetryForAttempt>>,
  limit: number,
  deps: NavigationDeps,
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

async function telemetryEnabledFromConfig(deps: NavigationDeps): Promise<boolean> {
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

function elapsedMs(start: number): number {
  return Math.max(0, Math.round((performance.now() - start) * 1000) / 1000);
}
