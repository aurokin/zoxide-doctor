import type { CorrectionLookup } from "./corrections.js";
import type { SelectionResult } from "./provider/select.js";
import { summarizeProviderUsage } from "./provider/usage.js";
import {
  buildSelectionCandidates,
  type NavigationCommandResult,
  type NavigationDeps,
} from "./selection-context.js";
import type { FinishedZState } from "./shell-state.js";
import { telemetryEnabled } from "./telemetry.js";

const DIRECT_QUERY_CACHE_CONFIDENCE = 0.75;

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
