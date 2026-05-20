import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import {
  appendTelemetryEvent,
  getTelemetryPaths,
  pruneTelemetryEvents,
  readTelemetryEvents,
  telemetryEnabled,
} from "./telemetry.js";

let previousXdgStateHome: string | undefined;
let previousTelemetry: string | undefined;
let tempDir: string;

beforeEach(async () => {
  previousXdgStateHome = process.env.XDG_STATE_HOME;
  previousTelemetry = process.env.ZDR_TELEMETRY;
  tempDir = await mkdtemp(join(tmpdir(), "zdr-telemetry-"));
  process.env.XDG_STATE_HOME = tempDir;
  delete process.env.ZDR_TELEMETRY;
});

afterEach(async () => {
  if (previousXdgStateHome === undefined) {
    delete process.env.XDG_STATE_HOME;
  } else {
    process.env.XDG_STATE_HOME = previousXdgStateHome;
  }
  if (previousTelemetry === undefined) {
    delete process.env.ZDR_TELEMETRY;
  } else {
    process.env.ZDR_TELEMETRY = previousTelemetry;
  }
  await rm(tempDir, { recursive: true, force: true });
});

describe("telemetry storage", () => {
  test("appends and reads JSONL events", async () => {
    expect(
      await appendTelemetryEvent({
        kind: "recovery",
        outcome: "selected",
        occurredAt: new Date("2026-05-20T12:00:00.000Z"),
        durationMs: 12.5,
        data: {
          query: "ascan",
          mode: "model",
        },
      }),
    ).toBe("written");

    expect(await readTelemetryEvents()).toEqual([
      {
        schema_version: 1,
        kind: "recovery",
        outcome: "selected",
        occurred_at: "2026-05-20T12:00:00.000Z",
        duration_ms: 12.5,
        data: {
          query: "ascan",
          mode: "model",
        },
      },
    ]);
  });

  test("creates the event file with private permissions", async () => {
    await appendTelemetryEvent({
      kind: "cache",
      outcome: "hit",
      occurredAt: new Date("2026-05-20T12:00:00.000Z"),
    });

    const mode = (await stat(getTelemetryPaths().events)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("returns an empty list when event file is missing", async () => {
    expect(await readTelemetryEvents()).toEqual([]);
  });

  test("skips malformed and schema-mismatched lines", async () => {
    await mkdir(dirname(getTelemetryPaths().events), { recursive: true });
    await writeFile(
      getTelemetryPaths().events,
      [
        "not json",
        JSON.stringify({ schema_version: 1, kind: "cache", outcome: "hit", occurred_at: "2026-05-20T12:00:00.000Z" }),
        JSON.stringify({ schema_version: 2, kind: "cache", outcome: "hit", occurred_at: "2026-05-20T12:00:00.000Z" }),
        JSON.stringify({ schema_version: 1, kind: "unknown", outcome: "hit", occurred_at: "2026-05-20T12:00:00.000Z" }),
      ].join("\n"),
    );

    expect(await readTelemetryEvents()).toEqual([
      {
        schema_version: 1,
        kind: "cache",
        outcome: "hit",
        occurred_at: "2026-05-20T12:00:00.000Z",
      },
    ]);
  });

  test("limits reads to the most recent events", async () => {
    await appendTelemetryEvent({ kind: "cache", outcome: "first", occurredAt: new Date("2026-05-20T12:00:00.000Z") });
    await appendTelemetryEvent({ kind: "cache", outcome: "second", occurredAt: new Date("2026-05-20T12:00:01.000Z") });
    await appendTelemetryEvent({ kind: "cache", outcome: "third", occurredAt: new Date("2026-05-20T12:00:02.000Z") });

    expect((await readTelemetryEvents({ limit: 2 })).map((event) => event.outcome)).toEqual(["second", "third"]);
  });

  test("prunes telemetry to the most recent valid events", async () => {
    await appendTelemetryEvent({ kind: "cache", outcome: "first", occurredAt: new Date("2026-05-20T12:00:00.000Z") });
    await appendTelemetryEvent({ kind: "cache", outcome: "second", occurredAt: new Date("2026-05-20T12:00:01.000Z") });
    await appendTelemetryEvent({ kind: "cache", outcome: "third", occurredAt: new Date("2026-05-20T12:00:02.000Z") });

    expect(await pruneTelemetryEvents({ maxEvents: 2 })).toEqual({
      kept: 2,
      pruned: 1,
      dropped_invalid: 0,
    });

    expect((await readTelemetryEvents()).map((event) => event.outcome)).toEqual(["second", "third"]);
    expect((await stat(getTelemetryPaths().events)).mode & 0o777).toBe(0o600);
  });

  test("pruning drops malformed telemetry records", async () => {
    await mkdir(dirname(getTelemetryPaths().events), { recursive: true });
    await writeFile(
      getTelemetryPaths().events,
      [
        "not json",
        JSON.stringify({ schema_version: 1, kind: "cache", outcome: "hit", occurred_at: "2026-05-20T12:00:00.000Z" }),
      ].join("\n"),
    );

    expect(await pruneTelemetryEvents({ maxEvents: 10 })).toEqual({
      kept: 1,
      pruned: 0,
      dropped_invalid: 1,
    });

    expect(await readTelemetryEvents()).toEqual([
      {
        schema_version: 1,
        kind: "cache",
        outcome: "hit",
        occurred_at: "2026-05-20T12:00:00.000Z",
      },
    ]);
  });

  test("pruning a missing telemetry file is a no-op", async () => {
    expect(await pruneTelemetryEvents({ maxEvents: 2 })).toEqual({
      kept: 0,
      pruned: 0,
      dropped_invalid: 0,
    });
  });

  test("serializes telemetry writes behind the telemetry lock", async () => {
    const paths = getTelemetryPaths();
    await mkdir(dirname(paths.events), { recursive: true });
    await mkdir(`${paths.events}.lock`);

    const append = appendTelemetryEvent({
      kind: "cache",
      outcome: "locked-write",
      occurredAt: new Date("2026-05-20T12:00:00.000Z"),
    });
    await sleep(50);

    expect(await readTelemetryEvents()).toEqual([]);

    await rm(`${paths.events}.lock`, { recursive: true, force: true });
    expect(await append).toBe("written");
    expect((await readTelemetryEvents()).map((event) => event.outcome)).toEqual(["locked-write"]);
  });

  test("treats live owners with invalid created_at as active", async () => {
    const paths = getTelemetryPaths();
    const lockPath = `${paths.events}.lock`;
    await mkdir(dirname(paths.events), { recursive: true });
    await mkdir(lockPath);
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, created_at: "not a date" }));

    const append = appendTelemetryEvent({
      kind: "cache",
      outcome: "invalid-created-at",
      occurredAt: new Date("2026-05-20T12:00:00.000Z"),
    });
    await sleep(50);

    expect(await readTelemetryEvents()).toEqual([]);

    await rm(lockPath, { recursive: true, force: true });
    expect(await append).toBe("written");
    expect((await readTelemetryEvents()).map((event) => event.outcome)).toEqual(["invalid-created-at"]);
  });

  test("reclaims stale telemetry locks", async () => {
    const paths = getTelemetryPaths();
    const lockPath = `${paths.events}.lock`;
    await mkdir(dirname(paths.events), { recursive: true });
    await mkdir(lockPath);
    const staleTime = new Date(Date.now() - 20_000);
    await utimes(lockPath, staleTime, staleTime);

    expect(
      await appendTelemetryEvent({
        kind: "cache",
        outcome: "after-stale-lock",
        occurredAt: new Date("2026-05-20T12:00:00.000Z"),
      }),
    ).toBe("written");

    expect((await readTelemetryEvents()).map((event) => event.outcome)).toEqual(["after-stale-lock"]);
  });

  test("reclaims telemetry locks owned by dead processes", async () => {
    const paths = getTelemetryPaths();
    const lockPath = `${paths.events}.lock`;
    await mkdir(dirname(paths.events), { recursive: true });
    await mkdir(lockPath);
    const ownerPath = join(lockPath, "owner.json");
    await writeFile(ownerPath, JSON.stringify({ pid: 99_999_999 }));

    expect(
      await appendTelemetryEvent({
        kind: "cache",
        outcome: "after-dead-owner-lock",
        occurredAt: new Date("2026-05-20T12:00:00.000Z"),
      }),
    ).toBe("written");

    expect((await readTelemetryEvents()).map((event) => event.outcome)).toEqual(["after-dead-owner-lock"]);
  });

  test("reclaims stale telemetry locks with malformed owner metadata", async () => {
    const paths = getTelemetryPaths();
    const lockPath = `${paths.events}.lock`;
    const ownerPath = join(lockPath, "owner.json");
    await mkdir(dirname(paths.events), { recursive: true });
    await mkdir(lockPath);
    await writeFile(ownerPath, "{");
    const staleTime = new Date(Date.now() - 20_000);
    await utimes(lockPath, staleTime, staleTime);
    await utimes(ownerPath, staleTime, staleTime);

    expect(
      await appendTelemetryEvent({
        kind: "cache",
        outcome: "after-malformed-owner-lock",
        occurredAt: new Date("2026-05-20T12:00:00.000Z"),
      }),
    ).toBe("written");

    expect((await readTelemetryEvents()).map((event) => event.outcome)).toEqual(["after-malformed-owner-lock"]);
  });

  test("reclaims stale telemetry locks with non-positive owner pids", async () => {
    const paths = getTelemetryPaths();
    const lockPath = `${paths.events}.lock`;
    const ownerPath = join(lockPath, "owner.json");
    await mkdir(dirname(paths.events), { recursive: true });
    await mkdir(lockPath);
    await writeFile(ownerPath, JSON.stringify({ pid: 0 }));
    const staleTime = new Date(Date.now() - 20_000);
    await utimes(lockPath, staleTime, staleTime);
    await utimes(ownerPath, staleTime, staleTime);

    expect(
      await appendTelemetryEvent({
        kind: "cache",
        outcome: "after-invalid-pid-lock",
        occurredAt: new Date("2026-05-20T12:00:00.000Z"),
      }),
    ).toBe("written");

    expect((await readTelemetryEvents()).map((event) => event.outcome)).toEqual(["after-invalid-pid-lock"]);
  });

  test("does not write events when telemetry is disabled", async () => {
    process.env.ZDR_TELEMETRY = "0";

    expect(
      await appendTelemetryEvent({
        kind: "recovery",
        outcome: "selected",
      }),
    ).toBe("disabled");
    expect(await readTelemetryEvents()).toEqual([]);
  });

  test("treats false, off, and no as disabled values", () => {
    expect(telemetryEnabled({ ZDR_TELEMETRY: "false" })).toBe(false);
    expect(telemetryEnabled({ ZDR_TELEMETRY: "off" })).toBe(false);
    expect(telemetryEnabled({ ZDR_TELEMETRY: "no" })).toBe(false);
    expect(telemetryEnabled({ ZDR_TELEMETRY: "1" })).toBe(true);
  });
});
