#!/usr/bin/env bun

export {};

type TimingRun = {
  index: number;
  exit_code: number;
  wall_ms: number;
  command_total_ms?: number;
  within_budget?: boolean;
  stderr?: string;
};

type TimingPayload = {
  total_duration_ms?: number;
  within_budget?: boolean;
};

const parsed = parseArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(`zdr timing: ${parsed.error}`);
  process.exit(2);
}

const executable = parsed.executable ?? "./dist/zdr";
const runs: TimingRun[] = [];
for (let index = 0; index < parsed.repeat; index += 1) {
  runs.push(await runTiming(index + 1, executable, parsed));
}

const wallTimes = runs.map((run) => run.wall_ms);
const commandTotals = runs
  .map((run) => run.command_total_ms)
  .filter((value): value is number => value !== undefined);

console.log(
  JSON.stringify(
    {
      schema_version: 1,
      command: "timing-baseline",
      executable,
      repeat: parsed.repeat,
      query: parsed.query.length > 0 ? parsed.query.join(" ") : null,
      budget_ms: parsed.budgetMs,
      wall_ms: summarize(wallTimes),
      command_total_ms: commandTotals.length > 0 ? summarize(commandTotals) : null,
      failures: runs.filter((run) => run.exit_code !== 0).length,
      budget_failures: runs.filter((run) => run.within_budget === false).length,
      runs,
    },
    null,
    2,
  ),
);

type ParsedArgs =
  | {
      ok: true;
      repeat: number;
      budgetMs: number;
      executable?: string;
      query: string[];
    }
  | { ok: false; error: string };

function parseArgs(args: string[]): ParsedArgs {
  let repeat = 10;
  let budgetMs = 150;
  let executable: string | undefined;
  const query: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      return { ok: false, error: "unexpected missing argument" };
    }
    if (arg === "--repeat") {
      const value = args[index + 1];
      if (!value) {
        return { ok: false, error: "--repeat requires a value" };
      }
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return { ok: false, error: "--repeat must be a positive integer" };
      }
      repeat = parsed;
      index += 1;
      continue;
    }
    if (arg === "--budget-ms") {
      const value = args[index + 1];
      if (!value) {
        return { ok: false, error: "--budget-ms requires a value" };
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return { ok: false, error: "--budget-ms must be a positive number" };
      }
      budgetMs = parsed;
      index += 1;
      continue;
    }
    if (arg === "--executable") {
      const value = args[index + 1];
      if (!value) {
        return { ok: false, error: "--executable requires a value" };
      }
      executable = value;
      index += 1;
      continue;
    }
    query.push(arg);
  }

  return executable === undefined
    ? { ok: true, repeat, budgetMs, query }
    : { ok: true, repeat, budgetMs, executable, query };
}

async function runTiming(index: number, executable: string, args: Extract<ParsedArgs, { ok: true }>): Promise<TimingRun> {
  const cmd = [
    executable,
    "debug-timing",
    ...args.query,
    "--budget-ms",
    String(args.budgetMs),
  ];
  const start = performance.now();
  const child = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const wallMs = roundMs(performance.now() - start);
  const payload = parseTimingPayload(stdout);
  return {
    index,
    exit_code: exitCode,
    wall_ms: wallMs,
    ...(payload.total_duration_ms === undefined ? {} : { command_total_ms: payload.total_duration_ms }),
    ...(payload.within_budget === undefined ? {} : { within_budget: payload.within_budget }),
    ...(stderr.trim().length === 0 ? {} : { stderr: stderr.trim() }),
  };
}

function parseTimingPayload(stdout: string): TimingPayload {
  try {
    const value = JSON.parse(stdout) as TimingPayload;
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0] ?? 0,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1) ?? 0,
  };
}

function percentile(sortedValues: number[], percentileValue: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const index = Math.min(sortedValues.length - 1, Math.ceil(sortedValues.length * percentileValue) - 1);
  return sortedValues[index] ?? 0;
}

function roundMs(value: number): number {
  return Math.max(0, Math.round(value * 1000) / 1000);
}
