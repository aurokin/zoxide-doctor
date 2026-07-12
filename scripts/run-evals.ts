#!/usr/bin/env bun

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderReasoning } from "../src/provider/select.js";
import { CASES, CATEGORIES, type EvalCase, type EvalCategory } from "../src/eval/cases.js";
import { materializeFixture } from "../src/eval/fixture.js";
import { formatLiveReport, formatRecallReport } from "../src/eval/format.js";
import {
  createLiveBackend,
  parseBackendSpec,
  runLive,
  runRecall,
} from "../src/eval/runner.js";

const REASONING_LEVELS: ProviderReasoning[] = ["minimal", "low", "medium", "high", "xhigh"];

type ParsedArgs =
  | {
      ok: true;
      live: boolean;
      backends: string[];
      repeat: number;
      concurrency: number;
      caseIds: string[] | null;
      category: EvalCategory | null;
      reasoning: ProviderReasoning | null;
      jsonlPath: string | null;
    }
  | { ok: false; error: string };

const parsed = parseArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(`run-evals: ${parsed.error}`);
  process.exit(2);
}

const cases = filterCases(CASES, parsed.caseIds, parsed.category);
if (cases.length === 0) {
  console.error("run-evals: no cases matched the given filters");
  process.exit(2);
}

const fixtureDir = await mkdtemp(join(tmpdir(), "zdr-eval-"));
try {
  const fixture = await materializeFixture(fixtureDir);
  if (parsed.live) {
    await runLiveMode(fixture.root, cases, parsed);
  } else {
    const report = runRecall(cases, fixture.root);
    console.log(formatRecallReport(report));
    if (parsed.jsonlPath) {
      await writeJsonl(parsed.jsonlPath, [...report.cases, ...report.nullCases]);
    }
  }
} finally {
  await rm(fixtureDir, { recursive: true, force: true });
}

async function runLiveMode(fixtureRoot: string, selected: EvalCase[], args: Extract<ParsedArgs, { ok: true }>): Promise<void> {
  if (process.env.ZDR_EVAL_LIVE !== "1") {
    console.error("run-evals: --live refuses to run unless ZDR_EVAL_LIVE=1 (live mode makes real provider calls)");
    process.exit(2);
  }
  if (args.backends.length === 0) {
    console.error("run-evals: --live requires at least one --backend spec (pi:<provider>:<model> or claude:<model>)");
    process.exit(2);
  }
  const backends = args.backends.map((spec) => createLiveBackend(parseBackendSpec(spec)));
  const report = await runLive(backends, selected, fixtureRoot, {
    repeat: args.repeat,
    concurrency: args.concurrency,
    ...(args.reasoning ? { reasoning: args.reasoning } : {}),
    onRecord: (record) => {
      const status = record.error ? `ERROR ${record.error}` : record.correct ? "ok" : "miss";
      console.error(`[${record.backendId}] ${record.caseId} #${record.repeat} ${status} (${record.latencyMs}ms)`);
    },
  });
  console.log(formatLiveReport(report));
  if (args.jsonlPath) {
    await writeJsonl(args.jsonlPath, report.records);
  }
}

async function writeJsonl(path: string, records: unknown[]): Promise<void> {
  await writeFile(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  console.error(`run-evals: wrote ${records.length} records to ${path}`);
}

function filterCases(all: EvalCase[], ids: string[] | null, category: EvalCategory | null): EvalCase[] {
  return all.filter((evalCase) => {
    if (ids && !ids.includes(evalCase.id)) {
      return false;
    }
    if (category && evalCase.category !== category) {
      return false;
    }
    return true;
  });
}

function parseArgs(args: string[]): ParsedArgs {
  let live = false;
  const backends: string[] = [];
  let repeat = 1;
  let concurrency = 1;
  let caseIds: string[] | null = null;
  let category: EvalCategory | null = null;
  let reasoning: ProviderReasoning | null = null;
  let jsonlPath: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      return { ok: false, error: "unexpected missing argument" };
    }
    if (arg === "--live") {
      live = true;
      continue;
    }
    if (arg === "--backend") {
      const value = args[index + 1];
      if (!value) {
        return { ok: false, error: "--backend requires a value" };
      }
      backends.push(value);
      index += 1;
      continue;
    }
    if (arg === "--repeat") {
      const value = args[index + 1];
      const number = value ? Number.parseInt(value, 10) : NaN;
      if (!Number.isInteger(number) || number <= 0) {
        return { ok: false, error: "--repeat must be a positive integer" };
      }
      repeat = number;
      index += 1;
      continue;
    }
    if (arg === "--concurrency") {
      const value = args[index + 1];
      const number = value ? Number.parseInt(value, 10) : NaN;
      if (!Number.isInteger(number) || number <= 0) {
        return { ok: false, error: "--concurrency must be a positive integer" };
      }
      concurrency = number;
      index += 1;
      continue;
    }
    if (arg === "--cases") {
      const value = args[index + 1];
      if (!value) {
        return { ok: false, error: "--cases requires a comma-separated list of case ids" };
      }
      caseIds = value.split(",").map((id) => id.trim()).filter((id) => id.length > 0);
      index += 1;
      continue;
    }
    if (arg === "--category") {
      const value = args[index + 1];
      if (!value || !CATEGORIES.includes(value as EvalCategory)) {
        return { ok: false, error: `--category must be one of: ${CATEGORIES.join(", ")}` };
      }
      category = value as EvalCategory;
      index += 1;
      continue;
    }
    if (arg === "--reasoning") {
      const value = args[index + 1];
      if (!value || !REASONING_LEVELS.includes(value as ProviderReasoning)) {
        return { ok: false, error: `--reasoning must be one of: ${REASONING_LEVELS.join(", ")}` };
      }
      reasoning = value as ProviderReasoning;
      index += 1;
      continue;
    }
    if (arg === "--jsonl") {
      const value = args[index + 1];
      if (!value) {
        return { ok: false, error: "--jsonl requires a path" };
      }
      jsonlPath = value;
      index += 1;
      continue;
    }
    return { ok: false, error: `unknown argument '${arg}'` };
  }

  return { ok: true, live, backends, repeat, concurrency, caseIds, category, reasoning, jsonlPath };
}
