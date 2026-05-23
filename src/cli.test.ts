import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "./cli.js";
import type { Candidate } from "./candidates.js";
import type { LoadedConfig } from "./config.js";
import type { CorrectionLookup } from "./corrections.js";
import {
  inspectCorrection,
  readCorrectionCache,
  storeCorrection,
  writeCorrectionCache,
  type CorrectionEntry,
} from "./corrections.js";
import type { PickerInput, PickerResult } from "./picker.js";
import type { OAuthLoginCallbacks, ProviderAuthStatus } from "./provider/auth.js";
import type { TelemetryEvent, TelemetryInput, TelemetryPruneResult } from "./telemetry.js";

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
    const telemetry: TelemetryInput[] = [];
    await mkdir(target);
    await storeCorrection({
      query: "ascan",
      path: target,
      now: new Date("2026-05-18T00:00:00.000Z"),
    });

    expect(await main(["ascan"], testDeps({ appendTelemetryEvent: async (event) => telemetry.push(event) }))).toEqual({ code: 0 });

    expect(stdout).toEqual([target]);
    expect(stderr).toEqual([]);
    expect((await readCorrectionCache()).ascan?.hits).toBe(1);
    expect(telemetry).toEqual([
      {
        kind: "direct-query",
        outcome: "cache-hit",
        durationMs: expect.any(Number),
        data: {
          query: "ascan",
          cache_status: "hit",
          selected_path: target,
          cached: true,
        },
      },
    ]);
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
    const telemetry: TelemetryInput[] = [];
    await mkdir(selected);

    expect(
      await main(["ascan"], {
        ...testDeps({
          lookup: { status: "miss", query: "ascan" },
          appendTelemetryEvent: async (event) => telemetry.push(event),
        }),
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
    expect(telemetry).toEqual([
      {
        kind: "direct-query",
        outcome: "selected",
        durationMs: expect.any(Number),
        data: {
          query: "ascan",
          cache_status: "miss",
          selected_path: selected,
          confidence: 0.8,
          cached: true,
        },
      },
    ]);
  });

  test("adds local scan candidates for weak direct query zoxide matches", async () => {
    const selected = join(tempDir, "agentscan");
    await mkdir(selected);

    expect(
      await main(["ascan"], {
        ...testDeps({
          lookup: { status: "miss", query: "ascan" },
          scanLocalDirectories: async (input) => {
            expect(input.query).toBe("ascan");
            expect(input.roots).toContain(tempDir);
            return [selected];
          },
        }),
        loadZoxideEntries: async () => [{ path: join(tempDir, "unrelated"), score: 10, rank: 1 }],
        selectCandidate: async ({ candidates }) => {
          expect(candidates.map((candidate) => candidate.path)).toContain(selected);
          return selectionResult(candidates.find((candidate) => candidate.path === selected) ?? null);
        },
      }),
    ).toEqual({ code: 0 });

    expect(stdout).toEqual([selected]);
  });

  test("passes configured provider and privacy settings to direct query selection", async () => {
    const selected = join(tempDir, "agentscan");
    await mkdir(selected);
    const config: LoadedConfig = {
      path: join(tempDir, "config.json"),
      source: "file",
      config: {
        schema_version: 1,
        provider: {
          name: "openrouter",
          model: "anthropic/claude-sonnet-4.5",
        },
        privacy: {
          redact_home: false,
          redact_emails: true,
          redact_secrets: true,
          redact_tokens: true,
        },
        telemetry: {
          enabled: true,
          max_events: 1000,
        },
      },
    };

    expect(
      await main(["ascan"], {
        ...testDeps({
          lookup: { status: "miss", query: "ascan" },
          loadConfig: async () => config,
        }),
        loadZoxideEntries: async () => [{ path: selected, score: 10, rank: 1 }],
        selectCandidate: async ({ candidates, provider, privacy }) => {
          expect(provider).toEqual(config.config.provider);
          expect(privacy).toEqual(config.config.privacy);
          return selectionResult(candidates[0] ?? null);
        },
      }),
    ).toEqual({ code: 0 });
  });

  test("does not record direct query telemetry when config disables telemetry", async () => {
    const target = join(tempDir, "agentscan");
    const telemetry: TelemetryInput[] = [];
    await mkdir(target);
    await storeCorrection({
      query: "ascan",
      path: target,
      now: new Date("2026-05-18T00:00:00.000Z"),
    });

    expect(
      await main(
        ["ascan"],
        testDeps({
          appendTelemetryEvent: async (event) => telemetry.push(event),
          loadConfig: async () => defaultLoadedConfig({ telemetry: { enabled: false, max_events: 1000 } }),
        }),
      ),
    ).toEqual({ code: 0 });

    expect(stdout).toEqual([target]);
    expect(telemetry).toEqual([]);
  });

  test("records direct query telemetry when environment override enables telemetry", async () => {
    const previousTelemetry = process.env.ZDR_TELEMETRY;
    process.env.ZDR_TELEMETRY = "1";
    try {
      const target = join(tempDir, "agentscan");
      const telemetry: TelemetryInput[] = [];
      await mkdir(target);
      await storeCorrection({
        query: "ascan",
        path: target,
        now: new Date("2026-05-18T00:00:00.000Z"),
      });

      expect(
        await main(
          ["ascan"],
          testDeps({
            appendTelemetryEvent: async (event) => telemetry.push(event),
            loadConfig: async () => defaultLoadedConfig({ telemetry: { enabled: false, max_events: 1000 } }),
          }),
        ),
      ).toEqual({ code: 0 });

      expect(telemetry).toHaveLength(1);
      expect(telemetry[0]?.outcome).toBe("cache-hit");
    } finally {
      if (previousTelemetry === undefined) {
        delete process.env.ZDR_TELEMETRY;
      } else {
        process.env.ZDR_TELEMETRY = previousTelemetry;
      }
    }
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
    const telemetry: TelemetryInput[] = [];
    await mkdir(selected);

    expect(
      await main(["ascan"], {
        ...testDeps({
          lookup: { status: "miss", query: "ascan" },
          appendTelemetryEvent: async (event) => telemetry.push(event),
        }),
        loadZoxideEntries: async () => [{ path: selected, score: 10, rank: 1 }],
        selectCandidate: async ({ candidates }) => selectionResult(candidates[0] ?? null, "selected", 0.74),
      }),
    ).toEqual({ code: 0 });

    expect(stdout).toEqual([selected]);
    expect(stderr).toEqual([]);
    expect(await readCorrectionCache()).toEqual({});
    expect(telemetry).toEqual([
      {
        kind: "direct-query",
        outcome: "selected",
        durationMs: expect.any(Number),
        data: {
          query: "ascan",
          cache_status: "miss",
          selected_path: selected,
          confidence: 0.74,
          cached: false,
        },
      },
    ]);
  });

  test("records provider token, cache, and cost telemetry for model fallback", async () => {
    const selected = join(tempDir, "agentscan");
    const telemetry: TelemetryInput[] = [];
    const usage = providerUsage();
    await mkdir(selected);

    expect(
      await main(["ascan"], {
        ...testDeps({
          lookup: { status: "miss", query: "ascan" },
          appendTelemetryEvent: async (event) => telemetry.push(event),
        }),
        loadZoxideEntries: async () => [{ path: selected, score: 10, rank: 1 }],
        selectCandidate: async ({ candidates }) => selectionResult(candidates[0] ?? null, "selected", 0.8, usage),
      }),
    ).toEqual({ code: 0 });

    expect(telemetry[0]?.data).toMatchObject({
      usage,
      provider_usage: {
        input_tokens: 100,
        output_tokens: 25,
        cache_read_tokens: 40,
        cache_write_tokens: 10,
        total_tokens: 175,
        cost_input: 0.001,
        cost_output: 0.002,
        cost_cache_read: 0.0001,
        cost_cache_write: 0.0005,
        cost_total: 0.0036,
      },
    });
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
    const telemetry: TelemetryInput[] = [];

    expect(
      await main(["ascan"], {
        ...testDeps({
          lookup: { status: "miss", query: "ascan" },
          appendTelemetryEvent: async (event) => telemetry.push(event),
        }),
        loadZoxideEntries: async () => [{ path: join(tempDir, "agentscan"), score: 10, rank: 1 }],
        selectCandidate: async () => selectionResult(null, "no good match"),
      }),
    ).toEqual({ code: 1 });

    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["zdr: no good match"]);
    expect(telemetry).toEqual([
      {
        kind: "direct-query",
        outcome: "no-selection",
        durationMs: expect.any(Number),
        data: {
          query: "ascan",
          cache_status: "miss",
          confidence: 0,
        },
      },
    ]);
  });

  test("keeps navigation successful when direct query telemetry fails", async () => {
    const target = join(tempDir, "agentscan");
    await mkdir(target);
    await storeCorrection({
      query: "ascan",
      path: target,
      now: new Date("2026-05-18T00:00:00.000Z"),
    });

    expect(
      await main(
        ["ascan"],
        testDeps({
          appendTelemetryEvent: async () => {
            throw new Error("telemetry is read-only");
          },
        }),
      ),
    ).toEqual({ code: 0 });

    expect(stdout).toEqual([target]);
    expect(stderr).toEqual([]);
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
    expect(script).toContain("debug-config");
    expect(script).toContain("debug-events");
    expect(script).toContain("debug-timing");
    expect(script).toContain("debug-provider-timing");
    expect(script).toContain("prune-events");
    expect(script).toContain("forget");
    expect(script).toContain('cd -- "$__zdr_target"');
  });

  test("zsh init records z attempts with runtime attempt IDs when zsh is available", () => {
    const result = runZshRuntimeTest(`
z() { cd "$ZDR_TARGET"; }
eval "$(bun run --silent src/cli.ts init zsh)"
cd "$HOME"
z ascan
[[ "$PWD" == "$ZDR_TARGET" ]] || exit 11
cd "$HOME"
zdr
[[ "$PWD" == "$ZDR_TARGET" ]] || exit 12
`);

    if (result.skipped) {
      return;
    }
    expect(result.output).toContain("zsh smoke ran");
    expect(result.output).toContain("record-z --attempt zsh-");
    expect(result.output).toContain("--shell zsh -- ascan");
    expect(result.output).toContain("finish-z --attempt zsh-");
  });

  test("zsh init bypasses non-navigation zdr commands when zsh is available", () => {
    const result = runZshRuntimeTest(`
z() { cd "$ZDR_TARGET"; }
eval "$(bun run --silent src/cli.ts init zsh)"
cd "$HOME"
zdr --version >/dev/null
[[ "$PWD" == "$HOME" ]] || exit 11
zdr debug-config >/dev/null
[[ "$PWD" == "$HOME" ]] || exit 12
zdr provider-smoke >/dev/null
[[ "$PWD" == "$HOME" ]] || exit 13
`);

    if (result.skipped) {
      return;
    }
    expect(result.output).toContain("--version");
    expect(result.output).toContain("debug-config");
    expect(result.output).toContain("provider-smoke");
  });

  test("zsh init preserves original z argv and failure status when zsh is available", () => {
    const result = runZshRuntimeTest(`
z() {
  printf '%s\\n' "$@" > "$ZDR_ORIGINAL_Z_LOG"
  return 7
}
eval "$(bun run --silent src/cli.ts init zsh)"
z foo "bar baz"
[[ "$?" -eq 7 ]] || exit 11
`);

    if (result.skipped) {
      return;
    }
    expect(result.output).toContain("--shell zsh -- foo bar baz");
    expect(result.output).toContain("finish-z --attempt zsh-");
    expect(result.output).toContain("--status 7");
  });

  test("zsh init preserves retry state for no-arg zdr command variants when zsh is available", () => {
    const result = runZshRuntimeTest(`
z() { cd "$ZDR_TARGET"; }
eval "$(bun run --silent src/cli.ts init zsh)"
preexec_functions=(\${preexec_functions:#_zdr_preexec})
mkdir -p "$XDG_STATE_HOME/zdr"
echo retry > "$XDG_STATE_HOME/zdr/recovery_retry.json"
_zdr_preexec "  zdr  "
[[ -e "$XDG_STATE_HOME/zdr/recovery_retry.json" ]] || exit 11
_zdr_preexec "command zdr"
[[ -e "$XDG_STATE_HOME/zdr/recovery_retry.json" ]] || exit 12
_zdr_preexec "zdr ascan"
[[ ! -e "$XDG_STATE_HOME/zdr/recovery_retry.json" ]] || exit 13
echo retry > "$XDG_STATE_HOME/zdr/recovery_retry.json"
_zdr_preexec "zdr#typo"
[[ ! -e "$XDG_STATE_HOME/zdr/recovery_retry.json" ]] || exit 14
`);

    if (result.skipped) {
      return;
    }
    expect(result.output).toContain("zsh smoke ran");
  });

  test("bash init wraps z and navigation commands", async () => {
    expect(await main(["init", "bash"])).toEqual({ code: 0 });

    const script = stdout.join("\n");
    expect(script).toContain("zoxide-doctor bash integration");
    expect(script).toContain("__zdr_original_z");
    expect(script).toContain("--shell bash");
    expect(script).toContain("__zdr_clear_recovery_retry_file");
    expect(script).not.toContain("trap __zdr_debug_trap DEBUG");
    expect(script).toContain("local __zdr_status=$?");
    expect(script).toContain("return $__zdr_status");
    expect(script).toContain('PROMPT_COMMAND=(__zdr_prompt_command "${PROMPT_COMMAND[@]}")');
    expect(script).toContain('PROMPT_COMMAND="__zdr_prompt_command${PROMPT_COMMAND:+;$PROMPT_COMMAND}"');
    expect(script).toContain('case "$1" in');
    expect(script).toContain("debug-config");
    expect(script).toContain("provider-smoke");
    expect(script).toContain('cd -- "$__zdr_target"');
  });

  test("bash init preserves function-style z definitions", () => {
    const result = Bun.spawnSync({
      cmd: [
        "bash",
        "-lc",
        'function z() { :; }; eval "$(bun run --silent src/cli.ts init bash)"; declare -F __zdr_original_z >/dev/null',
      ],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
  });

  test("bash init records z attempts with runtime attempt IDs when bash is available", () => {
    const result = runBashRuntimeTest(`
z() { cd "$ZDR_TARGET"; }
eval "$(bun run --silent src/cli.ts init bash)"
cd "$HOME"
z ascan
[[ "$PWD" == "$ZDR_TARGET" ]] || exit 11
cd "$HOME"
zdr
[[ "$PWD" == "$ZDR_TARGET" ]] || exit 12
`);

    if (result.skipped) {
      return;
    }
    expect(result.output).toContain("bash smoke ran");
    expect(result.output).toContain("record-z --attempt bash-");
    expect(result.output).toContain("--shell bash -- ascan");
    expect(result.output).toContain("finish-z --attempt bash-");
  });

  test("bash init bypasses non-navigation zdr commands when bash is available", () => {
    const result = runBashRuntimeTest(`
z() { cd "$ZDR_TARGET"; }
eval "$(bun run --silent src/cli.ts init bash)"
cd "$HOME"
zdr --version >/dev/null
[[ "$PWD" == "$HOME" ]] || exit 11
zdr debug-config >/dev/null
[[ "$PWD" == "$HOME" ]] || exit 12
zdr provider-smoke >/dev/null
[[ "$PWD" == "$HOME" ]] || exit 13
`);

    if (result.skipped) {
      return;
    }
    expect(result.output).toContain("--version");
    expect(result.output).toContain("debug-config");
    expect(result.output).toContain("provider-smoke");
  });

  test("bash init preserves original z argv and failure status when bash is available", () => {
    const result = runBashRuntimeTest(`
z() {
  printf '%s\\n' "$@" > "$ZDR_ORIGINAL_Z_LOG"
  return 7
}
eval "$(bun run --silent src/cli.ts init bash)"
z foo "bar baz"
[[ "$?" -eq 7 ]] || exit 11
`);

    if (result.skipped) {
      return;
    }
    expect(result.output).toContain("--shell bash -- foo bar baz");
    expect(result.output).toContain("finish-z --attempt bash-");
    expect(result.output).toContain("--status 7");
  });

  test("fish init wraps z and navigation commands", async () => {
    expect(await main(["init", "fish"])).toEqual({ code: 0 });

    const script = stdout.join("\n");
    expect(script).toContain("zoxide-doctor fish integration");
    expect(script).toContain("functions --copy z __zdr_original_z");
    expect(script).toContain("set -l __zdr_attempt fish-$fish_pid-(date +%s%N)-(random)");
    expect(script).toContain("--shell fish");
    expect(script).toContain("function zdr");
    expect(script).toContain("command zdr $argv");
    expect(script).toContain("cd -- \"$__zdr_target\"");
    expect(script).toContain("function __zdr_preexec --on-event fish_preexec");
    expect(script).toContain("function __zdr_is_no_arg_zdr_command");
    expect(script).toContain("debug-config");
    expect(script).toContain("provider-smoke");
  });

  test("fish init records z attempts with runtime attempt IDs when fish is available", () => {
    const result = runFishRuntimeTest(`
function z
  cd $ZDR_TARGET
end
bun run --silent src/cli.ts init fish | source
cd $HOME
z ascan
test "$PWD" = "$ZDR_TARGET"; or exit 11
cd $HOME
zdr
test "$PWD" = "$ZDR_TARGET"; or exit 12
`);

    if (result.skipped) {
      return;
    }
    expect(result.output).toContain("fish smoke ran");
    expect(result.output).not.toContain("_date___s_N_-_random_");
    expect(result.output).toContain("record-z --attempt fish-");
    expect(result.output).toContain("--shell fish -- ascan");
    expect(result.output).toContain("finish-z --attempt fish-");
  });

  test("fish init bypasses non-navigation zdr commands when fish is available", () => {
    const result = runFishRuntimeTest(`
function z
  cd $ZDR_TARGET
end
bun run --silent src/cli.ts init fish | source
cd $HOME
zdr --version >/dev/null
test "$PWD" = "$HOME"; or exit 11
zdr debug-config >/dev/null
test "$PWD" = "$HOME"; or exit 12
zdr provider-smoke >/dev/null
test "$PWD" = "$HOME"; or exit 13
`);

    if (result.skipped) {
      return;
    }
    expect(result.output).toContain("--version");
    expect(result.output).toContain("debug-config");
    expect(result.output).toContain("provider-smoke");
  });

  test("fish init navigates direct queries with spaces when fish is available", () => {
    const result = runFishRuntimeTest(`
function z
  cd $ZDR_TARGET
end
bun run --silent src/cli.ts init fish | source
cd $HOME
zdr agent scan
test "$PWD" = "$ZDR_TARGET"; or exit 11
`);

    if (result.skipped) {
      return;
    }
    expect(result.output).toContain("agent scan");
  });

  test("fish init clears retry state only for non-zdr preexec events when fish is available", () => {
    const result = runFishRuntimeTest(`
function z
  cd $ZDR_TARGET
end
bun run --silent src/cli.ts init fish | source
mkdir -p "$XDG_STATE_HOME/zdr"
echo retry > "$XDG_STATE_HOME/zdr/recovery_retry.json"
emit fish_preexec zdr
test -e "$XDG_STATE_HOME/zdr/recovery_retry.json"; or exit 11
emit fish_preexec "  zdr  "
test -e "$XDG_STATE_HOME/zdr/recovery_retry.json"; or exit 12
emit fish_preexec "command zdr"
test -e "$XDG_STATE_HOME/zdr/recovery_retry.json"; or exit 13
emit fish_preexec "zdr ascan"
test ! -e "$XDG_STATE_HOME/zdr/recovery_retry.json"; or exit 14
echo retry > "$XDG_STATE_HOME/zdr/recovery_retry.json"
emit fish_preexec "zdr#typo"
test ! -e "$XDG_STATE_HOME/zdr/recovery_retry.json"; or exit 15
echo retry > "$XDG_STATE_HOME/zdr/recovery_retry.json"
emit fish_preexec ls
test ! -e "$XDG_STATE_HOME/zdr/recovery_retry.json"; or exit 16
`);

    if (result.skipped) {
      return;
    }
    expect(result.output).toContain("fish smoke ran");
  });

  test("fish init preserves original z argv and failure status when fish is available", () => {
    const result = runFishRuntimeTest(`
function z
  printf '%s\\n' $argv > "$ZDR_ORIGINAL_Z_LOG"
  return 7
end
bun run --silent src/cli.ts init fish | source
z foo "bar baz"
test $status -eq 7; or exit 11
string match -q foo (sed -n '1p' "$ZDR_ORIGINAL_Z_LOG"); or exit 12
string match -q "bar baz" (sed -n '2p' "$ZDR_ORIGINAL_Z_LOG"); or exit 13
`);

    if (result.skipped) {
      return;
    }
    expect(result.output).toContain("--shell fish -- foo bar baz");
    expect(result.output).toContain("--status 7");
  });

  test("fish init warns without a zoxide z function when fish is available", () => {
    const result = runFishRuntimeTest(`
bun run --silent src/cli.ts init fish | source
functions --query z; and exit 11
functions --query __zdr_original_z; and exit 12
exit 0
`);

    if (result.skipped) {
      return;
    }
    expect(result.stderr).toContain("zoxide function 'z' is not defined");
  });

  test("rejects unsupported init shells", async () => {
    expect(await main(["init", "nu"])).toEqual({ code: 2 });

    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["zdr: supported shells: zsh, bash, fish"]);
  });
});

describe("main telemetry commands", () => {
  test("prints empty telemetry JSON when event file is missing", async () => {
    expect(await main(["debug-events"], testDeps())).toEqual({ code: 0 });

    expect(stdout).toEqual(["[]"]);
    expect(stderr).toEqual([]);
  });

  test("prints telemetry event JSON", async () => {
    const events: TelemetryEvent[] = [
      {
        schema_version: 1,
        kind: "recovery",
        outcome: "selected",
        occurred_at: "2026-05-20T12:00:00.000Z",
        data: {
          query: "ascan",
        },
      },
    ];

    expect(await main(["debug-events"], testDeps({ readTelemetryEvents: async () => events }))).toEqual({ code: 0 });

    expect(JSON.parse(stdout.join("\n"))).toEqual(events);
    expect(stderr).toEqual([]);
  });

  test("passes telemetry event limit to reader", async () => {
    let limit: number | undefined;

    expect(
      await main(
        ["debug-events", "--limit", "2"],
        testDeps({
          readTelemetryEvents: async (input) => {
            limit = input?.limit;
            return [];
          },
        }),
      ),
    ).toEqual({ code: 0 });

    expect(limit).toBe(2);
    expect(stdout).toEqual(["[]"]);
    expect(stderr).toEqual([]);
  });

  test("supports equals-form telemetry event limit", async () => {
    let limit: number | undefined;

    expect(
      await main(
        ["debug-events", "--limit=3"],
        testDeps({
          readTelemetryEvents: async (input) => {
            limit = input?.limit;
            return [];
          },
        }),
      ),
    ).toEqual({ code: 0 });

    expect(limit).toBe(3);
  });

  test("rejects invalid telemetry event limit", async () => {
    expect(await main(["debug-events", "--limit", "0"], testDeps())).toEqual({ code: 2 });

    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["zdr: --limit must be a positive integer"]);
  });

  test("prunes telemetry events", async () => {
    let maxEvents: number | undefined;

    expect(
      await main(
        ["prune-events", "--max-events", "25"],
        testDeps({
          pruneTelemetryEvents: async (input) => {
            maxEvents = input.maxEvents;
            return {
              kept: 25,
              pruned: 4,
              dropped_invalid: 1,
            };
          },
        }),
      ),
    ).toEqual({ code: 0 });

    expect(maxEvents).toBe(25);
    expect(JSON.parse(stdout.join("\n"))).toEqual({
      kept: 25,
      pruned: 4,
      dropped_invalid: 1,
    });
    expect(stderr).toEqual([]);
  });

  test("supports pruning telemetry to zero events", async () => {
    let maxEvents: number | undefined;

    expect(
      await main(
        ["prune-events", "--max-events=0"],
        testDeps({
          pruneTelemetryEvents: async (input) => {
            maxEvents = input.maxEvents;
            return {
              kept: 0,
              pruned: 3,
              dropped_invalid: 0,
            };
          },
        }),
      ),
    ).toEqual({ code: 0 });

    expect(maxEvents).toBe(0);
  });

  test("uses configured telemetry prune limit when omitted", async () => {
    let maxEvents: number | undefined;

    expect(
      await main(
        ["prune-events"],
        testDeps({
          loadConfig: async () => defaultLoadedConfig({ telemetry: { enabled: true, max_events: 17 } }),
          pruneTelemetryEvents: async (input) => {
            maxEvents = input.maxEvents;
            return {
              kept: 17,
              pruned: 2,
              dropped_invalid: 0,
            };
          },
        }),
      ),
    ).toEqual({ code: 0 });

    expect(maxEvents).toBe(17);
    expect(stderr).toEqual([]);
  });

  test("rejects invalid telemetry prune limit", async () => {
    expect(await main(["prune-events", "--max-events", "-1"], testDeps())).toEqual({ code: 2 });

    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["zdr: --max-events must be a non-negative integer"]);
  });

  test("rejects empty telemetry prune equals value", async () => {
    expect(await main(["prune-events", "--max-events="], testDeps())).toEqual({ code: 2 });

    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["zdr: --max-events requires a value"]);
  });

  test("rejects whitespace-only telemetry prune values", async () => {
    expect(await main(["prune-events", "--max-events", " "], testDeps())).toEqual({ code: 2 });
    expect(await main(["prune-events", "--max-events= "], testDeps())).toEqual({ code: 2 });

    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["zdr: --max-events requires a value", "zdr: --max-events requires a value"]);
  });
});

describe("main config commands", () => {
  test("prints merged config JSON", async () => {
    const config: LoadedConfig = {
      path: join(tempDir, "config.json"),
      source: "default",
      config: {
        schema_version: 1,
        provider: {
          name: "openrouter",
          model: "google/gemini-2.5-flash-lite",
        },
        privacy: {
          redact_home: true,
          redact_emails: true,
          redact_secrets: true,
          redact_tokens: true,
        },
        telemetry: {
          enabled: true,
          max_events: 1000,
        },
      },
    };

    expect(await main(["debug-config"], testDeps({ loadConfig: async () => config }))).toEqual({ code: 0 });

    expect(JSON.parse(stdout.join("\n"))).toEqual(config);
    expect(stderr).toEqual([]);
  });

  test("reports invalid config errors", async () => {
    expect(
      await main(
        ["debug-config"],
        testDeps({
          loadConfig: async () => {
            throw new Error("config schema_version must be 1");
          },
        }),
      ),
    ).toEqual({ code: 1 });

    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["zdr: config schema_version must be 1"]);
  });

  test("sets provider config after validating provider and model", async () => {
    const config = defaultLoadedConfig({
      provider: {
        name: "openai-codex",
        model: "gpt-5.3-codex-spark",
      },
    });

    expect(
      await main(
        ["config-provider", "openai-codex", "gpt-5.3-codex-spark"],
        testDeps({
          setProviderConfig: async (provider) => {
            expect(provider).toEqual({
              name: "openai-codex",
              model: "gpt-5.3-codex-spark",
            });
            return config;
          },
        }),
      ),
    ).toEqual({ code: 0 });

    expect(JSON.parse(stdout.join("\n"))).toEqual({
      schema_version: 1,
      path: config.path,
      provider: {
        name: "openai-codex",
        model: "gpt-5.3-codex-spark",
      },
    });
    expect(stderr).toEqual([]);
  });

  test("rejects incomplete provider config args", async () => {
    expect(await main(["config-provider", "openai-codex"], testDeps())).toEqual({ code: 2 });

    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["zdr: config-provider requires provider and model"]);
  });
});

describe("main doctor command", () => {
  test("prints setup diagnostics without live provider calls", async () => {
    expect(
      await main(
        ["doctor"],
        testDeps({
          loadConfig: async () =>
            defaultLoadedConfig({
              provider: {
                name: "openrouter",
                model: "google/gemini-2.5-flash-lite",
              },
            }),
          commandExists: (command) => command === "fzf",
        }),
      ),
    ).toEqual({ code: 1 });

    const payload = JSON.parse(stdout.join("\n"));
    expect(payload).toMatchObject({
      schema_version: 1,
      command: "doctor",
      ok: false,
      provider: {
        name: "openrouter",
        model: "google/gemini-2.5-flash-lite",
        known_model: true,
        auth: {
          type: "env",
        },
      },
      tools: {
        zoxide: false,
        fzf: true,
        fd: false,
      },
      paths: {
        config: expect.stringContaining("config.json"),
        auth: expect.stringContaining("auth.json"),
        last_z: expect.stringContaining("last_z.json"),
        corrections: expect.stringContaining("corrections.json"),
      },
    });
    expect(payload.checks.map((check: { name: string }) => check.name)).toContain("provider_auth");
    expect(stderr).toEqual([]);
  });

  test("reports OAuth provider readiness", async () => {
    expect(
      await main(
        ["doctor"],
        testDeps({
          loadConfig: async () =>
            defaultLoadedConfig({
              provider: {
                name: "openai-codex",
                model: "gpt-5.3-codex-spark",
              },
            }),
          providerAuthStatuses: async () => [
            {
              provider: "openai-codex",
              authenticated: true,
              type: "oauth",
              expired: false,
              expires_at: "2026-06-01T00:00:00.000Z",
              refresh_available: true,
            },
          ],
          commandExists: (command) => command === "zoxide",
        }),
      ),
    ).toEqual({ code: 0 });

    expect(JSON.parse(stdout.join("\n"))).toMatchObject({
      ok: true,
      provider: {
        name: "openai-codex",
        model: "gpt-5.3-codex-spark",
        known_model: true,
        auth: {
          type: "oauth",
          authenticated: true,
          expired: false,
        },
      },
    });
    expect(stderr).toEqual([]);
  });

  test("rejects doctor args", async () => {
    expect(await main(["doctor", "--live"], testDeps())).toEqual({ code: 2 });

    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["zdr: unknown doctor option: --live"]);
  });
});

describe("main timing command", () => {
  test("prints local timing JSON with skipped cache lookup when query is omitted", async () => {
    expect(await main(["debug-timing"], testDeps())).toEqual({ code: 0 });

    const payload = JSON.parse(stdout.join("\n")) as TimingPayload;
    expect(payload.schema_version).toBe(1);
    expect(payload.command).toBe("debug-timing");
    expect(payload.total_duration_ms).toBeGreaterThanOrEqual(0);
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

  test("includes budget status when budget is provided", async () => {
    expect(await main(["debug-timing", "ascan", "--budget-ms", "1000"], testDeps())).toEqual({ code: 0 });

    const payload = JSON.parse(stdout.join("\n")) as TimingPayload;
    expect(payload.budget_ms).toBe(1000);
    expect(payload.within_budget).toBe(true);
    expect(stderr).toEqual([]);
  });

  test("rejects invalid timing budget values", async () => {
    expect(await main(["debug-timing", "--budget-ms", "0"], testDeps())).toEqual({ code: 2 });

    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["zdr: --budget-ms must be a positive number"]);
  });

  test("measures provider selection timing for a direct query", async () => {
    const selected = join(tempDir, "agentscan");

    expect(
      await main(["debug-provider-timing", "ascan"], {
        ...testDeps(),
        loadZoxideEntries: async () => [
          { path: selected, score: 10, rank: 1 },
          { path: join(tempDir, "other"), score: 5, rank: 2 },
        ],
        selectCandidate: async ({ state, candidates, rejectedPaths }) => {
          expect(state.shell).toBe("direct-query");
          expect(state.query_argv).toEqual(["ascan"]);
          expect(rejectedPaths).toEqual([]);
          return {
            ...selectionResult(candidates[0] ?? null, "selected", 0.8, providerUsage()),
            timings: {
              model_resolve_ms: 1,
              prompt_build_ms: 2,
              provider_complete_ms: 3,
              response_parse_ms: 4,
              total_ms: 10,
            },
          };
        },
      }),
    ).toEqual({ code: 0 });

    const payload = JSON.parse(stdout.join("\n")) as TimingPayload;
    expect(payload.command).toBe("debug-provider-timing");
    expect(payload.measurements.map((measurement) => measurement.name)).toEqual(["provider-context", "provider-selection"]);
    expect(payload.measurements.find((measurement) => measurement.name === "provider-context")).toMatchObject({
      ok: true,
      metadata: {
        query: "ascan",
        mode: "direct-query",
        zoxide_entry_count: 2,
        candidate_count: 2,
        rejected_path_count: 0,
      },
    });
    expect(payload.measurements.find((measurement) => measurement.name === "provider-selection")).toMatchObject({
      ok: true,
      metadata: {
        selected_candidate_id: "c001",
        selected_path: selected,
        confidence: 0.8,
        provider_timings: {
          model_resolve_ms: 1,
          prompt_build_ms: 2,
          provider_complete_ms: 3,
          response_parse_ms: 4,
          total_ms: 10,
        },
        provider_usage: {
          input_tokens: 100,
          cost_total: 0.0036,
        },
      },
    });
    expect(stderr).toEqual([]);
  });

  test("measures provider selection timing for recorded recovery context", async () => {
    const selected = join(tempDir, "agentscan");
    await recordFinishedZAttempt("provider-timing-1", join(tempDir, "wrong"), ["ascan"]);

    expect(
      await main(["debug-provider-timing"], {
        ...testDeps(),
        loadZoxideEntries: async () => [{ path: selected, score: 10, rank: 1 }],
        selectCandidate: async ({ state, candidates }) => {
          expect(state.query_argv).toEqual(["ascan"]);
          return selectionResult(candidates[0] ?? null);
        },
      }),
    ).toEqual({ code: 0 });

    const payload = JSON.parse(stdout.join("\n")) as TimingPayload;
    expect(payload.measurements.find((measurement) => measurement.name === "provider-context")).toMatchObject({
      ok: true,
      metadata: {
        query: "ascan",
        mode: "recovery",
      },
    });
    expect(payload.measurements.find((measurement) => measurement.name === "provider-selection")?.ok).toBe(true);
  });

  test("rejects provider timing options", async () => {
    expect(await main(["debug-provider-timing", "--live"], testDeps())).toEqual({ code: 2 });

    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["zdr: unknown debug-provider-timing option: --live"]);
  });

  test("benchmarks provider selection for a direct query", async () => {
    const selected = join(tempDir, "agentscan");
    let calls = 0;

    expect(
      await main(["benchmark-provider", "ascan", "--repeat", "2"], {
        ...testDeps(),
        loadZoxideEntries: async () => [
          { path: selected, score: 10, rank: 1 },
          { path: join(tempDir, "other"), score: 5, rank: 2 },
        ],
        selectCandidate: async ({ state, candidates, provider }) => {
          calls += 1;
          expect(state.shell).toBe("direct-query");
          expect(state.query_argv).toEqual(["ascan"]);
          expect(provider).toEqual({ name: "openrouter", model: "google/gemini-2.5-flash-lite" });
          return {
            ...selectionResult(candidates[0] ?? null, "selected", 0.9, providerUsage()),
            timings: {
              model_resolve_ms: 1,
              prompt_build_ms: 2,
              provider_complete_ms: calls * 10,
              response_parse_ms: 4,
              total_ms: calls * 10 + 7,
            },
          };
        },
      }),
    ).toEqual({ code: 0 });

    const payload = JSON.parse(stdout.join("\n")) as BenchmarkProviderPayload;
    expect(payload.command).toBe("benchmark-provider");
    expect(payload.query).toBe("ascan");
    expect(payload.mode).toBe("direct-query");
    expect(payload.repeat).toBe(2);
    expect(payload.provider).toEqual({ name: "openrouter", model: "google/gemini-2.5-flash-lite" });
    expect(payload.ok).toBe(true);
    expect(payload.context).toMatchObject({
      zoxide_entry_count: 2,
      candidate_count: 2,
      rejected_path_count: 0,
    });
    expect(payload.summary).toMatchObject({
      iteration_count: 2,
      success_count: 2,
      failure_count: 0,
      provider_complete_ms: {
        min: 10,
        p50: 10,
        p95: 20,
        max: 20,
        average: 15,
      },
      selected_paths: {
        [selected]: 2,
      },
      usage: {
        total_tokens: 350,
        average_tokens: 175,
        cost_total: 0.0072,
        average_cost: 0.0036,
      },
    });
    expect(payload.iterations).toHaveLength(2);
    expect(payload.iterations.every((iteration) => iteration.ok)).toBe(true);
    expect(calls).toBe(2);
    expect(stderr).toEqual([]);
  });

  test("benchmarks one-off provider overrides without changing config", async () => {
    const selected = join(tempDir, "agentscan");

    expect(
      await main(["benchmark-provider", "--provider", "openai-codex", "--model", "gpt-5.3-codex-spark", "ascan"], {
        ...testDeps(),
        loadZoxideEntries: async () => [{ path: selected, score: 10, rank: 1 }],
        loadConfig: async () => ({
          ...defaultLoadedConfig({
            provider: { name: "openrouter", model: "google/gemini-2.5-flash-lite" },
          }),
        }),
        selectCandidate: async ({ candidates, provider }) => {
          expect(provider).toEqual({ name: "openai-codex", model: "gpt-5.3-codex-spark" });
          return selectionResult(candidates[0] ?? null);
        },
      }),
    ).toEqual({ code: 0 });

    const payload = JSON.parse(stdout.join("\n")) as BenchmarkProviderPayload;
    expect(payload.provider).toEqual({ name: "openai-codex", model: "gpt-5.3-codex-spark" });
    expect(payload.summary).toMatchObject({
      success_count: 3,
      selected_paths: {
        [selected]: 3,
      },
    });
    expect(stderr).toEqual([]);
  });

  test("reports benchmark provider iteration failures", async () => {
    const selected = join(tempDir, "agentscan");
    let calls = 0;

    expect(
      await main(["benchmark-provider", "--repeat=2", "ascan"], {
        ...testDeps(),
        loadZoxideEntries: async () => [{ path: selected, score: 10, rank: 1 }],
        selectCandidate: async ({ candidates }) => {
          calls += 1;
          if (calls === 2) {
            throw new Error("provider unavailable");
          }
          return selectionResult(candidates[0] ?? null);
        },
      }),
    ).toEqual({ code: 1 });

    const payload = JSON.parse(stdout.join("\n")) as BenchmarkProviderPayload;
    expect(payload.ok).toBe(false);
    expect(payload.summary).toMatchObject({
      iteration_count: 2,
      success_count: 1,
      failure_count: 1,
      selected_paths: {
        [selected]: 1,
      },
    });
    expect(payload.iterations[1]).toMatchObject({
      index: 2,
      ok: false,
      error: "provider unavailable",
    });
    expect(stderr).toEqual([]);
  });

  test("rejects invalid benchmark provider repeat values", async () => {
    expect(await main(["benchmark-provider", "ascan", "--repeat", "0"], testDeps())).toEqual({ code: 2 });
    expect(await main(["benchmark-provider", "--repeat=21", "ascan"], testDeps())).toEqual({ code: 2 });
    expect(await main(["benchmark-provider", "--live", "ascan"], testDeps())).toEqual({ code: 2 });
    expect(await main(["benchmark-provider", "--provider", "openai-codex", "ascan"], testDeps())).toEqual({ code: 2 });
    expect(await main(["benchmark-provider", "--model=fast-model", "ascan"], testDeps())).toEqual({ code: 2 });

    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "zdr: --repeat must be a positive integer",
      "zdr: --repeat must be 20 or less",
      "zdr: unknown benchmark-provider option: --live",
      "zdr: --provider and --model must be provided together",
      "zdr: --provider and --model must be provided together",
    ]);
  });
});

describe("main provider auth commands", () => {
  test("logs in to an OAuth provider", async () => {
    const calls: Array<{ provider: string; callbacks: OAuthLoginCallbacks }> = [];

    expect(
      await main(
        ["provider-login", "openai-codex"],
        testDeps({
          providerLogin: async (provider, callbacks) => {
            calls.push({ provider, callbacks });
          },
        }),
      ),
    ).toEqual({ code: 0 });

    expect(calls.map((call) => call.provider)).toEqual(["openai-codex"]);
    expect(calls[0]?.callbacks.onManualCodeInput).toEqual(expect.any(Function));
    expect(JSON.parse(stdout.join("\n"))).toEqual({
      schema_version: 1,
      provider: "openai-codex",
      authenticated: true,
    });
  });

  test("logs out of an OAuth provider", async () => {
    expect(
      await main(
        ["provider-logout", "openai-codex"],
        testDeps({
          providerLogout: async (provider) => provider === "openai-codex",
        }),
      ),
    ).toEqual({ code: 0 });

    expect(JSON.parse(stdout.join("\n"))).toEqual({
      schema_version: 1,
      provider: "openai-codex",
      removed: true,
    });
  });

  test("prints provider auth status", async () => {
    expect(
      await main(
        ["provider-auth-status", "openai-codex"],
        testDeps({
          providerAuthStatuses: async (providers) => [
            {
              provider: providers?.[0] ?? "openai-codex",
              authenticated: true,
              type: "oauth",
              expired: false,
              expires_at: "2026-05-21T00:00:00.000Z",
              refresh_available: true,
            },
          ],
        }),
      ),
    ).toEqual({ code: 0 });

    expect(JSON.parse(stdout.join("\n"))).toEqual({
      schema_version: 1,
      providers: [
        {
          provider: "openai-codex",
          authenticated: true,
          type: "oauth",
          expired: false,
          expires_at: "2026-05-21T00:00:00.000Z",
          refresh_available: true,
        },
      ],
    });
  });

  test("rejects missing provider login arg", async () => {
    expect(await main(["provider-login"], testDeps())).toEqual({ code: 2 });

    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["zdr: provider-login requires exactly one provider"]);
  });
});

describe("main recovery routing", () => {
  test("first no-arg recovery uses model selection without retry announcement", async () => {
    const selected = join(tempDir, "agentscan");
    const telemetry: TelemetryInput[] = [];
    await mkdir(selected);
    await recordFinishedZAttempt("recovery-1", join(tempDir, "wrong"), ["ascan"]);

    expect(
      await main([], {
        ...testDeps({ appendTelemetryEvent: async (event) => telemetry.push(event) }),
        loadZoxideEntries: async () => [{ path: selected, score: 10, rank: 1 }],
        loadConfig: async () =>
          defaultLoadedConfig({
            provider: { name: "openrouter", model: "anthropic/claude-sonnet-4.5" },
            privacy: {
              redact_home: false,
              redact_emails: true,
              redact_secrets: true,
              redact_tokens: true,
            },
          }),
        selectCandidate: async ({ rejectedPaths, candidates, provider, privacy, reasoning }) => {
          expect(rejectedPaths).toEqual([]);
          expect(provider).toEqual({ name: "openrouter", model: "anthropic/claude-sonnet-4.5" });
          expect(privacy?.redact_home).toBe(false);
          expect(reasoning).toBe("minimal");
          return selectionResult(candidates[0] ?? null);
        },
      }),
    ).toEqual({ code: 0 });

    expect(stdout).toEqual([selected]);
    expect(stderr).toEqual([]);
    expect(telemetry).toEqual([
      {
        kind: "recovery",
        outcome: "selected",
        durationMs: expect.any(Number),
        data: {
          query: "ascan",
          mode: "model",
          rejected_path_count: 0,
          selected_path: selected,
          confidence: 0.8,
          candidate_count: 1,
        },
      },
    ]);
  });

  test("adds local scan candidates for weak recovery zoxide matches", async () => {
    const selected = join(tempDir, "agentscan");
    const beforeDir = join(tempDir, "before");
    const wrongDir = join(tempDir, "wrong");
    await mkdir(beforeDir);
    await mkdir(wrongDir);
    await mkdir(selected);
    await recordFinishedZAttempt("recovery-local-scan", wrongDir, ["ascan"], { beforePath: beforeDir });

    expect(
      await main([], {
        ...testDeps({
          scanLocalDirectories: async (input) => {
            expect(input.query).toBe("ascan");
            expect(input.roots).toEqual([tempDir, beforeDir, wrongDir]);
            return [selected];
          },
        }),
        loadZoxideEntries: async () => [{ path: join(tempDir, "unrelated"), score: 10, rank: 1 }],
        selectCandidate: async ({ candidates }) => {
          expect(candidates.map((candidate) => candidate.path)).toContain(selected);
          return selectionResult(candidates.find((candidate) => candidate.path === selected) ?? null);
        },
      }),
    ).toEqual({ code: 0 });

    expect(stdout).toEqual([selected]);
  });

  test("second no-arg recovery still uses model selection with rejected path context", async () => {
    const first = join(tempDir, "agentscan-old");
    const second = join(tempDir, "agentscan");
    const telemetry: TelemetryInput[] = [];
    await mkdir(first);
    await mkdir(second);
    await recordFinishedZAttempt("recovery-2", join(tempDir, "wrong"), ["ascan"]);
    await main([], {
      ...testDeps(),
      loadZoxideEntries: async () => [
        { path: first, score: 10, rank: 1 },
        { path: second, score: 9, rank: 2 },
      ],
      selectCandidate: async ({ candidates }) => selectionResult(candidates.find((candidate) => candidate.path === first) ?? null),
    });
    stdout = [];
    stderr = [];

    expect(
      await main([], {
        ...testDeps({ appendTelemetryEvent: async (event) => telemetry.push(event) }),
        loadZoxideEntries: async () => [
          { path: first, score: 10, rank: 1 },
          { path: second, score: 9, rank: 2 },
        ],
        selectCandidate: async ({ rejectedPaths, candidates, reasoning }) => {
          expect(rejectedPaths).toEqual([first]);
          expect(candidates.map((candidate) => candidate.path)).not.toContain(first);
          expect(reasoning).toBe("high");
          return selectionResult(candidates.find((candidate) => candidate.path === second) ?? null);
        },
      }),
    ).toEqual({ code: 0 });

    expect(stdout).toEqual([second]);
    expect(stderr).toEqual(["zdr: thinking harder..."]);
    expect(telemetry).toEqual([
      {
        kind: "recovery",
        outcome: "selected",
        durationMs: expect.any(Number),
        data: {
          query: "ascan",
          mode: "retry-model",
          rejected_path_count: 1,
          selected_path: second,
          confidence: 0.8,
          candidate_count: 1,
        },
      },
    ]);
  });

  test("third no-arg recovery returns selected picker path without model selection", async () => {
    const first = join(tempDir, "agentscan-old");
    const second = join(tempDir, "agentscan-other");
    const selected = join(tempDir, "agentscan");
    const beforeDir = join(tempDir, "before");
    const wrongDir = join(tempDir, "wrong");
    const telemetry: TelemetryInput[] = [];
    await mkdir(beforeDir);
    await mkdir(first);
    await mkdir(second);
    await mkdir(selected);
    await recordFinishedZAttempt("recovery-3", wrongDir, ["ascan"], { beforePath: beforeDir });
    await main([], {
      ...testDeps(),
      loadZoxideEntries: async () => [
        { path: first, score: 10, rank: 1 },
        { path: second, score: 9, rank: 2 },
      ],
      selectCandidate: async ({ candidates }) => selectionResult(candidates.find((candidate) => candidate.path === first) ?? null),
    });
    await main([], {
      ...testDeps(),
      loadZoxideEntries: async () => [
        { path: first, score: 10, rank: 1 },
        { path: second, score: 9, rank: 2 },
      ],
      selectCandidate: async ({ candidates }) => selectionResult(candidates.find((candidate) => candidate.path === second) ?? null),
    });
    stdout = [];
    stderr = [];

    expect(
      await main([], {
        ...testDeps({
          appendTelemetryEvent: async (event) => telemetry.push(event),
          runPicker: async (input) => {
            expect(input).toEqual({
              query: "ascan",
              zoxideEntries: [
                { path: first, score: 10, rank: 1 },
                { path: second, score: 9, rank: 2 },
                { path: selected, score: 8, rank: 3 },
              ],
              rejectedPaths: [first, second],
              scanRoots: [tempDir, beforeDir, wrongDir],
            });
            return { status: "selected", path: selected };
          },
        }),
        loadZoxideEntries: async () => [
          { path: first, score: 10, rank: 1 },
          { path: second, score: 9, rank: 2 },
          { path: selected, score: 8, rank: 3 },
        ],
      }),
    ).toEqual({ code: 0 });

    expect(stdout).toEqual([selected]);
    expect(stderr).toEqual(["zdr: opening picker..."]);
    expect(telemetry).toEqual([
      {
        kind: "recovery",
        outcome: "picker-selected",
        durationMs: expect.any(Number),
        data: {
          query: "ascan",
          mode: "picker",
          rejected_path_count: 2,
          selected_path: selected,
          candidate_count: 3,
        },
      },
    ]);
  });

  test("third no-arg recovery reports picker cancellation", async () => {
    const telemetry: TelemetryInput[] = [];
    await recordFinishedZAttempt("recovery-cancel", join(tempDir, "wrong"), ["ascan"]);
    await seedRejectedRecoveryPaths(["/repo/wrong-1", "/repo/wrong-2"]);

    expect(
      await main([], {
        ...testDeps({
          appendTelemetryEvent: async (event) => telemetry.push(event),
          runPicker: async () => ({ status: "cancelled" }),
        }),
        loadZoxideEntries: async () => [{ path: "/repo/right", score: 10, rank: 1 }],
      }),
    ).toEqual({ code: 1 });

    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["zdr: opening picker...", "zdr: picker cancelled"]);
    expect(telemetry).toEqual([
      {
        kind: "recovery",
        outcome: "picker-cancelled",
        durationMs: expect.any(Number),
        data: {
          query: "ascan",
          mode: "picker",
          rejected_path_count: 2,
          candidate_count: 1,
        },
      },
    ]);
  });

  test("third no-arg recovery reports unavailable picker dependency", async () => {
    const telemetry: TelemetryInput[] = [];
    await recordFinishedZAttempt("recovery-unavailable", join(tempDir, "wrong"), ["ascan"]);
    await seedRejectedRecoveryPaths(["/repo/wrong-1", "/repo/wrong-2"]);

    expect(
      await main([], {
        ...testDeps({
          appendTelemetryEvent: async (event) => telemetry.push(event),
          runPicker: async () => ({ status: "unavailable", reason: "fzf is required for interactive picker fallback" }),
        }),
        loadZoxideEntries: async () => [{ path: "/repo/right", score: 10, rank: 1 }],
      }),
    ).toEqual({ code: 1 });

    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["zdr: opening picker...", "zdr: fzf is required for interactive picker fallback"]);
    expect(telemetry).toEqual([
      {
        kind: "recovery",
        outcome: "picker-unavailable",
        durationMs: expect.any(Number),
        data: {
          query: "ascan",
          mode: "picker",
          rejected_path_count: 2,
          candidate_count: 1,
          error: "fzf is required for interactive picker fallback",
        },
      },
    ]);
  });

  test("third no-arg recovery filters broad picker scan parents", async () => {
    const selected = join(tempDir, "agentscan");
    await mkdir(selected);
    await recordFinishedZAttempt("recovery-broad-roots", "/Users/auro/wrong", ["ascan"], { beforePath: "/Users/auro" });
    await seedRejectedRecoveryPaths(["/repo/wrong-1", "/repo/wrong-2"]);

    expect(
      await main([], {
        ...testDeps({
          runPicker: async (input) => {
            expect(input.scanRoots).toEqual([tempDir, "/Users/auro", "/Users/auro/wrong"]);
            return { status: "selected", path: selected };
          },
        }),
        loadZoxideEntries: async () => [{ path: selected, score: 10, rank: 1 }],
      }),
    ).toEqual({ code: 0 });

    expect(stdout).toEqual([selected]);
    expect(stderr).toEqual(["zdr: opening picker..."]);
  });

  test("keeps recovery successful when telemetry fails", async () => {
    const selected = join(tempDir, "agentscan");
    await mkdir(selected);
    await recordFinishedZAttempt("recovery-telemetry-fails", join(tempDir, "wrong"), ["ascan"]);

    expect(
      await main([], {
        ...testDeps({
          appendTelemetryEvent: async () => {
            throw new Error("telemetry is read-only");
          },
        }),
        loadZoxideEntries: async () => [{ path: selected, score: 10, rank: 1 }],
        selectCandidate: async ({ candidates }) => selectionResult(candidates[0] ?? null),
      }),
    ).toEqual({ code: 0 });

    expect(stdout).toEqual([selected]);
    expect(stderr).toEqual([]);
  });
});

function testDeps(
  input: {
    lookup?: CorrectionLookup;
    storeCorrection?: StoreCorrection;
    runPicker?: RunPicker;
    appendTelemetryEvent?: AppendTelemetryEvent;
    readTelemetryEvents?: ReadTelemetryEvents;
    pruneTelemetryEvents?: PruneTelemetryEvents;
    loadConfig?: LoadConfig;
    setProviderConfig?: (provider: LoadedConfig["config"]["provider"]) => Promise<LoadedConfig>;
    scanLocalDirectories?: ScanLocalDirectories;
    providerLogin?: (provider: string, callbacks: OAuthLoginCallbacks) => Promise<void>;
    providerLogout?: (provider: string) => Promise<boolean>;
    providerAuthStatuses?: (providers?: string[]) => Promise<ProviderAuthStatus[]>;
    commandExists?: (command: string) => boolean;
  } = {},
) {
  return {
    lookupCorrection: input.lookup ? async () => input.lookup as CorrectionLookup : readCorrectionFromCache,
    inspectCorrection,
    storeCorrection: input.storeCorrection ?? storeCorrection,
    loadZoxideEntries: async () => {
      throw new Error("unexpected zoxide load");
    },
    scanLocalDirectories: input.scanLocalDirectories ?? (async () => []),
    selectCandidate: async () => {
      throw new Error("unexpected model selection");
    },
    runPicker: input.runPicker
      ? input.runPicker
      : async () => {
          throw new Error("unexpected picker");
        },
    appendTelemetryEvent: input.appendTelemetryEvent ?? (async () => {}),
    readTelemetryEvents: input.readTelemetryEvents ?? (async () => []),
    pruneTelemetryEvents:
      input.pruneTelemetryEvents ??
      (async () => ({
        kept: 0,
        pruned: 0,
        dropped_invalid: 0,
      })),
    loadConfig: input.loadConfig ?? (async () => defaultLoadedConfig()),
    setProviderConfig:
      input.setProviderConfig ??
      (async () => {
        throw new Error("unexpected provider config write");
      }),
    providerLogin:
      input.providerLogin ??
      (async () => {
        throw new Error("unexpected provider login");
      }),
    providerLogout:
      input.providerLogout ??
      (async () => {
        throw new Error("unexpected provider logout");
      }),
    providerAuthStatuses:
      input.providerAuthStatuses ??
      (async () => {
        throw new Error("unexpected provider auth status");
      }),
    commandExists: input.commandExists ?? (() => false),
    cwd: () => tempDir,
    now: () => new Date("2026-05-18T00:00:00.000Z"),
  };
}

function defaultLoadedConfig(overrides: Partial<LoadedConfig["config"]> = {}): LoadedConfig {
  const base: LoadedConfig["config"] = {
    schema_version: 1,
    provider: {
      name: "openrouter",
      model: "google/gemini-2.5-flash-lite",
    },
    privacy: {
      redact_home: true,
      redact_emails: true,
      redact_secrets: true,
      redact_tokens: true,
    },
    telemetry: {
      enabled: true,
      max_events: 1000,
    },
  };
  return {
    path: join(tempDir, "config.json"),
    source: "default",
    config: {
      ...base,
      ...overrides,
      provider: {
        ...base.provider,
        ...overrides.provider,
      },
      privacy: {
        ...base.privacy,
        ...overrides.privacy,
      },
      telemetry: {
        ...base.telemetry,
        ...overrides.telemetry,
      },
    },
  };
}

async function recordFinishedZAttempt(
  attemptId: string,
  afterPath: string,
  queryArgv: string[],
  options: { beforePath?: string } = {},
): Promise<void> {
  await main(["record-z", "--attempt", attemptId, "--before", options.beforePath ?? tempDir, "--shell", "zsh", "--", ...queryArgv]);
  await main(["finish-z", "--attempt", attemptId, "--after", afterPath, "--status", "0"]);
  stdout = [];
  stderr = [];
}

async function seedRejectedRecoveryPaths(paths: string[]): Promise<void> {
  for (const path of paths) {
    await main([], {
      ...testDeps(),
      loadZoxideEntries: async () => [{ path, score: 10, rank: 1 }],
      selectCandidate: async ({ candidates }) => selectionResult(candidates[0] ?? null),
    });
  }
  stdout = [];
  stderr = [];
}

async function readCorrectionFromCache(query: string): Promise<CorrectionLookup> {
  const { lookupCorrection } = await import("./corrections.js");
  return lookupCorrection(query);
}

function runZshRuntimeTest(zshScript: string): { skipped: boolean; output: string; stderr: string } {
  return runShellRuntimeTest("zsh", "zsh smoke ran", zshScript);
}

function runBashRuntimeTest(bashScript: string): { skipped: boolean; output: string; stderr: string } {
  return runShellRuntimeTest("bash", "bash smoke ran", bashScript);
}

function runShellRuntimeTest(shellName: "zsh" | "bash", smokeLine: string, shellScript: string): { skipped: boolean; output: string; stderr: string } {
  const result = Bun.spawnSync({
    cmd: [
      "bash",
      "-lc",
      `
        command -v ${shellName} >/dev/null || { echo "${shellName} unavailable"; exit 0; }
        tmp=$(mktemp -d)
        mkdir -p "$tmp/bin" "$tmp/home" "$tmp/target dir" "$tmp/state" "$tmp/config"
        cat > "$tmp/bin/zdr" <<'ZDR'
#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$ZDR_LOG"
case "$1" in
  record-z|finish-z|clear-recovery-retry|debug-state|debug-candidates|debug-select|debug-corrections|debug-events|debug-timing|debug-provider-timing|benchmark-provider|doctor|config-provider|prune-events|forget|init|--*|-*)
    if [ "$1" = "--version" ]; then
      printf '0.0.0-test\\n'
    fi
    exit 0
    ;;
  debug-config)
    printf '{"source":"test"}\\n'
    exit 0
    ;;
  provider-smoke)
    printf '{"provider":"test"}\\n'
    exit 0
    ;;
esac
printf '%s\\n' "$ZDR_TARGET"
ZDR
        chmod +x "$tmp/bin/zdr"
        cat > "$tmp/test.${shellName}" <<'SHELL'
${shellScript}
SHELL
        : > "$tmp/log"
        PATH="$tmp/bin:$PATH" \\
          ZDR_LOG="$tmp/log" \\
          ZDR_ORIGINAL_Z_LOG="$tmp/original-z.log" \\
          ZDR_TARGET="$tmp/target dir" \\
          HOME="$tmp/home" \\
          XDG_STATE_HOME="$tmp/state" \\
          XDG_CONFIG_HOME="$tmp/config" \\
          ${shellName} "$tmp/test.${shellName}"
        status=$?
        echo "${smokeLine}"
        cat "$tmp/log"
        rm -rf "$tmp"
        exit "$status"
      `,
    ],
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });

  const output = result.stdout.toString();
  expect(result.exitCode).toBe(0);
  return {
    skipped: output.includes(`${shellName} unavailable`),
    output,
    stderr: result.stderr.toString(),
  };
}

function runFishRuntimeTest(fishScript: string): { skipped: boolean; output: string; stderr: string } {
  const result = Bun.spawnSync({
    cmd: [
      "bash",
      "-lc",
      `
        command -v fish >/dev/null || { echo "fish unavailable"; exit 0; }
        tmp=$(mktemp -d)
        mkdir -p "$tmp/bin" "$tmp/home" "$tmp/target dir" "$tmp/state" "$tmp/config"
        cat > "$tmp/bin/zdr" <<'ZDR'
#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$ZDR_LOG"
case "$1" in
  record-z|finish-z|clear-recovery-retry|debug-state|debug-candidates|debug-select|debug-corrections|debug-events|debug-timing|debug-provider-timing|benchmark-provider|doctor|config-provider|prune-events|forget|init|--*|-*)
    if [ "$1" = "--version" ]; then
      printf '0.0.0-test\\n'
    fi
    exit 0
    ;;
  debug-config)
    printf '{"source":"test"}\\n'
    exit 0
    ;;
  provider-smoke)
    printf '{"provider":"test"}\\n'
    exit 0
    ;;
esac
printf '%s\\n' "$ZDR_TARGET"
ZDR
        chmod +x "$tmp/bin/zdr"
        cat > "$tmp/test.fish" <<'FISH'
${fishScript}
FISH
        : > "$tmp/log"
        PATH="$tmp/bin:$PATH" \\
          ZDR_LOG="$tmp/log" \\
          ZDR_ORIGINAL_Z_LOG="$tmp/original-z.log" \\
          ZDR_TARGET="$tmp/target dir" \\
          HOME="$tmp/home" \\
          XDG_STATE_HOME="$tmp/state" \\
          XDG_CONFIG_HOME="$tmp/config" \\
          fish --no-config "$tmp/test.fish"
        status=$?
        echo "fish smoke ran"
        cat "$tmp/log"
        rm -rf "$tmp"
        exit "$status"
      `,
    ],
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });

  const output = result.stdout.toString();
  expect(result.exitCode).toBe(0);
  return {
    skipped: output.includes("fish unavailable"),
    output,
    stderr: result.stderr.toString(),
  };
}

type StoreCorrection = (input: { query: string; path: string; now?: Date }) => Promise<CorrectionEntry>;
type RunPicker = (input: PickerInput) => Promise<PickerResult>;
type AppendTelemetryEvent = (input: TelemetryInput) => Promise<unknown>;
type ReadTelemetryEvents = (input?: { limit?: number }) => Promise<TelemetryEvent[]>;
type PruneTelemetryEvents = (input: { maxEvents: number }) => Promise<TelemetryPruneResult>;
type LoadConfig = () => Promise<LoadedConfig>;
type ScanLocalDirectories = (input: { query: string; roots: string[]; maxResults?: number }) => Promise<string[]>;

function selectionResult(candidate: Candidate | null, reason = "selected", confidence = candidate ? 0.8 : 0, usage: unknown = null) {
  return {
    selection: {
      candidate_id: candidate?.id ?? null,
      confidence,
      reason,
    },
    candidate,
    raw_text: "",
    usage,
  };
}

function providerUsage() {
  return {
    input: 100,
    output: 25,
    cacheRead: 40,
    cacheWrite: 10,
    totalTokens: 175,
    cost: {
      input: 0.001,
      output: 0.002,
      cacheRead: 0.0001,
      cacheWrite: 0.0005,
      total: 0.0036,
    },
  };
}

type TimingPayload = {
  schema_version: 1;
  command: "debug-timing" | "debug-provider-timing";
  total_duration_ms: number;
  budget_ms?: number;
  within_budget?: boolean;
  measurements: Array<{
    name: string;
    ok: boolean;
    skipped?: boolean;
    duration_ms: number;
    metadata?: Record<string, unknown>;
    error?: string;
  }>;
};

type BenchmarkProviderPayload = {
  schema_version: 1;
  command: "benchmark-provider";
  query: string;
  mode: "direct-query" | "recovery";
  repeat: number;
  provider: {
    name: string;
    model: string;
  };
  ok: boolean;
  total_duration_ms: number;
  context: Record<string, unknown>;
  summary: Record<string, unknown>;
  iterations: Array<{
    index: number;
    ok: boolean;
    duration_ms: number;
    metadata?: Record<string, unknown>;
    error?: string;
  }>;
};
