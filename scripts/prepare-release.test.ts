import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("release preparation script", () => {
  test("contains the release checks in order", async () => {
    const source = await Bun.file("scripts/prepare-release.ts").text();

    expect(source.indexOf('"bun", "run", "verify"')).toBeGreaterThan(-1);
    expect(source.indexOf('"bun", "run", "release:build"')).toBeGreaterThan(source.indexOf('"bun", "run", "verify"'));
    expect(source.indexOf('"bun", "run", "release:formula"')).toBeGreaterThan(source.indexOf('"bun", "run", "release:build"'));
    expect(source.indexOf('"ruby", "-c", "Formula/zoxide-doctor.rb"')).toBeGreaterThan(source.indexOf('"bun", "run", "release:formula"'));
    expect(source).toContain('"brew", "style", "Formula/zoxide-doctor.rb"');
    expect(source).toContain('commandExists("brew")');
  });

  test("fails clearly when run outside the project", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "zdr-release-prepare-"));
    try {
      const proc = Bun.spawn({
        cmd: ["bun", "run", join(process.cwd(), "scripts/prepare-release.ts")],
        cwd: tempDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      expect(exitCode).toBe(1);
      expect(stdout).toContain("==> verify");
      expect(stderr).toContain("release step failed");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
