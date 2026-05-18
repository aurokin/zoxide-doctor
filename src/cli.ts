#!/usr/bin/env bun

import packageJson from "../package.json" with { type: "json" };
import { buildCandidates } from "./candidates.js";
import { lookupCorrection } from "./corrections.js";
import {
  clearRecoveryRetry,
  finishZAttempt,
  readLastZState,
  readRecoveryRetryForAttempt,
  recordZAttempt,
  writeRecoveryRetry,
} from "./shell-state.js";
import { loadZoxideEntries } from "./zoxide.js";

type CommandResult = {
  code: number;
};

const VERSION = packageJson.version;

export async function main(argv: string[]): Promise<CommandResult> {
  const [command, ...args] = argv;

  if (command === "--help" || command === "-h") {
    printHelp();
    return { code: 0 };
  }

  if (!command) {
    return recoverCommand();
  }

  if (command === "--version" || command === "-V") {
    console.log(VERSION);
    return { code: 0 };
  }

  switch (command) {
    case "init":
      return initCommand(args);
    case "record-z":
      return recordZCommand(args);
    case "finish-z":
      return finishZCommand(args);
    case "clear-recovery-retry":
      return clearRecoveryRetryCommand();
    case "debug-state":
      return debugStateCommand();
    case "debug-candidates":
      return debugCandidatesCommand(args);
    case "debug-select":
      return debugSelectCommand(args);
    case "provider-smoke":
      return providerSmokeCommand(args);
    default:
      if (command.startsWith("-")) {
        console.error(`zdr: unknown option: ${command}`);
        return { code: 2 };
      }
      return directQueryCommand([command, ...args]);
  }
}

function initCommand(args: string[]): CommandResult {
  const [shell] = args;
  if (shell !== "zsh") {
    console.error("zdr: only `zdr init zsh` is scaffolded right now");
    return { code: 2 };
  }

  console.log(zshInitScript());
  return { code: 0 };
}

async function recordZCommand(args: string[]): Promise<CommandResult> {
  const parsed = parseRecordZArgs(args);
  if (!parsed.ok) {
    console.error(`zdr: ${parsed.error}`);
    return { code: 2 };
  }

  await clearRecoveryRetry();
  await recordZAttempt({
    attemptId: parsed.attemptId,
    beforePwd: parsed.beforePwd,
    queryArgv: parsed.queryArgv,
    ...(parsed.shell ? { shell: parsed.shell } : {}),
  });
  return { code: 0 };
}

async function clearRecoveryRetryCommand(): Promise<CommandResult> {
  await clearRecoveryRetry();
  return { code: 0 };
}

async function finishZCommand(args: string[]): Promise<CommandResult> {
  const parsed = parseFinishZArgs(args);
  if (!parsed.ok) {
    console.error(`zdr: ${parsed.error}`);
    return { code: 2 };
  }

  try {
    await finishZAttempt({
      attemptId: parsed.attemptId,
      afterPwd: parsed.afterPwd,
      exitStatus: parsed.exitStatus,
    });
    return { code: 0 };
  } catch (error) {
    console.error(`zdr: ${error instanceof Error ? error.message : String(error)}`);
    return { code: 1 };
  }
}

async function debugStateCommand(): Promise<CommandResult> {
  const state = await readLastZState();
  if (!state) {
    console.error("zdr: no recorded z attempt found");
    return { code: 1 };
  }
  console.log(JSON.stringify(state, null, 2));
  return { code: 0 };
}

async function debugCandidatesCommand(args: string[]): Promise<CommandResult> {
  const limit = parseLimit(args);
  if (!limit.ok) {
    console.error(`zdr: ${limit.error}`);
    return { code: 2 };
  }

  const state = await readLastZState();
  if (!state) {
    console.error("zdr: no recorded z attempt found");
    return { code: 1 };
  }

  try {
    const entries = await loadZoxideEntries();
    const candidates = buildCandidates({
      state,
      entries,
      limit: limit.value,
    });
    console.log(
      JSON.stringify(
        {
          query: state.query_argv.join(" "),
          before_pwd: state.before_pwd,
          after_pwd: state.after_pwd,
          candidate_count: candidates.length,
          candidates,
        },
        null,
        2,
      ),
    );
    return { code: 0 };
  } catch (error) {
    console.error(`zdr: ${error instanceof Error ? error.message : String(error)}`);
    return { code: 1 };
  }
}

async function debugSelectCommand(args: string[]): Promise<CommandResult> {
  const limit = parseLimit(args);
  if (!limit.ok) {
    console.error(`zdr: ${limit.error}`);
    return { code: 2 };
  }

  try {
    const { state, result, rejectedPaths } = await runSelection(limit.value);
    console.log(
      JSON.stringify(
        {
          query: state.query_argv.join(" "),
          rejected_paths: rejectedPaths,
          selected_candidate_id: result.selection.candidate_id,
          confidence: result.selection.confidence,
          reason: result.selection.reason,
          candidate: result.candidate,
          usage: result.usage,
          raw_text: result.raw_text,
        },
        null,
        2,
      ),
    );
    return { code: 0 };
  } catch (error) {
    console.error(`zdr: ${error instanceof Error ? error.message : String(error)}`);
    return { code: 1 };
  }
}

async function recoverCommand(): Promise<CommandResult> {
  try {
    const { state, result, retry } = await runSelection(50, { announceRetry: true });
    if (!result.candidate) {
      console.error(result.selection.reason ? `zdr: ${result.selection.reason}` : "zdr: no candidate selected");
      return { code: 1 };
    }
    await writeRecoveryRetry({
      state,
      rejectedPath: result.candidate.path,
      existing: retry,
    });
    console.log(result.candidate.path);
    return { code: 0 };
  } catch (error) {
    console.error(`zdr: ${error instanceof Error ? error.message : String(error)}`);
    return { code: 1 };
  }
}

async function directQueryCommand(queryArgv: string[]): Promise<CommandResult> {
  const query = queryArgv.join(" ").trim();
  if (query.length === 0) {
    console.error("zdr: direct query requires a non-empty query");
    return { code: 2 };
  }

  try {
    const lookup = await lookupCorrection(query);
    if (lookup.status === "hit") {
      console.log(lookup.entry.path);
      return { code: 0 };
    }
    if (lookup.status === "stale") {
      console.error(`zdr: cached correction for ${JSON.stringify(query)} no longer exists`);
      return { code: 1 };
    }
    console.error(`zdr: no cached correction for ${JSON.stringify(query)}`);
    return { code: 1 };
  } catch (error) {
    console.error(`zdr: ${error instanceof Error ? error.message : String(error)}`);
    return { code: 1 };
  }
}

async function runSelection(limit: number, options: { announceRetry?: boolean } = {}) {
  const state = await readLastZState();
  if (!state) {
    throw new Error("no recorded z attempt found");
  }

  const entries = await loadZoxideEntries();
  const retry = await readRecoveryRetryForAttempt(state);
  const rejectedPaths = retry?.rejected_paths ?? [];
  if (retry && options.announceRetry) {
    console.error("zdr: thinking harder...");
  }
  const candidates = buildCandidates({
    state,
    entries,
    limit,
    rejectedPaths,
  });
  const { selectCandidate } = await import("./provider/select.js");
  const result = await selectCandidate({ state, candidates, rejectedPaths });
  return { state, candidates, result, retry, rejectedPaths };
}

async function providerSmokeCommand(args: string[]): Promise<CommandResult> {
  const { smokePiOpenRouter } = await import("./provider/pi.js");
  return smokePiOpenRouter({ live: args.includes("--live") });
}

function printHelp(): void {
  console.log(`zdr ${VERSION}

Usage:
  zdr                 Repair the last bad zoxide jump
  zdr <query>         Direct lookup from correction cache
  zdr init zsh        Print zsh integration (placeholder)
  zdr record-z        Internal shell-state command
  zdr finish-z        Internal shell-state command
  zdr clear-recovery-retry
                      Internal shell-state command
  zdr debug-state     Print recorded z state
  zdr debug-candidates
                      Print candidate list for the recorded z state
  zdr debug-select   Ask the model to select from recorded candidates
  zdr provider-smoke  Verify Pi/OpenRouter import and model lookup
  zdr provider-smoke --live
                      Make a tiny live OpenRouter completion
  zdr --version       Print version
`);
}

function zshInitScript(): string {
  return [
    "# zoxide-doctor zsh integration",
    "#",
    "# Source this after zoxide has initialized its z function.",
    "",
    "if ! typeset -f z >/dev/null 2>&1; then",
    '  echo "zdr: zoxide function \'z\' is not defined; run zoxide init before zdr init" >&2',
    "else",
    "  if ! typeset -f __zdr_original_z >/dev/null 2>&1; then",
    "    functions[__zdr_original_z]=$functions[z]",
    "  fi",
    "",
    "  z() {",
    '    local __zdr_attempt="zsh-${$}-${EPOCHREALTIME}-${RANDOM}"',
    '    __zdr_attempt="${__zdr_attempt//[^A-Za-z0-9_.-]/_}"',
    '    local __zdr_before="$PWD"',
    '    command zdr record-z --attempt "$__zdr_attempt" --before "$__zdr_before" --shell zsh -- "$@"',
    '    __zdr_original_z "$@"',
    "    local __zdr_status=$?",
    '    command zdr finish-z --attempt "$__zdr_attempt" --after "$PWD" --status "$__zdr_status"',
    '    return "$__zdr_status"',
    "  }",
    "fi",
    "",
    "zdr() {",
    "  case \"$1\" in",
    "    init|record-z|finish-z|clear-recovery-retry|debug-state|debug-candidates|debug-select|provider-smoke|--*|-*)",
    "      command zdr \"$@\"",
    "      return $?",
    "      ;;",
    "  esac",
    "",
    "  local __zdr_target",
    '  __zdr_target=$(command zdr "$@")',
    "  local __zdr_status=$?",
    '  if [ $__zdr_status -eq 0 ] && [ -n "$__zdr_target" ]; then',
    '    cd "$__zdr_target"',
    "    return $?",
    "  fi",
    "  return $__zdr_status",
    "}",
    "",
    "_zdr_preexec() {",
    '  case "$1" in',
    "    zdr) ;;",
    "    *)",
    '      local __zdr_retry="${XDG_STATE_HOME:-$HOME/.local/state}/zdr/recovery_retry.json"',
    '      [[ -e "$__zdr_retry" ]] && rm -f "$__zdr_retry"',
    "      ;;",
    "  esac",
    "}",
    "",
    'if [[ -z "${preexec_functions[(r)_zdr_preexec]}" ]]; then',
    "  preexec_functions+=(_zdr_preexec)",
    "fi",
  ].join("\n");
}

type RecordZArgs =
  | { ok: true; attemptId: string; beforePwd: string; shell?: string; queryArgv: string[] }
  | { ok: false; error: string };

function parseRecordZArgs(args: string[]): RecordZArgs {
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

type LimitArgs = { ok: true; value: number } | { ok: false; error: string };

function parseLimit(args: string[]): LimitArgs {
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

type FinishZArgs =
  | { ok: true; attemptId: string; afterPwd: string; exitStatus: number }
  | { ok: false; error: string };

function parseFinishZArgs(args: string[]): FinishZArgs {
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

if (import.meta.main) {
  const result = await main(Bun.argv.slice(2));
  process.exit(result.code);
}
