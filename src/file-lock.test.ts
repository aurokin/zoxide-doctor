import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { withFileLock } from "./file-lock.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "zdr-file-lock-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("withFileLock", () => {
  test("serializes critical sections", async () => {
    const target = join(tempDir, "state.json");
    const events: string[] = [];

    const first = withFileLock(target, async () => {
      events.push("first-start");
      await sleep(40);
      events.push("first-end");
    });
    await sleep(5);
    const second = withFileLock(target, async () => {
      events.push("second-start");
    });

    await Promise.all([first, second]);

    expect(events).toEqual(["first-start", "first-end", "second-start"]);
  });

  test("times out instead of deleting an existing lock", async () => {
    const target = join(tempDir, "state.json");
    await mkdir(`${target}.lock`, { recursive: true });
    await writeFile(`${target}.lock/owner`, "other-owner\n");

    await expect(
      withFileLock(
        target,
        async () => {
          await writeFile(target, "written");
        },
        { timeoutMs: 20 },
      ),
    ).rejects.toThrow("timed out waiting for lock");

    expect(await readFile(`${target}.lock/owner`, "utf8")).toBe("other-owner\n");
  });
});
