import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recoverCommand } from "./recovery.js";
import type { Candidate } from "./candidates.js";
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
      path: join(tempDir, "config.json"),
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
    cwd: () => tempDir,
    now: () => new Date("2026-05-18T00:00:00.000Z"),
    ...overrides,
  };
}

function selectionResult(candidate: Candidate | null) {
  return {
    selection: {
      candidate_id: candidate?.id ?? null,
      confidence: candidate ? 0.8 : 0,
      reason: "selected",
    },
    candidate,
    raw_text: "",
    usage: null,
  };
}
