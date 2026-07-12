#!/usr/bin/env bun

// Mine zdr's opt-in local telemetry (recovery / direct-query events) into eval
// *case skeletons*. Output is JSON to stdout, one object per distinct query,
// shaped so a human can curate the interesting ones into src/eval/cases.ts.
//
// Telemetry is local-only (default ~/.local/state/zdr/events.jsonl) and this
// script redacts nothing beyond what telemetry already stores; it only rewrites
// an absolute $HOME prefix in paths back to `~` for readability. See
// src/telemetry.ts for the event schema.

import { readFile } from "node:fs/promises";
import { getTelemetryPaths } from "../src/telemetry.js";

// The subset of the telemetry event shape this script relies on. We re-parse
// the JSONL here (rather than via readTelemetryEvents) so a --file override can
// point at an arbitrary export.
type MinedEvent = {
  kind: string;
  outcome: string;
  data?: Record<string, unknown> | undefined;
};

// One curated-ready skeleton per distinct query.
export type CaseSkeleton = {
  query: string;
  hits: number;
  kinds: string[];
  outcomes: Record<string, number>;
  resolvedPaths: string[];
  // Convenience: the sole resolved path if the query only ever resolved one
  // way (a good `expected:` seed); null when ambiguous or never resolved.
  suggestedExpected: string | null;
};

const MINED_KINDS = new Set(["recovery", "direct-query"]);

// Replace a leading $HOME with `~` for readable, portable paths.
export function withHomeTilde(path: string, home: string): string {
  if (home.length > 0 && (path === home || path.startsWith(`${home}/`))) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

function parseLines(text: string): MinedEvent[] {
  const events: MinedEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      continue;
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.kind !== "string" || typeof record.outcome !== "string") {
      continue;
    }
    const data =
      typeof record.data === "object" && record.data !== null && !Array.isArray(record.data)
        ? (record.data as Record<string, unknown>)
        : undefined;
    events.push({ kind: record.kind, outcome: record.outcome, data });
  }
  return events;
}

// Collapse recovery/direct-query events into one skeleton per distinct query.
export function mineTelemetryCases(events: MinedEvent[], home: string): CaseSkeleton[] {
  const byQuery = new Map<
    string,
    { hits: number; kinds: Set<string>; outcomes: Map<string, number>; resolvedPaths: Set<string> }
  >();

  for (const event of events) {
    if (!MINED_KINDS.has(event.kind)) {
      continue;
    }
    const rawQuery = event.data?.query;
    if (typeof rawQuery !== "string" || rawQuery.trim().length === 0) {
      continue;
    }
    const query = rawQuery;
    const bucket =
      byQuery.get(query) ??
      { hits: 0, kinds: new Set<string>(), outcomes: new Map<string, number>(), resolvedPaths: new Set<string>() };
    bucket.hits += 1;
    bucket.kinds.add(event.kind);
    bucket.outcomes.set(event.outcome, (bucket.outcomes.get(event.outcome) ?? 0) + 1);
    const selected = event.data?.selected_path;
    if (typeof selected === "string" && selected.length > 0) {
      bucket.resolvedPaths.add(withHomeTilde(selected, home));
    }
    byQuery.set(query, bucket);
  }

  const skeletons: CaseSkeleton[] = [];
  for (const [query, bucket] of byQuery) {
    const resolvedPaths = [...bucket.resolvedPaths].sort();
    skeletons.push({
      query,
      hits: bucket.hits,
      kinds: [...bucket.kinds].sort(),
      outcomes: Object.fromEntries([...bucket.outcomes].sort((a, b) => a[0].localeCompare(b[0]))),
      resolvedPaths,
      suggestedExpected: resolvedPaths.length === 1 ? (resolvedPaths[0] ?? null) : null,
    });
  }
  // Most-observed queries first; ties broken by query for stable output.
  skeletons.sort((a, b) => b.hits - a.hits || a.query.localeCompare(b.query));
  return skeletons;
}

function parseArgs(args: string[]): { file: string | null } {
  let file: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--file") {
      const value = args[index + 1];
      if (!value) {
        console.error("telemetry-to-cases: --file requires a path");
        process.exit(2);
      }
      file = value;
      index += 1;
      continue;
    }
    console.error(`telemetry-to-cases: unknown argument '${arg}'`);
    process.exit(2);
  }
  return { file };
}

async function main(): Promise<void> {
  const { file } = parseArgs(process.argv.slice(2));
  const path = file ?? getTelemetryPaths().events;
  const home = process.env.HOME ?? "";

  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      console.error(
        `telemetry-to-cases: no telemetry file at ${withHomeTilde(path, home)}. ` +
          "Enable telemetry and use zdr for a while, or pass --file <path>.",
      );
      console.log("[]");
      return;
    }
    throw error;
  }

  const skeletons = mineTelemetryCases(parseLines(text), home);
  if (skeletons.length === 0) {
    console.error(
      `telemetry-to-cases: no recovery/direct-query events with a query found in ${withHomeTilde(path, home)}.`,
    );
    console.log("[]");
    return;
  }
  console.error(`telemetry-to-cases: mined ${skeletons.length} distinct queries from ${withHomeTilde(path, home)}.`);
  console.log(JSON.stringify(skeletons, null, 2));
}

if (import.meta.main) {
  await main();
}
