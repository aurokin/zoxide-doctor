import type { ZdrConfig } from "./config.js";

export type DebugEventsArgs = { ok: true; limit?: number } | { ok: false; error: string };

export function parseDebugEventsArgs(args: string[]): DebugEventsArgs {
  let limit: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      return { ok: false, error: "unexpected missing argument" };
    }
    if (arg === "--limit") {
      const value = args[index + 1];
      if (!value) {
        return { ok: false, error: "--limit requires a value" };
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        return { ok: false, error: "--limit must be a positive integer" };
      }
      limit = parsed;
      index += 1;
      continue;
    }
    if (arg.startsWith("--limit=")) {
      const parsed = Number(arg.slice("--limit=".length));
      if (!Number.isInteger(parsed) || parsed < 1) {
        return { ok: false, error: "--limit must be a positive integer" };
      }
      limit = parsed;
      continue;
    }
    return { ok: false, error: `unknown debug-events argument: ${arg}` };
  }

  return limit === undefined ? { ok: true } : { ok: true, limit };
}

export type PruneEventsArgs = { ok: true; maxEvents?: number } | { ok: false; error: string };

export function parsePruneEventsArgs(args: string[]): PruneEventsArgs {
  let maxEvents: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      return { ok: false, error: "unexpected missing argument" };
    }
    if (arg === "--max-events") {
      const value = args[index + 1];
      if (!value || value.trim().length === 0) {
        return { ok: false, error: "--max-events requires a value" };
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) {
        return { ok: false, error: "--max-events must be a non-negative integer" };
      }
      maxEvents = parsed;
      index += 1;
      continue;
    }
    if (arg.startsWith("--max-events=")) {
      const value = arg.slice("--max-events=".length);
      if (!value || value.trim().length === 0) {
        return { ok: false, error: "--max-events requires a value" };
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) {
        return { ok: false, error: "--max-events must be a non-negative integer" };
      }
      maxEvents = parsed;
      continue;
    }
    return { ok: false, error: `unknown prune-events argument: ${arg}` };
  }

  return maxEvents === undefined ? { ok: true } : { ok: true, maxEvents };
}

export type BenchmarkProviderArgs =
  | { ok: true; queryArgv: string[]; repeat: number; jsonl: boolean; provider?: ZdrConfig["provider"] }
  | { ok: false; error: string };

export type BenchmarkSuiteArgs =
  | { ok: true; queryArgv: string[]; repeat: number; jsonl: boolean; providers: ZdrConfig["provider"][] }
  | { ok: false; error: string };

const DEFAULT_PROVIDER_BENCHMARK_REPEAT = 3;
const MAX_PROVIDER_BENCHMARK_REPEAT = 20;

export function parseBenchmarkProviderArgs(args: string[]): BenchmarkProviderArgs {
  const queryArgv: string[] = [];
  let repeat = DEFAULT_PROVIDER_BENCHMARK_REPEAT;
  let providerName: string | undefined;
  let model: string | undefined;
  let jsonl = false;

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
      const parsed = parseProviderBenchmarkRepeat(value);
      if (!parsed.ok) {
        return parsed;
      }
      repeat = parsed.value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--repeat=")) {
      const parsed = parseProviderBenchmarkRepeat(arg.slice("--repeat=".length));
      if (!parsed.ok) {
        return parsed;
      }
      repeat = parsed.value;
      continue;
    }
    if (arg === "--jsonl") {
      jsonl = true;
      continue;
    }
    if (arg === "--provider") {
      const value = args[index + 1];
      if (!value || value.trim().length === 0 || value.startsWith("-")) {
        return { ok: false, error: "--provider requires a value" };
      }
      providerName = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--provider=")) {
      const value = arg.slice("--provider=".length);
      if (value.trim().length === 0) {
        return { ok: false, error: "--provider requires a value" };
      }
      providerName = value;
      continue;
    }
    if (arg === "--model") {
      const value = args[index + 1];
      if (!value || value.trim().length === 0 || value.startsWith("-")) {
        return { ok: false, error: "--model requires a value" };
      }
      model = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--model=")) {
      const value = arg.slice("--model=".length);
      if (value.trim().length === 0) {
        return { ok: false, error: "--model requires a value" };
      }
      model = value;
      continue;
    }
    if (arg.startsWith("-")) {
      return { ok: false, error: `unknown benchmark-provider option: ${arg}` };
    }
    queryArgv.push(arg);
  }

  if ((providerName && !model) || (!providerName && model)) {
    return { ok: false, error: "--provider and --model must be provided together" };
  }

  return providerName && model
    ? { ok: true, queryArgv, repeat, jsonl, provider: { name: providerName, model } }
    : { ok: true, queryArgv, repeat, jsonl };
}

export function parseBenchmarkSuiteArgs(args: string[]): BenchmarkSuiteArgs {
  const queryArgv: string[] = [];
  const providers: ZdrConfig["provider"][] = [];
  let repeat = 1;
  let jsonl = false;

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
      const parsed = parseProviderBenchmarkRepeat(value);
      if (!parsed.ok) {
        return parsed;
      }
      repeat = parsed.value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--repeat=")) {
      const parsed = parseProviderBenchmarkRepeat(arg.slice("--repeat=".length));
      if (!parsed.ok) {
        return parsed;
      }
      repeat = parsed.value;
      continue;
    }
    if (arg === "--jsonl") {
      jsonl = true;
      continue;
    }
    if (arg === "--provider") {
      const value = args[index + 1];
      if (!value || value.trim().length === 0 || value.startsWith("-")) {
        return { ok: false, error: "--provider requires provider:model" };
      }
      const parsed = parseSuiteProvider(value);
      if (!parsed.ok) {
        return parsed;
      }
      providers.push(parsed.provider);
      index += 1;
      continue;
    }
    if (arg.startsWith("--provider=")) {
      const parsed = parseSuiteProvider(arg.slice("--provider=".length));
      if (!parsed.ok) {
        return parsed;
      }
      providers.push(parsed.provider);
      continue;
    }
    if (arg.startsWith("-")) {
      return { ok: false, error: `unknown benchmark-suite option: ${arg}` };
    }
    queryArgv.push(arg);
  }

  return { ok: true, queryArgv, repeat, jsonl, providers: dedupeProviders(providers) };
}

export function defaultBenchmarkSuiteProviders(configuredProvider: ZdrConfig["provider"]): ZdrConfig["provider"][] {
  return [configuredProvider];
}

export type DebugProviderTimingArgs =
  | { ok: true; queryArgv: string[] }
  | { ok: false; error: string };

export function parseDebugProviderTimingArgs(args: string[]): DebugProviderTimingArgs {
  for (const arg of args) {
    if (arg.startsWith("-")) {
      return { ok: false, error: `unknown debug-provider-timing option: ${arg}` };
    }
  }
  return { ok: true, queryArgv: args };
}

export type DebugTimingArgs =
  | { ok: true; queryArgv: string[]; budgetMs?: number }
  | { ok: false; error: string };

export function parseDebugTimingArgs(args: string[]): DebugTimingArgs {
  const queryArgv: string[] = [];
  let budgetMs: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      return { ok: false, error: "unexpected missing argument" };
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
    if (arg.startsWith("--budget-ms=")) {
      const value = arg.slice("--budget-ms=".length);
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return { ok: false, error: "--budget-ms must be a positive number" };
      }
      budgetMs = parsed;
      continue;
    }
    if (arg.startsWith("-")) {
      return { ok: false, error: `unknown debug-timing option: ${arg}` };
    }
    queryArgv.push(arg);
  }

  return budgetMs === undefined ? { ok: true, queryArgv } : { ok: true, queryArgv, budgetMs };
}

export type ConfigProviderArgs = { ok: true; provider: ZdrConfig["provider"] } | { ok: false; error: string };

export function parseConfigProviderArgs(args: string[]): ConfigProviderArgs {
  if (args.length !== 2) {
    return { ok: false, error: "config-provider requires provider and model" };
  }
  const [name, model] = args;
  if (!name || name.startsWith("-")) {
    return { ok: false, error: `unknown config-provider option: ${name ?? ""}` };
  }
  if (!model || model.startsWith("-")) {
    return { ok: false, error: `unknown config-provider option: ${model ?? ""}` };
  }
  return { ok: true, provider: { name, model } };
}

export type ProviderArg = { ok: true; provider: string } | { ok: false; error: string };

export function parseSingleProviderArg(command: string, args: string[]): ProviderArg {
  if (args.length !== 1) {
    return { ok: false, error: `${command} requires exactly one provider` };
  }
  if (args[0]?.startsWith("-")) {
    return { ok: false, error: `unknown ${command} option: ${args[0]}` };
  }
  return { ok: true, provider: args[0] as string };
}

export type RecordZArgs =
  | { ok: true; attemptId: string; beforePwd: string; shell?: string; queryArgv: string[] }
  | { ok: false; error: string };

export function parseRecordZArgs(args: string[]): RecordZArgs {
  let attemptId: string | undefined;
  let beforePwd: string | undefined;
  let shell: string | undefined;
  const queryArgv: string[] = [];
  let passthrough = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      return { ok: false, error: "unexpected missing argument" };
    }
    if (passthrough) {
      queryArgv.push(arg);
      continue;
    }
    if (arg === "--") {
      passthrough = true;
      continue;
    }
    if (arg === "--before") {
      const value = args[index + 1];
      if (!value) {
        return { ok: false, error: "record-z requires a value after --before" };
      }
      beforePwd = value;
      index += 1;
      continue;
    }
    if (arg === "--attempt") {
      const value = args[index + 1];
      if (!value) {
        return { ok: false, error: "record-z requires a value after --attempt" };
      }
      attemptId = value;
      index += 1;
      continue;
    }
    if (arg === "--shell") {
      const value = args[index + 1];
      if (!value) {
        return { ok: false, error: "record-z requires a value after --shell" };
      }
      shell = value;
      index += 1;
      continue;
    }
    return { ok: false, error: `unknown record-z argument: ${arg}` };
  }

  if (!beforePwd) {
    return { ok: false, error: "record-z requires --before <pwd>" };
  }
  if (!attemptId) {
    return { ok: false, error: "record-z requires --attempt <id>" };
  }
  return {
    ok: true,
    attemptId,
    beforePwd,
    queryArgv,
    ...(shell ? { shell } : {}),
  };
}

export type LimitArgs = { ok: true; value: number } | { ok: false; error: string };

export function parseLimit(args: string[]): LimitArgs {
  let value = 50;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--limit") {
      const raw = args[index + 1];
      if (!raw) {
        return { ok: false, error: "limit requires a value after --limit" };
      }
      value = Number.parseInt(raw, 10);
      index += 1;
      continue;
    }
    return { ok: false, error: `unknown debug-candidates argument: ${arg ?? ""}` };
  }
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    return { ok: false, error: "--limit must be between 1 and 200" };
  }
  return { ok: true, value };
}

export type FinishZArgs =
  | { ok: true; attemptId: string; afterPwd: string; exitStatus: number }
  | { ok: false; error: string };

export function parseFinishZArgs(args: string[]): FinishZArgs {
  let attemptId: string | undefined;
  let afterPwd: string | undefined;
  let statusText: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      return { ok: false, error: "unexpected missing argument" };
    }
    if (arg === "--after") {
      const value = args[index + 1];
      if (!value) {
        return { ok: false, error: "finish-z requires a value after --after" };
      }
      afterPwd = value;
      index += 1;
      continue;
    }
    if (arg === "--attempt") {
      const value = args[index + 1];
      if (!value) {
        return { ok: false, error: "finish-z requires a value after --attempt" };
      }
      attemptId = value;
      index += 1;
      continue;
    }
    if (arg === "--status") {
      const value = args[index + 1];
      if (!value) {
        return { ok: false, error: "finish-z requires a value after --status" };
      }
      statusText = value;
      index += 1;
      continue;
    }
    return { ok: false, error: `unknown finish-z argument: ${arg}` };
  }

  if (!afterPwd) {
    return { ok: false, error: "finish-z requires --after <pwd>" };
  }
  if (!attemptId) {
    return { ok: false, error: "finish-z requires --attempt <id>" };
  }
  if (!statusText) {
    return { ok: false, error: "finish-z requires --status <exit_status>" };
  }
  const exitStatus = Number.parseInt(statusText, 10);
  if (!Number.isInteger(exitStatus) || exitStatus < 0) {
    return { ok: false, error: `invalid exit status: ${statusText}` };
  }
  return { ok: true, attemptId, afterPwd, exitStatus };
}

function parseSuiteProvider(value: string): { ok: true; provider: ZdrConfig["provider"] } | { ok: false; error: string } {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    return { ok: false, error: "--provider requires provider:model" };
  }
  const name = value.slice(0, separator).trim();
  const model = value.slice(separator + 1).trim();
  if (!name || !model) {
    return { ok: false, error: "--provider requires provider:model" };
  }
  return { ok: true, provider: { name, model } };
}

function dedupeProviders(providers: ZdrConfig["provider"][]): ZdrConfig["provider"][] {
  const seen = new Set<string>();
  const deduped: ZdrConfig["provider"][] = [];
  for (const provider of providers) {
    const key = `${provider.name}\0${provider.model}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(provider);
  }
  return deduped;
}

function parseProviderBenchmarkRepeat(value: string): { ok: true; value: number } | { ok: false; error: string } {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return { ok: false, error: "--repeat must be a positive integer" };
  }
  if (parsed > MAX_PROVIDER_BENCHMARK_REPEAT) {
    return { ok: false, error: `--repeat must be ${MAX_PROVIDER_BENCHMARK_REPEAT} or less` };
  }
  return { ok: true, value: parsed };
}
