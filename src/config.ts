import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type ZdrConfig = {
  schema_version: 1;
  provider: {
    name: string;
    model: string;
  };
  privacy: {
    redact_home: boolean;
    redact_emails: boolean;
    redact_secrets: boolean;
    redact_tokens: boolean;
  };
  telemetry: {
    enabled: boolean;
    max_events: number;
  };
};

export type ConfigPaths = {
  configDir: string;
  config: string;
};

export type LoadedConfig = {
  path: string;
  source: "default" | "file";
  config: ZdrConfig;
};

export const DEFAULT_CONFIG: ZdrConfig = {
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
    enabled: false,
    max_events: 1000,
  },
};

const TOP_LEVEL_KEYS = ["schema_version", "provider", "privacy", "telemetry"];
const PROVIDER_KEYS = ["name", "model"];
const PRIVACY_KEYS = ["redact_home", "redact_emails", "redact_secrets", "redact_tokens"];
const TELEMETRY_KEYS = ["enabled", "max_events"];
const MAX_TELEMETRY_EVENTS = 100_000;

export function getConfigPaths(env: NodeJS.ProcessEnv = process.env): ConfigPaths {
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0 ? env.XDG_CONFIG_HOME : join(homeDir(env), ".config");
  const configDir = join(base, "zdr");
  return {
    configDir,
    config: join(configDir, "config.json"),
  };
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<LoadedConfig> {
  const path = getConfigPaths(env).config;
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isNotFound(error)) {
      return {
        path,
        source: "default",
        config: DEFAULT_CONFIG,
      };
    }
    throw error;
  }

  return {
    path,
    source: "file",
    config: mergeConfig(raw),
  };
}

export async function setProviderConfig(
  provider: ZdrConfig["provider"],
  env: NodeJS.ProcessEnv = process.env,
): Promise<LoadedConfig> {
  const current = await loadConfig(env);
  const config: ZdrConfig = {
    ...current.config,
    provider,
  };
  const path = getConfigPaths(env).config;
  await writeConfigFile(path, config);
  return {
    path,
    source: "file",
    config,
  };
}

function mergeConfig(raw: unknown): ZdrConfig {
  if (!isRecord(raw)) {
    throw new Error("config did not match expected schema");
  }
  rejectUnknownKeys(raw, TOP_LEVEL_KEYS, "config");
  if (raw.schema_version !== undefined && raw.schema_version !== 1) {
    throw new Error("config schema_version must be 1");
  }

  const provider = optionalRecord(raw.provider, "provider");
  const privacy = optionalRecord(raw.privacy, "privacy");
  const telemetry = optionalRecord(raw.telemetry, "telemetry");
  rejectUnknownKeys(provider, PROVIDER_KEYS, "config provider");
  rejectUnknownKeys(privacy, PRIVACY_KEYS, "config privacy");
  rejectUnknownKeys(telemetry, TELEMETRY_KEYS, "config telemetry");

  return {
    schema_version: 1,
    provider: {
      name: optionalString(provider.name, DEFAULT_CONFIG.provider.name, "provider.name"),
      model: optionalString(provider.model, DEFAULT_CONFIG.provider.model, "provider.model"),
    },
    privacy: {
      redact_home: optionalBoolean(privacy.redact_home, DEFAULT_CONFIG.privacy.redact_home, "privacy.redact_home"),
      redact_emails: optionalBoolean(privacy.redact_emails, DEFAULT_CONFIG.privacy.redact_emails, "privacy.redact_emails"),
      redact_secrets: optionalBoolean(privacy.redact_secrets, DEFAULT_CONFIG.privacy.redact_secrets, "privacy.redact_secrets"),
      redact_tokens: optionalBoolean(privacy.redact_tokens, DEFAULT_CONFIG.privacy.redact_tokens, "privacy.redact_tokens"),
    },
    telemetry: {
      enabled: optionalBoolean(telemetry.enabled, DEFAULT_CONFIG.telemetry.enabled, "telemetry.enabled"),
      max_events: optionalNonNegativeInteger(telemetry.max_events, DEFAULT_CONFIG.telemetry.max_events, "telemetry.max_events"),
    },
  };
}

function optionalRecord(value: unknown, key: string): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error(`config ${key} must be an object`);
  }
  return value;
}

function optionalString(value: unknown, fallback: string, key: string): string {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`config ${key} must be a non-empty string`);
  }
  return value;
}

function optionalBoolean(value: unknown, fallback: boolean, key: string): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new Error(`config ${key} must be a boolean`);
  }
  return value;
}

function optionalNonNegativeInteger(value: unknown, fallback: number, key: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_TELEMETRY_EVENTS) {
    throw new Error(`config ${key} must be an integer between 0 and ${MAX_TELEMETRY_EVENTS}`);
  }
  return value;
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unsupported key: ${unknown[0]}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function homeDir(env: NodeJS.ProcessEnv): string {
  if (env.HOME && env.HOME.length > 0) {
    return env.HOME;
  }
  throw new Error("HOME is required to resolve XDG config path");
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function writeConfigFile(path: string, config: ZdrConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmpPath, `${JSON.stringify(config, null, 2)}\n`);
    await rename(tmpPath, path);
  } catch (error) {
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
}
