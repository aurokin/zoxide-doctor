import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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
  return !["0", "false", "off", "no"].includes(value.toLowerCase());
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
  await appendFile(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
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

function homeDir(env: NodeJS.ProcessEnv): string {
  if (env.HOME && env.HOME.length > 0) {
    return env.HOME;
  }
  throw new Error("HOME is required to resolve XDG state path");
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
