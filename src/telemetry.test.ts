import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendTelemetryEvent,
  getTelemetryPaths,
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
