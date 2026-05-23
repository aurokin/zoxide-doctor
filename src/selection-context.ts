import { dirname, parse } from "node:path";
import { buildCandidates, shouldAddLocalScanCandidates, type Candidate } from "./candidates.js";
import type { LoadedConfig, ZdrConfig } from "./config.js";
import type { CorrectionEntry, CorrectionLookup } from "./corrections.js";
import type { PickerInput, PickerResult } from "./picker.js";
import type { ProviderReasoning, SelectionResult } from "./provider/select.js";
import type { FinishedZState } from "./shell-state.js";
import type { TelemetryInput } from "./telemetry.js";
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

export function pickerScanRoots(state: FinishedZState, deps: NavigationDeps): string[] {
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
