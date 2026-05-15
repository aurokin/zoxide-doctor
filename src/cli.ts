#!/usr/bin/env bun

import packageJson from "../package.json" with { type: "json" };
import { buildCandidates } from "./candidates.js";
import { finishZAttempt, readLastZState, recordZAttempt } from "./shell-state.js";
import { loadZoxideEntries } from "./zoxide.js";

type CommandResult = {
  code: number;
};

const VERSION = packageJson.version;

async function main(argv: string[]): Promise<CommandResult> {
  const [command, ...args] = argv;

  if (command === "--help" || command === "-h") {
    printHelp();
    return { code: 0 };
  }

  if (!command) {
    console.error("zdr: recovery mode is not implemented yet");
    return { code: 2 };
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
      return placeholderCommand("direct-query");
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

  await recordZAttempt({
    attemptId: parsed.attemptId,
    beforePwd: parsed.beforePwd,
    queryArgv: parsed.queryArgv,
    ...(parsed.shell ? { shell: parsed.shell } : {}),
  });
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
    const { selectCandidate } = await import("./provider/select.js");
    const result = await selectCandidate({ state, candidates });
    console.log(
      JSON.stringify(
        {
          query: state.query_argv.join(" "),
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

function placeholderCommand(name: string): CommandResult {
  console.error(`zdr: ${name} is not implemented yet`);
  return { code: 2 };
}

async function providerSmokeCommand(args: string[]): Promise<CommandResult> {
  const { smokePiOpenRouter } = await import("./provider/pi.js");
  return smokePiOpenRouter({ live: args.includes("--live") });
}

function printHelp(): void {
  console.log(`zdr ${VERSION}

Usage:
  zdr                 Repair the last bad zoxide jump (not implemented yet)
  zdr <query>         Direct lookup mode (not implemented yet)
  zdr init zsh        Print zsh integration (placeholder)
  zdr record-z        Internal shell-state command
  zdr finish-z        Internal shell-state command
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
    "    init|record-z|finish-z|debug-state|debug-candidates|debug-select|provider-smoke|--*|-*)",
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
    '    *) rm -f "${XDG_CACHE_HOME:-$HOME/.cache}/zdr/escalate" ;;',
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

const result = await main(Bun.argv.slice(2));
process.exit(result.code);
