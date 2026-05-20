import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export type TelemetryKind = "recovery" | "direct-query" | "cache" | "picker" | "provider";

export type TelemetryEvent = {
  schema_version: 1;
  kind: TelemetryKind;
  outcome: string;
  occurred_at: string;
  duration_ms?: number;
  data?: Record<string, unknown>;
};

export type TelemetryInput = {
  kind: TelemetryKind;
  outcome: string;
  occurredAt?: Date;
  durationMs?: number;
  data?: Record<string, unknown>;
};

export type TelemetryPaths = {
  stateDir: string;
  events: string;
};

export type TelemetryWriteResult = "written" | "disabled";

const TELEMETRY_LOCK_STALE_MS = 5_000;
const TELEMETRY_LOCK_TIMEOUT_MS = TELEMETRY_LOCK_STALE_MS + 1_000;

export type TelemetryPruneResult = {
  kept: number;
  pruned: number;
  dropped_invalid: number;
};

export function getTelemetryPaths(env: NodeJS.ProcessEnv = process.env): TelemetryPaths {
  const base = env.XDG_STATE_HOME && env.XDG_STATE_HOME.length > 0 ? env.XDG_STATE_HOME : join(homeDir(env), ".local", "state");
  const stateDir = join(base, "zdr");
  return {
    stateDir,
    events: join(stateDir, "events.jsonl"),
  };
}

export function telemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.ZDR_TELEMETRY;
  if (!value) {
    return true;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "off", "no"].includes(normalized)) {
    return false;
  }
  return false;
}

export async function appendTelemetryEvent(
  input: TelemetryInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TelemetryWriteResult> {
  if (!telemetryEnabled(env)) {
    return "disabled";
  }
  const event = normalizeTelemetryEvent(input);
  const path = getTelemetryPaths(env).events;
  await mkdir(dirname(path), { recursive: true });
  await withTelemetryLock(path, async () => {
    await appendFile(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  });
  return "written";
}

export async function readTelemetryEvents(input: { limit?: number } = {}): Promise<TelemetryEvent[]> {
  const path = getTelemetryPaths().events;
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return [];
    }
    throw error;
  }
  const events = text
    .split(/\r?\n/)
    .map(parseTelemetryLine)
    .filter((event): event is TelemetryEvent => event !== null);
  return input.limit === undefined ? events : events.slice(-Math.max(0, input.limit));
}

export async function pruneTelemetryEvents(input: { maxEvents: number }): Promise<TelemetryPruneResult> {
  const path = getTelemetryPaths().events;
  await mkdir(dirname(path), { recursive: true });
  return withTelemetryLock(path, async () => {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (isNotFound(error)) {
        return { kept: 0, pruned: 0, dropped_invalid: 0 };
      }
      throw error;
    }

    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const events = lines.map(parseTelemetryLine).filter((event): event is TelemetryEvent => event !== null);
    const keptEvents = events.slice(-Math.max(0, input.maxEvents));
    await writeTelemetryEventsAtomic(path, keptEvents);
    return {
      kept: keptEvents.length,
      pruned: events.length - keptEvents.length,
      dropped_invalid: lines.length - events.length,
    };
  });
}

function normalizeTelemetryEvent(input: TelemetryInput): TelemetryEvent {
  return {
    schema_version: 1,
    kind: input.kind,
    outcome: input.outcome,
    occurred_at: (input.occurredAt ?? new Date()).toISOString(),
    ...(input.durationMs === undefined ? {} : { duration_ms: input.durationMs }),
    ...(input.data === undefined ? {} : { data: input.data }),
  };
}

function parseTelemetryLine(line: string): TelemetryEvent | null {
  if (line.trim().length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(line) as unknown;
    return isTelemetryEvent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isTelemetryEvent(value: unknown): value is TelemetryEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const maybe = value as Record<string, unknown>;
  return (
    maybe.schema_version === 1 &&
    isTelemetryKind(maybe.kind) &&
    typeof maybe.outcome === "string" &&
    typeof maybe.occurred_at === "string" &&
    (maybe.duration_ms === undefined || (typeof maybe.duration_ms === "number" && Number.isFinite(maybe.duration_ms))) &&
    (maybe.data === undefined || (typeof maybe.data === "object" && maybe.data !== null && !Array.isArray(maybe.data)))
  );
}

function isTelemetryKind(value: unknown): value is TelemetryKind {
  return value === "recovery" || value === "direct-query" || value === "cache" || value === "picker" || value === "provider";
}

async function writeTelemetryEventsAtomic(path: string, events: TelemetryEvent[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  const body = events.map((event) => JSON.stringify(event)).join("\n");
  await writeFile(tempPath, body.length === 0 ? "" : `${body}\n`, { mode: 0o600 });
  await rename(tempPath, path);
}

async function withTelemetryLock<T>(eventPath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${eventPath}.lock`;
  const token = randomUUID();
  const startedAt = Date.now();

  while (true) {
    try {
      await mkdir(lockPath);
      try {
        await writeTelemetryLockOwner(lockPath, token);
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
      if (await reclaimStaleTelemetryLock(lockPath)) {
        continue;
      }
      if (Date.now() - startedAt > TELEMETRY_LOCK_TIMEOUT_MS) {
        throw new Error("timed out waiting for telemetry lock");
      }
      await sleep(25);
    }
  }

  try {
    return await fn();
  } finally {
    await releaseTelemetryLock(lockPath, token);
  }
}

async function reclaimStaleTelemetryLock(lockPath: string): Promise<boolean> {
  try {
    const lockStat = await stat(lockPath);
    const owner = await readTelemetryLockOwner(lockPath);
    const heartbeat = await telemetryLockHeartbeat(lockPath, lockStat);
    const isStale = heartbeat.ageMs >= TELEMETRY_LOCK_STALE_MS;
    if (owner && (await telemetryLockOwnerIsActive(owner))) {
      return false;
    }
    if (isStale) {
      return removeTelemetryLockIfUnchanged(lockPath, observedTelemetryLock(lockStat, owner, heartbeat));
    }
    if (owner) {
      return removeTelemetryLockIfUnchanged(lockPath, observedTelemetryLock(lockStat, owner, heartbeat));
    }
    return false;
  } catch (error) {
    if (isNotFound(error)) {
      return true;
    }
    throw error;
  }
}

function observedTelemetryLock(
  lockStat: { dev: number; ino: number; mtimeMs: number },
  owner: TelemetryLockOwner | null,
  heartbeat: { ownerMtimeMs?: number },
): ObservedTelemetryLock {
  return {
    owner,
    dev: lockStat.dev,
    ino: lockStat.ino,
    mtimeMs: lockStat.mtimeMs,
    ...(heartbeat.ownerMtimeMs === undefined ? {} : { heartbeatMtimeMs: heartbeat.ownerMtimeMs }),
  };
}

type ObservedTelemetryLock = {
  owner: TelemetryLockOwner | null;
  dev: number;
  ino: number;
  mtimeMs: number;
  heartbeatMtimeMs?: number;
};

async function telemetryLockHeartbeat(
  lockPath: string,
  lockStat: { mtimeMs: number },
): Promise<{ ageMs: number; ownerMtimeMs?: number }> {
  try {
    const ownerStat = await stat(lockOwnerPath(lockPath));
    return {
      ageMs: Date.now() - ownerStat.mtimeMs,
      ownerMtimeMs: ownerStat.mtimeMs,
    };
  } catch (error) {
    if (isNotFound(error)) {
      return { ageMs: Date.now() - lockStat.mtimeMs };
    }
    throw error;
  }
}

async function removeTelemetryLockIfUnchanged(
  lockPath: string,
  observed: ObservedTelemetryLock,
): Promise<boolean> {
  const currentStat = await stat(lockPath);
  if (currentStat.dev !== observed.dev || currentStat.ino !== observed.ino || currentStat.mtimeMs !== observed.mtimeMs) {
    return false;
  }

  const currentHeartbeat = await telemetryLockHeartbeat(lockPath, currentStat);
  if (currentHeartbeat.ownerMtimeMs !== observed.heartbeatMtimeMs) {
    return false;
  }

  const currentOwner = await readTelemetryLockOwner(lockPath);
  if (!sameTelemetryLockOwner(currentOwner, observed.owner)) {
    return false;
  }

  await rm(lockPath, { recursive: true, force: true });
  return true;
}

type TelemetryLockOwner = {
  pid: number;
  token?: string;
  createdAt?: string;
};

async function writeTelemetryLockOwner(lockPath: string, token: string): Promise<void> {
  await writeFile(
    lockOwnerPath(lockPath),
    JSON.stringify({ pid: process.pid, token, created_at: new Date().toISOString() }),
    { mode: 0o600 },
  );
}

async function readTelemetryLockOwner(lockPath: string): Promise<TelemetryLockOwner | null> {
  try {
    const parsed = JSON.parse(await readFile(lockOwnerPath(lockPath), "utf8")) as unknown;
    const pid =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).pid
        : undefined;
    const token =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).token
        : undefined;
    const createdAt =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).created_at
        : undefined;
    if (
      typeof pid === "number" &&
      Number.isInteger(pid) &&
      pid > 0
    ) {
      return {
        pid,
        ...(typeof token === "string" ? { token } : {}),
        ...(typeof createdAt === "string" ? { createdAt } : {}),
      };
    }
    return null;
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

async function releaseTelemetryLock(lockPath: string, token: string): Promise<void> {
  const owner = await readTelemetryLockOwner(lockPath);
  if (owner?.token === token) {
    await rm(lockPath, { recursive: true, force: true });
  }
}

function lockOwnerPath(lockPath: string): string {
  return join(lockPath, "owner.json");
}

function sameTelemetryLockOwner(left: TelemetryLockOwner | null, right: TelemetryLockOwner | null): boolean {
  if (!left || !right) {
    return left === right;
  }
  return left.pid === right.pid && left.token === right.token && left.createdAt === right.createdAt;
}

async function telemetryLockOwnerIsActive(owner: TelemetryLockOwner): Promise<boolean> {
  if (!isProcessRunning(owner.pid)) {
    return false;
  }
  if (!owner.createdAt) {
    return true;
  }
  const lockCreatedAt = Date.parse(owner.createdAt);
  if (Number.isNaN(lockCreatedAt)) {
    return true;
  }
  const startedAt = await processStartedAt(owner.pid);
  if (!startedAt) {
    return true;
  }
  return startedAt.getTime() <= lockCreatedAt;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") {
      return false;
    }
    return true;
  }
}

async function processStartedAt(pid: number): Promise<Date | null> {
  const proc = Bun.spawn(["ps", "-p", String(pid), "-o", "lstart="], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const [output, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exitCode !== 0) {
    return null;
  }
  const startedAt = new Date(output.trim());
  return Number.isNaN(startedAt.getTime()) ? null : startedAt;
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

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
