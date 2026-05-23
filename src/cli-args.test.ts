import { describe, expect, test } from "bun:test";
import {
  defaultBenchmarkSuiteProviders,
  parseBenchmarkProviderArgs,
  parseBenchmarkSuiteArgs,
  parseConfigProviderArgs,
  parseDebugEventsArgs,
  parseDebugProviderTimingArgs,
  parseDebugTimingArgs,
  parseFinishZArgs,
  parseLimit,
  parseOptionalProviderArg,
  parsePruneEventsArgs,
  parseRecordZArgs,
  parseSingleProviderArg,
} from "./cli-args.js";

describe("cli arg parsers", () => {
  test("parses debug-events limit", () => {
    expect(parseDebugEventsArgs(["--limit=2"])).toEqual({ ok: true, limit: 2 });
    expect(parseDebugEventsArgs(["--limit", "0"])).toEqual({
      ok: false,
      error: "--limit must be a positive integer",
    });
  });

  test("parses prune-events max event count", () => {
    expect(parsePruneEventsArgs(["--max-events", "0"])).toEqual({ ok: true, maxEvents: 0 });
    expect(parsePruneEventsArgs(["--max-events="])).toEqual({
      ok: false,
      error: "--max-events requires a value",
    });
  });

  test("parses benchmark-provider options", () => {
    expect(
      parseBenchmarkProviderArgs([
        "ascan",
        "--repeat=2",
        "--jsonl",
        "--provider",
        "openai-codex",
        "--model",
        "gpt-5.3-codex-spark",
      ]),
    ).toEqual({
      ok: true,
      queryArgv: ["ascan"],
      repeat: 2,
      jsonl: true,
      provider: { name: "openai-codex", model: "gpt-5.3-codex-spark" },
    });
    expect(parseBenchmarkProviderArgs(["--model=fast", "ascan"])).toEqual({
      ok: false,
      error: "--provider and --model must be provided together",
    });
  });

  test("parses and dedupes benchmark-suite providers", () => {
    expect(
      parseBenchmarkSuiteArgs([
        "--provider=openai-codex:gpt-5.3-codex-spark",
        "--provider=openai-codex:gpt-5.3-codex-spark",
        "ascan",
      ]),
    ).toEqual({
      ok: true,
      queryArgv: ["ascan"],
      repeat: 1,
      jsonl: false,
      providers: [{ name: "openai-codex", model: "gpt-5.3-codex-spark" }],
    });
  });

  test("uses configured provider as default benchmark suite provider", () => {
    expect(defaultBenchmarkSuiteProviders({ name: "openrouter", model: "google/gemini-2.5-flash-lite" })).toEqual([
      { name: "openrouter", model: "google/gemini-2.5-flash-lite" },
    ]);
  });

  test("parses debug-timing budget", () => {
    expect(parseDebugTimingArgs(["ascan", "--budget-ms=150"])).toEqual({
      ok: true,
      queryArgv: ["ascan"],
      budgetMs: 150,
    });
  });

  test("parses shell-state record and finish commands", () => {
    expect(parseRecordZArgs(["--attempt", "a1", "--before", "/tmp", "--shell", "zsh", "--", "agent", "scan"])).toEqual({
      ok: true,
      attemptId: "a1",
      beforePwd: "/tmp",
      shell: "zsh",
      queryArgv: ["agent", "scan"],
    });
    expect(parseFinishZArgs(["--attempt", "a1", "--after", "/tmp", "--status", "7"])).toEqual({
      ok: true,
      attemptId: "a1",
      afterPwd: "/tmp",
      exitStatus: 7,
    });
  });

  test("parses bounded debug candidate limit", () => {
    expect(parseLimit(["--limit", "201"])).toEqual({
      ok: false,
      error: "--limit must be between 1 and 200",
    });
  });

  test("parses provider configuration commands", () => {
    expect(parseConfigProviderArgs(["openai-codex", "gpt-5.3-codex-spark"])).toEqual({
      ok: true,
      provider: { name: "openai-codex", model: "gpt-5.3-codex-spark" },
    });
    expect(parseSingleProviderArg("provider-login", ["openai-codex"])).toEqual({
      ok: true,
      provider: "openai-codex",
    });
    expect(parseOptionalProviderArg("provider-list", [])).toEqual({ ok: true });
    expect(parseOptionalProviderArg("provider-list", ["openrouter"])).toEqual({
      ok: true,
      provider: "openrouter",
    });
  });

  test("rejects unsupported debug-provider-timing options", () => {
    expect(parseDebugProviderTimingArgs(["--live"])).toEqual({
      ok: false,
      error: "unknown debug-provider-timing option: --live",
    });
  });
});
