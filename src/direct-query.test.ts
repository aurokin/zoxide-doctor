import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { directQueryCommand, directQueryState } from "./direct-query.js";
import type { Candidate } from "./candidates.js";
import type { NavigationDeps } from "./selection-context.js";
import type { TelemetryInput } from "./telemetry.js";

let previousTelemetryEnv: string | undefined;

beforeEach(() => {
  previousTelemetryEnv = process.env.ZDR_TELEMETRY;
  delete process.env.ZDR_TELEMETRY;
});

afterEach(() => {
  if (previousTelemetryEnv === undefined) {
    delete process.env.ZDR_TELEMETRY;
  } else {
    process.env.ZDR_TELEMETRY = previousTelemetryEnv;
  }
});

describe("direct query navigation", () => {
  test("builds a synthetic direct-query state from argv and cwd", () => {
    const deps = testDeps({ cwd: "/repo", now: new Date("2026-05-18T12:00:00.000Z") });

    expect(directQueryState(["agent", "scan"], deps)).toEqual({
      schema_version: 1,
      status: "finished",
      attempt_id: "direct-query",
      query_argv: ["agent", "scan"],
      before_pwd: "/repo",
      after_pwd: "",
      exit_status: 0,
      shell: "direct-query",
      started_at: "2026-05-18T12:00:00.000Z",
      finished_at: "2026-05-18T12:00:00.000Z",
    });
  });

  test("uses cache hits without loading zoxide or selecting a model", async () => {
    const selected = "/repo/agentscan";
    const stdout: string[] = [];
    const telemetry: TelemetryInput[] = [];
    const previousLog = console.log;
    console.log = (...args: unknown[]) => stdout.push(args.join(" "));
    try {
      const result = await directQueryCommand(
        ["ascan"],
        testDeps({
          lookupCorrection: async () => ({
            status: "hit",
            query: "ascan",
            entry: {
              path: selected,
              query: "ascan",
              hits: 0,
              created_at: "2026-05-18T00:00:00.000Z",
              updated_at: "2026-05-18T00:00:00.000Z",
              last_used_at: null,
              first_resolved: "2026-05-18T00:00:00.000Z",
            },
          }),
          appendTelemetryEvent: async (event) => telemetry.push(event),
          loadZoxideEntries: async () => {
            throw new Error("zoxide should not load on cache hit");
          },
          selectCandidate: async () => {
            throw new Error("model should not run on cache hit");
          },
        }),
      );

      expect(result).toEqual({ code: 0 });
      expect(stdout).toEqual([selected]);
      expect(telemetry).toEqual([
        {
          kind: "direct-query",
          outcome: "cache-hit",
          durationMs: expect.any(Number),
          data: {
            query: "ascan",
            cache_status: "hit",
            selected_path: selected,
            cached: true,
          },
        },
      ]);
    } finally {
      console.log = previousLog;
    }
  });

  test("stores high-confidence model selections in the correction cache", async () => {
    const selected = "/repo/agentscan";
    const stored: Array<{ query: string; path: string; now?: Date }> = [];
    const previousLog = console.log;
    console.log = () => {};
    try {
      const result = await directQueryCommand(
        ["ascan"],
        testDeps({
          loadZoxideEntries: async () => [{ path: selected, score: 10, rank: 1 }],
          selectCandidate: async ({ candidates }) => selectionResult(candidates[0] ?? null, 0.9),
          storeCorrection: async (input) => {
            stored.push(input);
            return {
              query: input.query,
              path: input.path,
              hits: 0,
              created_at: "2026-05-18T00:00:00.000Z",
              updated_at: "2026-05-18T00:00:00.000Z",
              last_used_at: null,
              first_resolved: "2026-05-18T00:00:00.000Z",
            };
          },
        }),
      );

      expect(result).toEqual({ code: 0 });
      expect(stored).toEqual([
        {
          query: "ascan",
          path: selected,
          now: new Date("2026-05-18T00:00:00.000Z"),
        },
      ]);
    } finally {
      console.log = previousLog;
    }
  });
});

function testDeps(overrides: Partial<Omit<NavigationDeps, "cwd" | "now">> & { cwd?: string; now?: Date } = {}): NavigationDeps {
  const { cwd = "/repo", now = new Date("2026-05-18T00:00:00.000Z"), ...depsOverrides } = overrides;
  return {
    lookupCorrection: async (query) => ({ status: "miss", query }),
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
      path: "/repo/.zdr/config.json",
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
    ...depsOverrides,
    cwd: () => cwd,
    now: () => now,
  };
}

function selectionResult(candidate: Candidate | null, confidence: number) {
  return {
    selection: {
      candidate_id: candidate?.id ?? null,
      confidence,
      reason: "selected",
    },
    candidate,
    raw_text: "",
    usage: null,
  };
}
