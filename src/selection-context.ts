import { isAbsolute, normalize, resolve } from "node:path";
import { buildCandidates, shouldAddLocalScanCandidates, type Candidate } from "./candidates.js";
import { DEFAULT_CONFIG, type LoadedConfig, type ZdrConfig } from "./config.js";
import type { CorrectionEntry, CorrectionLookup } from "./corrections.js";
import type { PickerInput, PickerResult } from "./picker.js";
import type { BackendSelectionInput, BackendTierSpec } from "./provider/backends.js";
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
  scanLocalDirectories: (input: {
    query: string;
    roots: string[];
    excludeRoots?: string[];
    maxResults?: number;
  }) => Promise<string[]>;
  selectCandidate: (input: {
    state: FinishedZState;
    candidates: Candidate[];
    rejectedPaths?: string[];
    provider?: ZdrConfig["provider"];
    privacy?: ZdrConfig["privacy"];
    reasoning?: ProviderReasoning;
  }) => Promise<SelectionResult>;
  selectWithBackend: (spec: BackendTierSpec, input: BackendSelectionInput) => Promise<SelectionResult>;
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
  const config = (await input.deps.loadConfig()).config;
  const scope = configuredScanScope(input.state, input.deps, config.context);
  const entries = filterExcludedEntries(input.entries, scope.excludeRoots);
  const baseCandidates = buildCandidates({
    state: input.state,
    entries,
    limit: input.limit,
    rejectedPaths: input.rejectedPaths,
  });
  if (!shouldAddLocalScanCandidates(baseCandidates) && scope.roots.length === 0) {
    return baseCandidates;
  }
  const localPaths = await input.deps.scanLocalDirectories({
    query: input.state.query_argv.join(" ").trim(),
    roots: scope.roots,
    excludeRoots: scope.excludeRoots,
    maxResults: 50,
  });
  if (localPaths.length === 0) {
    return baseCandidates;
  }
  return buildCandidates({
    state: input.state,
    entries,
    localPaths,
    limit: input.limit,
    rejectedPaths: input.rejectedPaths,
  });
}

export type ConfiguredScanScope = {
  roots: string[];
  excludeRoots: string[];
};

export function configuredScanScope(
  _state: FinishedZState,
  deps: Pick<NavigationDeps, "cwd">,
  context: ZdrConfig["context"] = DEFAULT_CONFIG.context,
): ConfiguredScanScope {
  const excludeRoots = uniqueExistingText(context.exclude_dirs.map((path) => resolveConfiguredPath(path, deps)));
  const roots = uniqueExistingText([
    resolveConfiguredPath(context.default_dir, deps),
    ...context.include_dirs.map((path) => resolveConfiguredPath(path, deps)),
  ]).filter((path) => !isPathInsideAny(path, excludeRoots));

  return { roots, excludeRoots };
}

export function pickerScanRoots(
  state: FinishedZState,
  deps: NavigationDeps,
  context: ZdrConfig["context"] = DEFAULT_CONFIG.context,
): string[] {
  return configuredScanScope(state, deps, context).roots;
}

export function filterExcludedEntries(entries: ZoxideEntry[], excludeRoots: string[]): ZoxideEntry[] {
  if (excludeRoots.length === 0) {
    return entries;
  }
  return entries.filter((entry) => !isPathInsideAny(normalizeDirectoryPath(entry.path), excludeRoots));
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

function resolveConfiguredPath(path: string, deps: Pick<NavigationDeps, "cwd">): string {
  if (path === "~") {
    return normalizeDirectoryPath(homeDir());
  }
  if (path.startsWith("~/")) {
    return normalizeDirectoryPath(resolve(homeDir(), path.slice(2)));
  }
  return normalizeDirectoryPath(isAbsolute(path) ? path : resolve(deps.cwd(), path));
}

function homeDir(): string {
  if (process.env.HOME && process.env.HOME.length > 0) {
    return process.env.HOME;
  }
  throw new Error("HOME is required to resolve configured context paths");
}

function normalizeDirectoryPath(path: string): string {
  const normalized = normalize(path);
  return normalized.length > 1 ? normalized.replace(/[\\/]+$/, "") : normalized;
}

function isPathInsideAny(path: string, roots: string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}
