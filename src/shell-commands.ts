import { parseFinishZArgs, parseRecordZArgs } from "./cli-args.js";
import { bashInitScript, fishInitScript, zshInitScript } from "./shell-init.js";
import {
  clearRecoveryRetry,
  finishZAttempt,
  recordZAttempt,
} from "./shell-state.js";

export type ShellCommandResult = {
  code: number;
};

export function initCommand(args: string[]): ShellCommandResult {
  const [shell] = args;
  switch (shell) {
    case "zsh":
      console.log(zshInitScript());
      return { code: 0 };
    case "bash":
      console.log(bashInitScript());
      return { code: 0 };
    case "fish":
      console.log(fishInitScript());
      return { code: 0 };
    default:
      console.error("zdr: supported shells: zsh, bash, fish");
      return { code: 2 };
  }
}

export async function recordZCommand(args: string[]): Promise<ShellCommandResult> {
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

export async function clearRecoveryRetryCommand(): Promise<ShellCommandResult> {
  await clearRecoveryRetry();
  return { code: 0 };
}

export async function finishZCommand(args: string[]): Promise<ShellCommandResult> {
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
