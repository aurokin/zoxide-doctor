import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getCachePaths,
  forgetCorrection,
  lookupCorrection,
  readCorrectionCache,
  storeCorrection,
  writeCorrectionCache,
} from "./corrections.js";

let previousXdgCacheHome: string | undefined;
let tempDir: string;

beforeEach(async () => {
  previousXdgCacheHome = process.env.XDG_CACHE_HOME;
  tempDir = await mkdtemp(join(tmpdir(), "zdr-corrections-"));
  process.env.XDG_CACHE_HOME = tempDir;
});

afterEach(async () => {
  if (previousXdgCacheHome === undefined) {
    delete process.env.XDG_CACHE_HOME;
  } else {
    process.env.XDG_CACHE_HOME = previousXdgCacheHome;
  }
  await rm(tempDir, { recursive: true, force: true });
});

describe("correction cache", () => {
  test("returns an empty cache when the file is missing", async () => {
    expect(await readCorrectionCache()).toEqual({});
  });

  test("stores an exact query mapping and hits it without touching zoxide state", async () => {
    const target = join(tempDir, "agentscan");
    await mkdir(target);

    const entry = await storeCorrection({
      query: "ascan",
      path: target,
      now: new Date("2026-05-18T00:00:00.000Z"),
    });
    const lookup = await lookupCorrection("ascan");

    expect(entry).toEqual({
      path: target,
      first_resolved: "2026-05-18T00:00:00.000Z",
      hits: 0,
    });
    expect(lookup).toEqual({
      status: "hit",
      query: "ascan",
      entry: {
        path: target,
        first_resolved: "2026-05-18T00:00:00.000Z",
        hits: 1,
      },
    });
    expect(await readCorrectionCache()).toEqual({
      ascan: {
        path: target,
        first_resolved: "2026-05-18T00:00:00.000Z",
        hits: 1,
      },
    });
  });

  test("evicts stale paths on lookup", async () => {
    await writeCorrectionCache({
      ascan: {
        path: join(tempDir, "missing"),
        first_resolved: "2026-05-18T00:00:00.000Z",
        hits: 3,
      },
    });

    expect(await lookupCorrection("ascan")).toEqual({
      status: "stale",
      query: "ascan",
      stalePath: join(tempDir, "missing"),
    });
    expect(await readCorrectionCache()).toEqual({});
  });

  test("resets metadata when an exact query is remapped to a different path", async () => {
    const firstTarget = join(tempDir, "first");
    const secondTarget = join(tempDir, "second");
    await mkdir(firstTarget);
    await mkdir(secondTarget);

    await storeCorrection({
      query: "ascan",
      path: firstTarget,
      now: new Date("2026-05-18T00:00:00.000Z"),
    });
    await lookupCorrection("ascan");
    const remapped = await storeCorrection({
      query: "ascan",
      path: secondTarget,
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(remapped).toEqual({
      path: secondTarget,
      first_resolved: "2026-05-19T00:00:00.000Z",
      hits: 0,
    });
  });

  test("writes corrections atomically with private file permissions", async () => {
    const target = join(tempDir, "agentscan");
    await mkdir(target);

    await storeCorrection({
      query: "ascan",
      path: target,
      now: new Date("2026-05-18T00:00:00.000Z"),
    });

    const paths = getCachePaths();
    expect(JSON.parse(await readFile(paths.corrections, "utf8"))).toEqual({
      ascan: {
        path: target,
        first_resolved: "2026-05-18T00:00:00.000Z",
        hits: 0,
      },
    });
    expect((await stat(paths.corrections)).mode & 0o777).toBe(0o600);
  });

  test("rejects corrections for missing target paths", async () => {
    await expect(
      storeCorrection({
        query: "ascan",
        path: join(tempDir, "missing"),
      }),
    ).rejects.toThrow("correction target does not exist");
  });

  test("forgets one exact query mapping", async () => {
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

    expect(await forgetCorrection("ascan")).toBe(true);

    expect(await readCorrectionCache()).toEqual({
      achat: {
        path: secondTarget,
        first_resolved: "2026-05-18T00:00:00.000Z",
        hits: 0,
      },
    });
  });

  test("reports when forgetting a missing query mapping", async () => {
    expect(await forgetCorrection("ascan")).toBe(false);
  });

  test("rejects invalid cache schema", async () => {
    const paths = getCachePaths();
    await mkdir(paths.cacheDir, { recursive: true });
    await writeFile(paths.corrections, '{"ascan":{"path":1,"hits":"many"}}\n');

    await expect(readCorrectionCache()).rejects.toThrow("correction cache did not match expected schema");
  });
});
