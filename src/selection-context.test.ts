import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  buildSelectionCandidates,
  configuredScanScope,
  filterExcludedEntries,
  pickerScanRoots,
  type NavigationDeps,
} from "./selection-context.js";
import { DEFAULT_CONFIG } from "./config.js";
import type { FinishedZState } from "./shell-state.js";

describe("selection context", () => {
  test("defaults scan roots to the home directory", () => {
    const state = finishedState({
      before_pwd: "/Users/auro/code/wrong",
      after_pwd: "/Users/auro/code/agentscan",
    });
    const deps = depsWithCwd("/Users/auro/code");
    const home = process.env.HOME;
    if (!home) {
      throw new Error("HOME is required for this test");
    }

    expect(pickerScanRoots(state, deps)).toEqual([home]);
  });

  test("applies default, includes, and excludes in order", () => {
    const state = finishedState();
    const deps = depsWithCwd("/Users/auro/code/zoxide-doctor");
    const home = process.env.HOME;
    if (!home) {
      throw new Error("HOME is required for this test");
    }

    expect(
      configuredScanScope(state, deps, {
        default_dir: "~/code",
        include_dirs: ["~/workspace", "/tmp/private/projects"],
        exclude_dirs: ["~/code/private", "/tmp/private"],
      }),
    ).toEqual({
      roots: [join(home, "code"), join(home, "workspace")],
      excludeRoots: [join(home, "code/private"), "/tmp/private"],
    });
  });

  test("filters zoxide entries inside excluded roots", () => {
    expect(
      filterExcludedEntries(
        [
          { path: "/repo/public", score: 10, rank: 1 },
          { path: "/repo/private/secret", score: 9, rank: 2 },
        ],
        ["/repo/private"],
      ),
    ).toEqual([{ path: "/repo/public", score: 10, rank: 1 }]);
  });

  test("adds configured local scan candidates", async () => {
    const root = "/var/tmp/zdr-selection-context";
    const state = finishedState({
      before_pwd: root,
      after_pwd: join(root, "wrong"),
      query_argv: ["ascan"],
    });
    const scanned = join(root, "agentscan");

    const candidates = await buildSelectionCandidates({
      state,
      entries: [{ path: join(root, "unrelated"), score: 10, rank: 1 }],
      limit: 50,
      rejectedPaths: [],
      deps: {
        ...depsWithCwd(root),
        scanLocalDirectories: async ({ query, roots, maxResults }) => {
          expect(query).toBe("ascan");
          expect(roots).toContain(root);
          expect(maxResults).toBe(50);
          return [scanned];
        },
      },
    });

    expect(candidates.map((candidate) => candidate.path)).toContain(scanned);
    const scannedCandidate = candidates.find((candidate) => candidate.path === scanned);
    expect(scannedCandidate?.zoxide_score).toBe(0);
    expect(scannedCandidate?.path).toBe(scanned);
  });
});

function depsWithCwd(cwd: string): NavigationDeps {
  return {
    lookupCorrection: async () => ({ status: "miss", query: "" }),
    storeCorrection: async () => {
      throw new Error("unexpected correction store");
    },
    loadZoxideEntries: async () => [],
    scanLocalDirectories: async () => [],
    selectCandidate: async () => {
      throw new Error("unexpected model selection");
    },
    selectWithBackend: async () => {
      throw new Error("unexpected backend selection");
    },
    runPicker: async () => {
      throw new Error("unexpected picker");
    },
    appendTelemetryEvent: async () => {},
    loadConfig: async () => ({
      path: join(cwd, "config.json"),
      source: "default",
      config: {
        ...DEFAULT_CONFIG,
        context: { ...DEFAULT_CONFIG.context, default_dir: cwd },
        telemetry: { enabled: true, max_events: 1000 },
      },
    }),
    cwd: () => cwd,
    now: () => new Date("2026-05-18T00:00:00.000Z"),
  };
}

function finishedState(overrides: Partial<FinishedZState> = {}): FinishedZState {
  return {
    schema_version: 1,
    status: "finished",
    attempt_id: "attempt-1",
    query_argv: ["agent"],
    before_pwd: "/tmp/before",
    after_pwd: "/tmp/after",
    exit_status: 0,
    shell: "zsh",
    started_at: "2026-05-18T00:00:00.000Z",
    finished_at: "2026-05-18T00:00:01.000Z",
    ...overrides,
  };
}
