import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const DEFAULT_TIMEOUT_MS = 6_000;

export async function withFileLock<T>(
  targetPath: string,
  fn: () => Promise<T>,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const lockPath = `${targetPath}.lock`;
  const token = randomUUID();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  await mkdir(dirname(targetPath), { recursive: true });

  while (true) {
    try {
      await mkdir(lockPath);
      try {
        await writeFile(ownerPath(lockPath), `${token}\n`, { mode: 0o600 });
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`timed out waiting for lock: ${targetPath}`);
      }
      await sleep(5);
    }
  }

  try {
    return await fn();
  } finally {
    await releaseLock(lockPath, token);
  }
}

async function releaseLock(lockPath: string, token: string): Promise<void> {
  try {
    const owner = (await readFile(ownerPath(lockPath), "utf8")).trim();
    if (owner === token) {
      await rm(lockPath, { recursive: true, force: true });
    }
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
}

function ownerPath(lockPath: string): string {
  return `${lockPath}/owner`;
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
