import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recoverCommand } from "./recovery.js";
import type { Candidate } from "./candidates.js";
import { DEFAULT_CONFIG } from "./config.js";
import type { NavigationDeps } from "./selection-context.js";
import { finishZAttempt, recordZAttempt } from "./shell-state.js";
import type { TelemetryInput } from "./telemetry.js";

let previousXdgStateHome: string | undefined;
let previousTelemetryEnv: string | undefined;
let previousLog: typeof console.log;
let previousError: typeof console.error;
let tempDir: string;
let stdout: string[];
let stderr: string[];

beforeEach(async () => {
  previousXdgStateHome = process.env.XDG_STATE_HOME;
  previousTelemetryEnv = process.env.ZDR_TELEMETRY;
  previousLog = console.log;
  previousError = console.error;
  tempDir = await mkdtemp(join(tmpdir(), "zdr-recovery-"));
  process.env.XDG_STATE_HOME = tempDir;
  delete process.env.ZDR_TELEMETRY;
  stdout = [];
  stderr = [];
  console.log = (...args: unknown[]) => stdout.push(args.join(" "));
  console.error = (...args: unknown[]) => stderr.push(args.join(" "));
});

afterEach(async () => {
  if (previousXdgStateHome === undefined) {
    delete process.env.XDG_STATE_HOME;
  } else {
    process.env.XDG_STATE_HOME = previousXdgStateHome;
  }
  if (previousTelemetryEnv === undefined) {
    delete process.env.ZDR_TELEMETRY;
  } else {
    process.env.ZDR_TELEMETRY = previousTelemetryEnv;
  }
  console.log = previousLog;
  console.error = previousError;
  await rm(tempDir, { recursive: true, force: true });
});

describe("recovery navigation", () => {
  test("first recovery attempt uses minimal reasoning and writes retry state", async () => {
    const selected = join(tempDir, "agentscan");
    await mkdir(selected);
    await recordFinishedAttempt("attempt-1", join(tempDir, "wrong"), ["ascan"]);

    expect(
      await recoverCommand({
        ...testDeps(),
        loadZoxideEntries: async () => [{ path: selected, score: 10, rank: 1 }],
        selectCandidate: async ({ candidates, reasoning, rejectedPaths }) => {
          expect(reasoning).toBe("minimal");
          expect(rejectedPaths).toEqual([]);
          return selectionResult(candidates[0] ?? null);
        },
      }),
    ).toEqual({ code: 0 });

    expect(stdout).toEqual([selected]);
    expect(stderr).toEqual([]);
  });

  test("second recovery attempt uses high reasoning with rejected path context", async () => {
    const first = join(tempDir, "wrong-agentscan");
    const second = join(tempDir, "agentscan");
    await mkdir(first);
    await mkdir(second);
    await recordFinishedAttempt("attempt-2", join(tempDir, "wrong"), ["ascan"]);
    await recoverCommand({
      ...testDeps(),
      loadZoxideEntries: async () => [{ path: first, score: 10, rank: 1 }],
      selectCandidate: async ({ candidates }) => selectionResult(candidates[0] ?? null),
    });
    stdout = [];
    stderr = [];

    expect(
      await recoverCommand({
        ...testDeps(),
        loadZoxideEntries: async () => [
          { path: first, score: 10, rank: 1 },
          { path: second, score: 9, rank: 2 },
        ],
        selectCandidate: async ({ candidates, reasoning, rejectedPaths }) => {
          expect(reasoning).toBe("high");
          expect(rejectedPaths).toEqual([first]);
          return selectionResult(candidates.find((candidate) => candidate.path === second) ?? null);
        },
      }),
    ).toEqual({ code: 0 });

    expect(stdout).toEqual([second]);
    expect(stderr).toEqual(["zdr: thinking harder..."]);
  });

  test("second attempt routes to the escalation backend when configured", async () => {
    const first = join(tempDir, "wrong-agentscan");
    const second = join(tempDir, "agentscan");
    await mkdir(first);
    await mkdir(second);
    await recordFinishedAttempt("attempt-esc", join(tempDir, "wrong"), ["ascan"]);
    const escalationConfig = {
      path: join(tempDir, "config.json"),
      source: "file" as const,
      config: {
        ...DEFAULT_CONFIG,
        telemetry: { enabled: true, max_events: 1000 },
        escalation: { backend: "claude" as const, model: "sonnet" },
      },
    };
    await recoverCommand({
      ...testDeps({ loadConfig: async () => escalationConfig }),
      loadZoxideEntries: async () => [{ path: first, score: 10, rank: 1 }],
      selectCandidate: async ({ candidates }) => selectionResult(candidates[0] ?? null),
    });
    stdout = [];
    stderr = [];

    let backendSpec: unknown;
    expect(
      await recoverCommand({
        ...testDeps({ loadConfig: async () => escalationConfig }),
        loadZoxideEntries: async () => [
          { path: first, score: 10, rank: 1 },
          { path: second, score: 9, rank: 2 },
        ],
        selectCandidate: async () => {
          throw new Error("fast-tier selection must not run on escalation");
        },
        selectWithBackend: async (spec, { reasoning, rejectedPaths, candidates }) => {
          backendSpec = spec;
          expect(reasoning).toBe("high");
          expect(rejectedPaths).toEqual([first]);
          return selectionResult(candidates.find((candidate) => candidate.path === second) ?? null);
        },
      }),
    ).toEqual({ code: 0 });

    expect(backendSpec).toEqual({ backend: "claude", model: "sonnet" });
    expect(stdout).toEqual([second]);
    expect(stderr).toEqual(["zdr: thinking harder (claude sonnet)..."]);
  });

  test("picker recovery emits picker telemetry when model retries are exhausted", async () => {
    const first = join(tempDir, "first");
    const second = join(tempDir, "second");
    const selected = join(tempDir, "agentscan");
    const telemetry: TelemetryInput[] = [];
    await mkdir(first);
    await mkdir(second);
    await mkdir(selected);
    await recordFinishedAttempt("attempt-3", join(tempDir, "wrong"), ["ascan"]);
    for (const path of [first, second]) {
      await recoverCommand({
        ...testDeps(),
        loadZoxideEntries: async () => [{ path, score: 10, rank: 1 }],
        selectCandidate: async ({ candidates }) => selectionResult(candidates[0] ?? null),
      });
    }
    stdout = [];
    stderr = [];

    expect(
      await recoverCommand({
        ...testDeps({
          appendTelemetryEvent: async (event) => telemetry.push(event),
        }),
        loadZoxideEntries: async () => [{ path: selected, score: 10, rank: 1 }],
        runPicker: async ({ rejectedPaths }) => {
          expect(rejectedPaths).toEqual([first, second]);
          return { status: "selected", path: selected };
        },
      }),
    ).toEqual({ code: 0 });

    expect(stdout).toEqual([selected]);
    expect(stderr).toEqual(["zdr: opening picker..."]);
    expect(telemetry.at(-1)).toMatchObject({
      kind: "recovery",
      outcome: "picker-selected",
      data: {
        selected_path: selected,
        rejected_path_count: 2,
      },
    });
  });
});

describe("recovery correction memory", () => {
  test("injects a remembered correction so the model can select an out-of-db path", async () => {
    const remembered = join(tempDir, "pm64-decomp");
    await mkdir(remembered);
    await recordFinishedAttempt("attempt-inject", join(tempDir, "wrong"), ["papermario"]);

    expect(
      await recoverCommand({
        ...testDeps(),
        loadZoxideEntries: async () => [{ path: join(tempDir, "unrelated"), score: 10, rank: 1 }],
        inspectCorrection: async (query) => ({
          status: "hit",
          query,
          entry: { path: remembered, first_resolved: "2026-05-18T00:00:00.000Z", hits: 5 },
        }),
        selectCandidate: async ({ candidates }) => {
          expect(candidates[0]?.path).toBe(remembered);
          return selectionResult(candidates[0] ?? null);
        },
      }),
    ).toEqual({ code: 0 });

    expect(stdout).toEqual([remembered]);
  });

  test("stores a high-confidence recovery selection", async () => {
    const selected = join(tempDir, "agentscan");
    await mkdir(selected);
    const stored: Array<{ query: string; path: string }> = [];
    await recordFinishedAttempt("attempt-store", join(tempDir, "wrong"), ["ascan"]);

    await recoverCommand({
      ...testDeps(),
      loadZoxideEntries: async () => [{ path: selected, score: 10, rank: 1 }],
      selectCandidate: async ({ candidates }) => selectionResult(candidates[0] ?? null, 0.9),
      storeCorrection: async ({ query, path }) => {
        stored.push({ query, path });
        return { path, first_resolved: "2026-05-18T00:00:00.000Z", hits: 0 };
      },
    });

    expect(stored).toEqual([{ query: "ascan", path: selected }]);
  });

  test("does not store a low-confidence recovery selection", async () => {
    const selected = join(tempDir, "agentscan");
    await mkdir(selected);
    const stored: Array<{ query: string; path: string }> = [];
    await recordFinishedAttempt("attempt-lowconf", join(tempDir, "wrong"), ["ascan"]);

    await recoverCommand({
      ...testDeps(),
      loadZoxideEntries: async () => [{ path: selected, score: 10, rank: 1 }],
      selectCandidate: async ({ candidates }) => selectionResult(candidates[0] ?? null, 0.5),
      storeCorrection: async ({ query, path }) => {
        stored.push({ query, path });
        return { path, first_resolved: "2026-05-18T00:00:00.000Z", hits: 0 };
      },
    });

    expect(stored).toEqual([]);
  });

  test("stores the picker selection as a correction", async () => {
    const first = join(tempDir, "first");
    const second = join(tempDir, "second");
    const selected = join(tempDir, "pm64-decomp");
    const stored: Array<{ query: string; path: string }> = [];
    await mkdir(first);
    await mkdir(second);
    await mkdir(selected);
    await recordFinishedAttempt("attempt-picker-store", join(tempDir, "wrong"), ["papermario"]);
    for (const path of [first, second]) {
      await recoverCommand({
        ...testDeps(),
        loadZoxideEntries: async () => [{ path, score: 10, rank: 1 }],
        selectCandidate: async ({ candidates }) => selectionResult(candidates[0] ?? null),
      });
    }

    await recoverCommand({
      ...testDeps(),
      loadZoxideEntries: async () => [{ path: selected, score: 10, rank: 1 }],
      runPicker: async () => ({ status: "selected", path: selected }),
      storeCorrection: async ({ query, path }) => {
        stored.push({ query, path });
        return { path, first_resolved: "2026-05-18T00:00:00.000Z", hits: 0 };
      },
    });

    expect(stored).toEqual([{ query: "papermario", path: selected }]);
  });

  test("evicts a remembered correction the user just rejected", async () => {
    const rejected = join(tempDir, "wrong-target");
    const second = join(tempDir, "agentscan");
    const forgotten: string[] = [];
    await mkdir(rejected);
    await mkdir(second);
    await recordFinishedAttempt("attempt-evict", join(tempDir, "wrong"), ["ascan"]);
    await recoverCommand({
      ...testDeps(),
      loadZoxideEntries: async () => [{ path: rejected, score: 10, rank: 1 }],
      selectCandidate: async ({ candidates }) => selectionResult(candidates[0] ?? null),
    });

    await recoverCommand({
      ...testDeps(),
      loadZoxideEntries: async () => [{ path: second, score: 9, rank: 2 }],
      inspectCorrection: async (query) => ({
        status: "hit",
        query,
        entry: { path: rejected, first_resolved: "2026-05-18T00:00:00.000Z", hits: 4 },
      }),
      forgetCorrection: async (query) => {
        forgotten.push(query);
        return true;
      },
      selectCandidate: async ({ candidates }) => selectionResult(candidates.find((c) => c.path === second) ?? null),
    });

    expect(forgotten).toEqual(["ascan"]);
  });
});

async function recordFinishedAttempt(attemptId: string, afterPath: string, queryArgv: string[]): Promise<void> {
  await recordZAttempt({
    attemptId,
    beforePwd: tempDir,
    queryArgv,
    shell: "zsh",
  });
  await finishZAttempt({
    attemptId,
    afterPwd: afterPath,
    exitStatus: 0,
  });
}

function testDeps(overrides: Partial<NavigationDeps> = {}): NavigationDeps {
  return {
    lookupCorrection: async (query) => ({ status: "miss", query }),
    inspectCorrection: async (query) => ({ status: "miss", query }),
    storeCorrection: async ({ path }) => ({ path, first_resolved: "2026-05-18T00:00:00.000Z", hits: 0 }),
    forgetCorrection: async () => false,
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
      path: join(tempDir, "config.json"),
      source: "default",
      config: {
        ...DEFAULT_CONFIG,
        telemetry: { enabled: true, max_events: 1000 },
      },
    }),
    cwd: () => tempDir,
    now: () => new Date("2026-05-18T00:00:00.000Z"),
    ...overrides,
  };
}

function selectionResult(candidate: Candidate | null, confidence?: number) {
  return {
    selection: {
      candidate_id: candidate?.id ?? null,
      confidence: candidate ? (confidence ?? 0.8) : 0,
      reason: "selected",
    },
    candidate,
    raw_text: "",
    usage: null,
  };
}
