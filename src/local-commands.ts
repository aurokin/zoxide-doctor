import { buildCandidates } from "./candidates.js";
import type { LoadedConfig } from "./config.js";
import { parseDebugEventsArgs, parseLimit, parsePruneEventsArgs } from "./cli-args.js";
import { forgetCorrection, readCorrectionCache } from "./corrections.js";
import { runDebugSelection } from "./recovery.js";
import type { NavigationDeps } from "./selection-context.js";
import { readLastZState } from "./shell-state.js";
import type { TelemetryEvent, TelemetryPruneResult } from "./telemetry.js";
import type { ZoxideEntry } from "./zoxide.js";

export type LocalCommandResult = {
  code: number;
};

export type LocalCommandDeps = NavigationDeps & {
  loadZoxideEntries: () => Promise<ZoxideEntry[]>;
  loadConfig: () => Promise<LoadedConfig>;
  readTelemetryEvents: (input?: { limit?: number }) => Promise<TelemetryEvent[]>;
  pruneTelemetryEvents: (input: { maxEvents: number }) => Promise<TelemetryPruneResult>;
};

export async function debugStateCommand(): Promise<LocalCommandResult> {
  const state = await readLastZState();
  if (!state) {
    console.error("zdr: no recorded z attempt found");
    return { code: 1 };
  }
  console.log(JSON.stringify(state, null, 2));
  return { code: 0 };
}

export async function debugCandidatesCommand(args: string[], deps: LocalCommandDeps): Promise<LocalCommandResult> {
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
    const entries = await deps.loadZoxideEntries();
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

export async function debugSelectCommand(args: string[], deps: LocalCommandDeps): Promise<LocalCommandResult> {
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

export async function debugCorrectionsCommand(): Promise<LocalCommandResult> {
  try {
    console.log(JSON.stringify(await readCorrectionCache(), null, 2));
    return { code: 0 };
  } catch (error) {
    console.error(`zdr: ${error instanceof Error ? error.message : String(error)}`);
    return { code: 1 };
  }
}

export async function debugConfigCommand(deps: LocalCommandDeps): Promise<LocalCommandResult> {
  try {
    console.log(JSON.stringify(await deps.loadConfig(), null, 2));
    return { code: 0 };
  } catch (error) {
    console.error(`zdr: ${error instanceof Error ? error.message : String(error)}`);
    return { code: 1 };
  }
}

export async function debugEventsCommand(args: string[], deps: LocalCommandDeps): Promise<LocalCommandResult> {
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

export async function pruneEventsCommand(args: string[], deps: LocalCommandDeps): Promise<LocalCommandResult> {
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

export async function forgetCommand(args: string[]): Promise<LocalCommandResult> {
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
