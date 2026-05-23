import type { Candidate } from "./candidates.js";
import { loadConfig, setProviderConfig, type LoadedConfig, type ZdrConfig } from "./config.js";
import {
  inspectCorrection,
  lookupCorrection,
  storeCorrection,
  type CorrectionEntry,
  type CorrectionInspection,
  type CorrectionLookup,
} from "./corrections.js";
import { scanLocalDirectories } from "./local-scan.js";
import type { PickerInput, PickerResult } from "./picker.js";
import type { OAuthLoginCallbacks, ProviderAuthStatus } from "./provider/auth.js";
import type { ProviderReasoning, SelectionResult } from "./provider/select.js";
import type { FinishedZState } from "./shell-state.js";
import {
  appendTelemetryEvent,
  pruneTelemetryEvents,
  readTelemetryEvents,
  type TelemetryEvent,
  type TelemetryInput,
  type TelemetryPruneResult,
} from "./telemetry.js";
import { loadZoxideEntries, type ZoxideEntry } from "./zoxide.js";

export type SelectCandidate = (input: {
  state: FinishedZState;
  candidates: Candidate[];
  rejectedPaths?: string[];
  provider?: ZdrConfig["provider"];
  privacy?: ZdrConfig["privacy"];
  reasoning?: ProviderReasoning;
}) => Promise<SelectionResult>;

export type CliDeps = {
  lookupCorrection: (query: string) => Promise<CorrectionLookup>;
  inspectCorrection: (query: string) => Promise<CorrectionInspection>;
  storeCorrection: (input: { query: string; path: string; now?: Date }) => Promise<CorrectionEntry>;
  loadZoxideEntries: () => Promise<ZoxideEntry[]>;
  scanLocalDirectories: (input: {
    query: string;
    roots: string[];
    excludeRoots?: string[];
    maxResults?: number;
  }) => Promise<string[]>;
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

export const defaultDeps: CliDeps = {
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

function commandExists(command: string): boolean {
  const result = Bun.spawnSync({
    cmd: ["bash", "-lc", `command -v "$1" >/dev/null`, "bash", command],
    stdout: "ignore",
    stderr: "ignore",
  });
  return result.exitCode === 0;
}
