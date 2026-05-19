import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "./cli.js";
import type { Candidate } from "./candidates.js";
import type { CorrectionLookup } from "./corrections.js";
import {
  inspectCorrection,
  readCorrectionCache,
  storeCorrection,
  writeCorrectionCache,
  type CorrectionEntry,
} from "./corrections.js";

let previousXdgCacheHome: string | undefined;
let previousXdgStateHome: string | undefined;
let previousLog: typeof console.log;
let previousError: typeof console.error;
let tempDir: string;
let stdout: string[];
let stderr: string[];

beforeEach(async () => {
  previousXdgCacheHome = process.env.XDG_CACHE_HOME;
  previousXdgStateHome = process.env.XDG_STATE_HOME;
  previousLog = console.log;
  previousError = console.error;
  tempDir = await mkdtemp(join(tmpdir(), "zdr-cli-"));
  process.env.XDG_CACHE_HOME = tempDir;
  process.env.XDG_STATE_HOME = tempDir;
  stdout = [];
  stderr = [];
  console.log = (...args: unknown[]) => {
    stdout.push(args.join(" "));
  };
  console.error = (...args: unknown[]) => {
    stderr.push(args.join(" "));
  };
});

afterEach(async () => {
  if (previousXdgCacheHome === undefined) {
    delete process.env.XDG_CACHE_HOME;
  } else {
    process.env.XDG_CACHE_HOME = previousXdgCacheHome;
  }
  if (previousXdgStateHome === undefined) {
    delete process.env.XDG_STATE_HOME;
  } else {
    process.env.XDG_STATE_HOME = previousXdgStateHome;
  }
  console.log = previousLog;
  console.error = previousError;
  await rm(tempDir, { recursive: true, force: true });
});

describe("main direct query mode", () => {
  test("prints only the cached path on cache hit", async () => {
    const target = join(tempDir, "agentscan");
    await mkdir(target);
    await storeCorrection({
      query: "ascan",
      path: target,
      now: new Date("2026-05-18T00:00:00.000Z"),
    });

    expect(await main(["ascan"])).toEqual({ code: 0 });

    expect(stdout).toEqual([target]);
    expect(stderr).toEqual([]);
    expect((await readCorrectionCache()).ascan?.hits).toBe(1);
  });

  test("joins multi-word direct query arguments for exact cache lookup", async () => {
    const target = join(tempDir, "agent scan");
    await mkdir(target);
    await storeCorrection({
      query: "agent scan",
      path: target,
      now: new Date("2026-05-18T00:00:00.000Z"),
    });

    expect(await main(["agent", "scan"])).toEqual({ code: 0 });

    expect(stdout).toEqual([target]);
    expect(stderr).toEqual([]);
  });

  test("uses model selection on direct query cache miss", async () => {
    const selected = join(tempDir, "agentscan");
    const other = join(tempDir, "other");
    await mkdir(selected);

    expect(
      await main(["ascan"], {
        ...testDeps({ lookup: { status: "miss", query: "ascan" } }),
        loadZoxideEntries: async () => [
          { path: selected, score: 10, rank: 1 },
          { path: other, score: 9, rank: 2 },
        ],
        selectCandidate: async ({ state, candidates }) => {
          expect(state).toMatchObject({
            query_argv: ["ascan"],
            before_pwd: tempDir,
            after_pwd: "",
            shell: "direct-query",
          });
          expect(candidates.map((candidate) => candidate.path)).toContain(selected);
          return selectionResult(candidates.find((candidate) => candidate.path === selected) ?? null);
        },
      }),
    ).toEqual({ code: 0 });

    expect(stdout).toEqual([selected]);
    expect(stderr).toEqual([]);
  });

  test("falls back to model selection after stale direct query cache entry", async () => {
    const stalePath = join(tempDir, "missing");
    const selected = join(tempDir, "agentscan");
    await mkdir(selected);
    await writeCorrectionCache({
      ascan: {
        path: stalePath,
        first_resolved: "2026-05-18T00:00:00.000Z",
        hits: 4,
      },
    });

    expect(
      await main(["ascan"], {
        ...testDeps(),
        loadZoxideEntries: async () => [{ path: selected, score: 10, rank: 1 }],
        selectCandidate: async ({ candidates }) => selectionResult(candidates[0] ?? null),
      }),
    ).toEqual({ code: 0 });

    expect(stdout).toEqual([selected]);
    expect(stderr).toEqual([]);
    expect(await readCorrectionCache()).toEqual({
      ascan: {
        path: selected,
        first_resolved: "2026-05-18T00:00:00.000Z",
        hits: 0,
      },
    });
  });

  test("stores high-confidence model fallback selection in correction cache", async () => {
    const selected = join(tempDir, "agentscan");
    await mkdir(selected);

    expect(
      await main(["ascan"], {
        ...testDeps({ lookup: { status: "miss", query: "ascan" } }),
        loadZoxideEntries: async () => [{ path: selected, score: 10, rank: 1 }],
        selectCandidate: async ({ candidates }) => selectionResult(candidates[0] ?? null, "selected", 0.8),
      }),
    ).toEqual({ code: 0 });

    expect(await readCorrectionCache()).toEqual({
      ascan: {
        path: selected,
        first_resolved: "2026-05-18T00:00:00.000Z",
        hits: 0,
      },
    });
  });

  test("does not store low-confidence model fallback selection", async () => {
    const selected = join(tempDir, "agentscan");
    await mkdir(selected);

    expect(
      await main(["ascan"], {
        ...testDeps({ lookup: { status: "miss", query: "ascan" } }),
        loadZoxideEntries: async () => [{ path: selected, score: 10, rank: 1 }],
        selectCandidate: async ({ candidates }) => selectionResult(candidates[0] ?? null, "selected", 0.74),
      }),
    ).toEqual({ code: 0 });

    expect(stdout).toEqual([selected]);
    expect(stderr).toEqual([]);
    expect(await readCorrectionCache()).toEqual({});
  });

  test("keeps navigation successful when storing correction fails", async () => {
    const selected = join(tempDir, "agentscan");

    expect(
      await main(["ascan"], {
        ...testDeps({
          lookup: { status: "miss", query: "ascan" },
          storeCorrection: async () => {
            throw new Error("cache is read-only");
          },
        }),
        loadZoxideEntries: async () => [{ path: selected, score: 10, rank: 1 }],
        selectCandidate: async ({ candidates }) => selectionResult(candidates[0] ?? null, "selected", 0.8),
      }),
    ).toEqual({ code: 0 });

    expect(stdout).toEqual([selected]);
    expect(stderr).toEqual(["zdr: warning: failed to store correction: cache is read-only"]);
  });

  test("fails clearly when model fallback selects no candidate", async () => {
    expect(
      await main(["ascan"], {
        ...testDeps({ lookup: { status: "miss", query: "ascan" } }),
        loadZoxideEntries: async () => [{ path: join(tempDir, "agentscan"), score: 10, rank: 1 }],
        selectCandidate: async () => selectionResult(null, "no good match"),
      }),
    ).toEqual({ code: 1 });

    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["zdr: no good match"]);
  });
});

describe("main correction cache commands", () => {
  test("prints correction cache JSON", async () => {
    const target = join(tempDir, "agentscan");
    await mkdir(target);
    await storeCorrection({
      query: "ascan",
      path: target,
      now: new Date("2026-05-18T00:00:00.000Z"),
    });

    expect(await main(["debug-corrections"])).toEqual({ code: 0 });

    expect(JSON.parse(stdout.join("\n"))).toEqual({
      ascan: {
        path: target,
        first_resolved: "2026-05-18T00:00:00.000Z",
        hits: 0,
      },
    });
    expect(stderr).toEqual([]);
  });

  test("prints empty correction cache JSON when cache file is missing", async () => {
    expect(await main(["debug-corrections"])).toEqual({ code: 0 });

    expect(stdout).toEqual(["{}"]);
    expect(stderr).toEqual([]);
  });

  test("forgets one exact correction", async () => {
    const firstTarget = join(tempDir, "agentscan");
    const secondTarget = join(tempDir, "agentchat");
    await mkdir(firstTarget);
    await mkdir(secondTarget);
    await storeCorrection({
      query: "ascan",
      path: firstTarget,
      now: new Date("2026-05-18T00:00:00.000Z"),
    });
    await storeCorrection({
      query: "achat",
      path: secondTarget,
      now: new Date("2026-05-18T00:00:00.000Z"),
    });

    expect(await main(["forget", "ascan"])).toEqual({ code: 0 });

    expect(stdout).toEqual([]);
    expect(stderr).toEqual(['zdr: forgot correction for "ascan"']);
    expect(await readCorrectionCache()).toEqual({
      achat: {
        path: secondTarget,
        first_resolved: "2026-05-18T00:00:00.000Z",
        hits: 0,
      },
    });
  });

  test("joins multi-word forget query arguments for exact deletion", async () => {
    const target = join(tempDir, "agent scan");
    await mkdir(target);
    await storeCorrection({
      query: "agent scan",
      path: target,
      now: new Date("2026-05-18T00:00:00.000Z"),
    });

    expect(await main(["forget", "agent", "scan"])).toEqual({ code: 0 });

    expect(await readCorrectionCache()).toEqual({});
  });

  test("fails clearly when forgetting a missing correction", async () => {
    expect(await main(["forget", "ascan"])).toEqual({ code: 1 });

    expect(stdout).toEqual([]);
    expect(stderr).toEqual(['zdr: no cached correction for "ascan"']);
  });

  test("requires a query for forget", async () => {
    expect(await main(["forget"])).toEqual({ code: 2 });

    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["zdr: forget requires a query"]);
  });

  test("zsh init bypasses correction cache commands", async () => {
    expect(await main(["init", "zsh"])).toEqual({ code: 0 });

    const script = stdout.join("\n");
    expect(script).toContain("debug-corrections");
    expect(script).toContain("debug-timing");
    expect(script).toContain("forget");
  });
});

describe("main timing command", () => {
  test("prints local timing JSON with skipped cache lookup when query is omitted", async () => {
    expect(await main(["debug-timing"], testDeps())).toEqual({ code: 0 });

    const payload = JSON.parse(stdout.join("\n")) as TimingPayload;
    expect(payload.schema_version).toBe(1);
    expect(payload.command).toBe("debug-timing");
    expect(payload.measurements.map((measurement) => measurement.name)).toEqual([
      "version",
      "debug-corrections",
      "direct-query-cache-lookup",
      "recovery-context",
    ]);
    expect(payload.measurements.every((measurement) => measurement.duration_ms >= 0)).toBe(true);
    expect(payload.measurements.find((measurement) => measurement.name === "direct-query-cache-lookup")).toMatchObject({
      ok: false,
      skipped: true,
    });
    expect(payload.measurements.find((measurement) => measurement.name === "recovery-context")?.ok).toBe(false);
    expect(stderr).toEqual([]);
  });

  test("measures cache hit and recovery context without provider selection", async () => {
    const target = join(tempDir, "agentscan");
    await mkdir(target);
    await storeCorrection({
      query: "ascan",
      path: target,
      now: new Date("2026-05-18T00:00:00.000Z"),
    });
    await main(["record-z", "--attempt", "timing-1", "--before", tempDir, "--shell", "zsh", "--", "ascan"]);
    await main(["finish-z", "--attempt", "timing-1", "--after", join(tempDir, "wrong"), "--status", "0"]);
    stdout = [];
    stderr = [];

    expect(
      await main(["debug-timing", "ascan"], {
        ...testDeps(),
        loadZoxideEntries: async () => [
          { path: target, score: 10, rank: 1 },
          { path: join(tempDir, "wrong"), score: 9, rank: 2 },
        ],
      }),
    ).toEqual({ code: 0 });

    const payload = JSON.parse(stdout.join("\n")) as TimingPayload;
    expect(payload.measurements.find((measurement) => measurement.name === "direct-query-cache-lookup")).toMatchObject({
      ok: true,
      metadata: {
        query: "ascan",
        status: "hit",
      },
    });
    expect(payload.measurements.find((measurement) => measurement.name === "recovery-context")).toMatchObject({
      ok: true,
      metadata: {
        query: "ascan",
        zoxide_entry_count: 2,
        candidate_count: 2,
        rejected_path_count: 0,
      },
    });
    expect(stderr).toEqual([]);
    expect((await readCorrectionCache()).ascan?.hits).toBe(0);
  });
});

function testDeps(input: { lookup?: CorrectionLookup; storeCorrection?: StoreCorrection } = {}) {
  return {
    lookupCorrection: input.lookup ? async () => input.lookup as CorrectionLookup : readCorrectionFromCache,
    inspectCorrection,
    storeCorrection: input.storeCorrection ?? storeCorrection,
    loadZoxideEntries: async () => {
      throw new Error("unexpected zoxide load");
    },
    selectCandidate: async () => {
      throw new Error("unexpected model selection");
    },
    cwd: () => tempDir,
    now: () => new Date("2026-05-18T00:00:00.000Z"),
  };
}

async function readCorrectionFromCache(query: string): Promise<CorrectionLookup> {
  const { lookupCorrection } = await import("./corrections.js");
  return lookupCorrection(query);
}

type StoreCorrection = (input: { query: string; path: string; now?: Date }) => Promise<CorrectionEntry>;

function selectionResult(candidate: Candidate | null, reason = "selected", confidence = candidate ? 0.8 : 0) {
  return {
    selection: {
      candidate_id: candidate?.id ?? null,
      confidence,
      reason,
    },
    candidate,
    raw_text: "",
    usage: null,
  };
}

type TimingPayload = {
  schema_version: 1;
  command: "debug-timing";
  measurements: Array<{
    name: string;
    ok: boolean;
    skipped?: boolean;
    duration_ms: number;
    metadata?: Record<string, unknown>;
    error?: string;
  }>;
};
