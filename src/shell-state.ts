import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type PendingZState = {
  schema_version: 1;
  status: "pending";
  attempt_id: string;
  query_argv: string[];
  before_pwd: string;
  shell: string;
  started_at: string;
};

export type FinishedZState = {
  schema_version: 1;
  status: "finished";
  attempt_id: string;
  query_argv: string[];
  before_pwd: string;
  after_pwd: string;
  exit_status: number;
  shell: string;
  started_at: string;
  finished_at: string;
};

export type ZState = PendingZState | FinishedZState;

export type RecoveryRetryState = {
  schema_version: 1;
  status: "recovery_retry";
  z_attempt_id: string;
  query_argv: string[];
  wrong_landing_path: string;
  rejected_paths: string[];
  updated_at: string;
};

export type StatePaths = {
  stateDir: string;
  lastZ: string;
  pendingDir: string;
  recoveryRetry: string;
};

export function getStatePaths(env: NodeJS.ProcessEnv = process.env): StatePaths {
  const base = env.XDG_STATE_HOME && env.XDG_STATE_HOME.length > 0 ? env.XDG_STATE_HOME : join(homeDir(env), ".local", "state");
  const stateDir = join(base, "zdr");
  return {
    stateDir,
    lastZ: join(stateDir, "last_z.json"),
    pendingDir: join(stateDir, "pending"),
    recoveryRetry: join(stateDir, "recovery_retry.json"),
  };
}

export async function recordZAttempt(input: {
  attemptId: string;
  beforePwd: string;
  queryArgv: string[];
  shell?: string;
}): Promise<PendingZState> {
  assertAttemptId(input.attemptId);
  const state: PendingZState = {
    schema_version: 1,
    status: "pending",
    attempt_id: input.attemptId,
    query_argv: input.queryArgv,
    before_pwd: input.beforePwd,
    shell: input.shell ?? detectShell(),
    started_at: new Date().toISOString(),
  };
  await writeJsonAtomic(pendingPath(input.attemptId), state);
  return state;
}

export async function finishZAttempt(input: {
  attemptId: string;
  afterPwd: string;
  exitStatus: number;
}): Promise<FinishedZState> {
  assertAttemptId(input.attemptId);
  const pending = await readJson<PendingZState>(pendingPath(input.attemptId));
  if (!pending || pending.status !== "pending") {
    throw new Error("no pending z attempt found");
  }

  const state: FinishedZState = {
    schema_version: 1,
    status: "finished",
    attempt_id: pending.attempt_id,
    query_argv: pending.query_argv,
    before_pwd: pending.before_pwd,
    after_pwd: input.afterPwd,
    exit_status: input.exitStatus,
    shell: pending.shell,
    started_at: pending.started_at,
    finished_at: new Date().toISOString(),
  };
  const paths = getStatePaths();
  await writeJsonAtomic(paths.lastZ, state);
  await rm(pendingPath(input.attemptId), { force: true });
  return state;
}

export async function readLastZState(): Promise<FinishedZState | null> {
  const state = await readJson<ZState>(getStatePaths().lastZ);
  if (!state || state.status !== "finished") {
    return null;
  }
  return state;
}

export async function readRecoveryRetryState(): Promise<RecoveryRetryState | null> {
  const state = await readJson<RecoveryRetryState>(getStatePaths().recoveryRetry);
  if (!state || state.status !== "recovery_retry" || state.schema_version !== 1) {
    return null;
  }
  return state;
}

export async function readRecoveryRetryForAttempt(state: FinishedZState): Promise<RecoveryRetryState | null> {
  const retry = await readRecoveryRetryState();
  if (!retry || retry.z_attempt_id !== state.attempt_id || !arrayEquals(retry.query_argv, state.query_argv)) {
    return null;
  }
  return retry;
}

export async function writeRecoveryRetry(input: {
  state: FinishedZState;
  rejectedPath: string;
  existing?: RecoveryRetryState | null;
}): Promise<RecoveryRetryState> {
  const rejected = new Set(input.existing?.rejected_paths ?? []);
  rejected.add(input.rejectedPath);
  const retry: RecoveryRetryState = {
    schema_version: 1,
    status: "recovery_retry",
    z_attempt_id: input.state.attempt_id,
    query_argv: input.state.query_argv,
    wrong_landing_path: input.state.after_pwd,
    rejected_paths: Array.from(rejected),
    updated_at: new Date().toISOString(),
  };
  await writeJsonAtomic(getStatePaths().recoveryRetry, retry);
  return retry;
}

export async function clearRecoveryRetry(): Promise<void> {
  await rm(getStatePaths().recoveryRetry, { force: true });
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, path);
}

function pendingPath(attemptId: string): string {
  return join(getStatePaths().pendingDir, `${attemptId}.json`);
}

function assertAttemptId(attemptId: string): void {
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(attemptId)) {
    throw new Error("invalid z attempt id");
  }
}

function detectShell(): string {
  const shell = process.env.SHELL;
  if (!shell) {
    return "unknown";
  }
  return shell.split("/").at(-1) || shell;
}

function arrayEquals(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function homeDir(env: NodeJS.ProcessEnv): string {
  if (env.HOME && env.HOME.length > 0) {
    return env.HOME;
  }
  throw new Error("HOME is required to resolve XDG state path");
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
