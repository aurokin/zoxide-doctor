import { access, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type CorrectionEntry = {
  path: string;
  first_resolved: string;
  hits: number;
};

export type CorrectionCache = Record<string, CorrectionEntry>;

export type CorrectionLookup =
  | { status: "hit"; query: string; entry: CorrectionEntry }
  | { status: "miss"; query: string }
  | { status: "stale"; query: string; stalePath: string };

export type CachePaths = {
  cacheDir: string;
  corrections: string;
};

export function getCachePaths(env: NodeJS.ProcessEnv = process.env): CachePaths {
  const base = env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.length > 0 ? env.XDG_CACHE_HOME : join(homeDir(env), ".cache");
  const cacheDir = join(base, "zdr");
  return {
    cacheDir,
    corrections: join(cacheDir, "corrections.json"),
  };
}

export async function readCorrectionCache(): Promise<CorrectionCache> {
  const raw = await readJson<unknown>(getCachePaths().corrections);
  if (!raw) {
    return {};
  }
  if (!isCorrectionCache(raw)) {
    throw new Error("correction cache did not match expected schema");
  }
  return raw;
}

export async function writeCorrectionCache(cache: CorrectionCache): Promise<void> {
  await writeJsonAtomic(getCachePaths().corrections, cache);
}

export async function lookupCorrection(query: string): Promise<CorrectionLookup> {
  const cache = await readCorrectionCache();
  const entry = cache[query];
  if (!entry) {
    return { status: "miss", query };
  }

  if (!(await pathExists(entry.path))) {
    delete cache[query];
    await writeCorrectionCache(cache);
    return { status: "stale", query, stalePath: entry.path };
  }

  const updated = {
    ...entry,
    hits: entry.hits + 1,
  };
  cache[query] = updated;
  await writeCorrectionCache(cache);
  return { status: "hit", query, entry: updated };
}

export async function storeCorrection(input: {
  query: string;
  path: string;
  now?: Date;
}): Promise<CorrectionEntry> {
  await assertExistingPath(input.path);
  const cache = await readCorrectionCache();
  const existing = cache[input.query];
  const unchangedTarget = existing?.path === input.path;
  const entry: CorrectionEntry = {
    path: input.path,
    first_resolved: unchangedTarget && existing ? existing.first_resolved : (input.now ?? new Date()).toISOString(),
    hits: unchangedTarget && existing ? existing.hits : 0,
  };
  cache[input.query] = entry;
  await writeCorrectionCache(cache);
  return entry;
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

async function assertExistingPath(path: string): Promise<void> {
  try {
    await access(path);
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error(`correction target does not exist: ${path}`);
    }
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
}

function isCorrectionCache(value: unknown): value is CorrectionCache {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every(isCorrectionEntry);
}

function isCorrectionEntry(value: unknown): value is CorrectionEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const maybe = value as Record<string, unknown>;
  const hits = maybe.hits;
  return (
    typeof maybe.path === "string" &&
    typeof maybe.first_resolved === "string" &&
    typeof hits === "number" &&
    Number.isInteger(hits) &&
    hits >= 0
  );
}

function homeDir(env: NodeJS.ProcessEnv): string {
  if (env.HOME && env.HOME.length > 0) {
    return env.HOME;
  }
  throw new Error("HOME is required to resolve XDG cache path");
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
