import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "./cli.js";
import { readCorrectionCache, storeCorrection, writeCorrectionCache } from "./corrections.js";

let previousXdgCacheHome: string | undefined;
let previousLog: typeof console.log;
let previousError: typeof console.error;
let tempDir: string;
let stdout: string[];
let stderr: string[];

beforeEach(async () => {
  previousXdgCacheHome = process.env.XDG_CACHE_HOME;
  previousLog = console.log;
  previousError = console.error;
  tempDir = await mkdtemp(join(tmpdir(), "zdr-cli-"));
  process.env.XDG_CACHE_HOME = tempDir;
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

  test("fails clearly on direct query cache miss", async () => {
    expect(await main(["ascan"])).toEqual({ code: 1 });

    expect(stdout).toEqual([]);
    expect(stderr).toEqual(['zdr: no cached correction for "ascan"']);
  });

  test("evicts stale direct query cache hits", async () => {
    const stalePath = join(tempDir, "missing");
    await writeCorrectionCache({
      ascan: {
        path: stalePath,
        first_resolved: "2026-05-18T00:00:00.000Z",
        hits: 4,
      },
    });

    expect(await main(["ascan"])).toEqual({ code: 1 });

    expect(stdout).toEqual([]);
    expect(stderr).toEqual(['zdr: cached correction for "ascan" no longer exists']);
    expect(await readCorrectionCache()).toEqual({});
  });
});
