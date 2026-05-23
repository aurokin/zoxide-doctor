import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildSelectionCandidates, pickerScanRoots, type NavigationDeps } from "./selection-context.js";
import type { FinishedZState } from "./shell-state.js";

describe("selection context", () => {
  test("dedupes picker scan roots and filters broad home parents", () => {
    const state = finishedState({
      before_pwd: "/Users/auro/code/wrong",
      after_pwd: "/Users/auro/code/agentscan",
    });
    const deps = depsWithCwd("/Users/auro/code");

    expect(pickerScanRoots(state, deps)).toEqual([
      "/Users/auro/code",
      "/Users/auro/code/wrong",
      "/Users/auro/code/agentscan",
    ]);
  });

  test("adds local scan candidates when zoxide candidates are weak", async () => {
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
    runPicker: async () => {
      throw new Error("unexpected picker");
    },
    appendTelemetryEvent: async () => {},
    loadConfig: async () => ({
      path: join(cwd, "config.json"),
      source: "default",
      config: {
        schema_version: 1,
        provider: { name: "openrouter", model: "google/gemini-2.5-flash-lite" },
        privacy: {
          redact_home: true,
          redact_emails: true,
          redact_secrets: true,
          redact_tokens: true,
        },
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
