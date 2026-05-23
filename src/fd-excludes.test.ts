import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fdExcludeArgs } from "./fd-excludes.js";

describe("fdExcludeArgs", () => {
  test("converts excluded children to root-scoped fd exclude patterns", () => {
    expect(
      fdExcludeArgs({
        roots: ["/repo", "/workspace"],
        excludeRoots: ["/repo/private", "/repo/vendor/cache", "/elsewhere/private"],
      }),
    ).toEqual(["--exclude", "/private", "--exclude", "/vendor/cache"]);
  });

  test("dedupes exclude patterns across roots", () => {
    expect(
      fdExcludeArgs({
        roots: ["/repo", "/repo"],
        excludeRoots: ["/repo/private", "/repo/private"],
      }),
    ).toEqual(["--exclude", "/private"]);
  });

  test("root-scoped exclude patterns do not hide unrelated nested basenames", async () => {
    const hasFd = Bun.spawnSync({
      cmd: ["sh", "-c", "command -v fd"],
      stdout: "ignore",
      stderr: "ignore",
    }).exitCode === 0;
    if (!hasFd) {
      return;
    }

    const root = await mkdtemp(join(tmpdir(), "zdr-fd-excludes-"));
    try {
      await mkdir(join(root, "private", "project"), { recursive: true });
      await mkdir(join(root, "other", "private", "project"), { recursive: true });

      const output = Bun.spawnSync({
        cmd: [
          "fd",
          "--type",
          "d",
          "--hidden",
          "--color",
          "never",
          ...fdExcludeArgs({ roots: [root], excludeRoots: [join(root, "private")] }),
          ".",
          root,
        ],
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(output.exitCode).toBe(0);
      const paths = output.stdout
        .toString()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((path) => path.replace(`${root}/`, "").replace(/\/$/, ""));
      expect(paths).not.toContain("private");
      expect(paths).not.toContain("private/project");
      expect(paths).toContain("other/private");
      expect(paths).toContain("other/private/project");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
