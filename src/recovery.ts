import type { SelectionResult } from "./provider/select.js";
import { summarizeProviderUsage } from "./provider/usage.js";
import {
  buildSelectionCandidates,
  configuredScanScope,
  filterExcludedEntries,
  type NavigationCommandResult,
  type NavigationDeps,
} from "./selection-context.js";
import {
  type FinishedZState,
  readLastZState,
  readRecoveryRetryForAttempt,
  writeRecoveryRetry,
} from "./shell-state.js";
import { telemetryEnabled } from "./telemetry.js";

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

async function pickerRecoveryCommand(
  state: FinishedZState,
  retry: NonNullable<Awaited<ReturnType<typeof readRecoveryRetryForAttempt>>>,
  deps: NavigationDeps,
  start: number,
): Promise<NavigationCommandResult> {
  const entries = await deps.loadZoxideEntries();
  const config = (await deps.loadConfig()).config;
  const scope = configuredScanScope(state, deps, config.context);
  console.error("zdr: opening picker...");
  const result = await deps.runPicker({
    query: state.query_argv.join(" "),
    zoxideEntries: filterExcludedEntries(entries, scope.excludeRoots),
    rejectedPaths: retry.rejected_paths,
    scanRoots: scope.roots,
    excludeScanRoots: scope.excludeRoots,
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
