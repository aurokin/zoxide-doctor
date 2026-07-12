import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FIXTURE_DIRS, FIXTURE_DIR_SET, FIXTURE_REPOS, materializeFixture, resolveFixturePath } from "./fixture.js";

describe("fixture", () => {
  test("declares a large, unique directory set", () => {
    expect(FIXTURE_DIRS.length).toBeGreaterThanOrEqual(180);
    expect(new Set(FIXTURE_DIRS).size).toBe(FIXTURE_DIRS.length);
  });

  test("includes the adversarial landmark directories", () => {
    for (const path of [
      "code/agentscan",
      "code/ascan-archive",
      "work/mega/packages/billing-worker",
      "work/mega/packages/design-system/src/components",
      "emu/pm64-decomp",
      "backup/2024-01-code-old/agentscan",
    ]) {
      expect(FIXTURE_DIR_SET.has(path)).toBe(true);
    }
  });

  test("marks repos as a subset of the directory set", () => {
    expect(FIXTURE_REPOS.size).toBeGreaterThan(20);
    for (const repo of FIXTURE_REPOS) {
      expect(FIXTURE_DIR_SET.has(repo)).toBe(true);
    }
  });

  test("resolveFixturePath handles ~, relative, and slash-prefixed paths", () => {
    expect(resolveFixturePath("/root", "~")).toBe("/root");
    expect(resolveFixturePath("/root", "~/code/agentscan")).toBe("/root/code/agentscan");
    expect(resolveFixturePath("/root", "code/agentscan")).toBe("/root/code/agentscan");
    expect(resolveFixturePath("/root", "/code/agentscan")).toBe("/root/code/agentscan");
  });

  describe("materializeFixture", () => {
    let root: string;

    beforeAll(async () => {
      const dir = await mkdtemp(join(tmpdir(), "zdr-fixture-test-"));
      root = (await materializeFixture(dir)).root;
    });

    afterAll(async () => {
      await rm(root, { recursive: true, force: true });
    });

    test("creates every declared directory on disk", async () => {
      const materialized = await materializeFixture(root);
      expect(materialized.dirs.length).toBe(FIXTURE_DIRS.length);
      const spotChecks = ["code/agentscan", "work/mega/packages/design-system/src/components", "emu/pm64-decomp"];
      for (const relative of spotChecks) {
        const absolute = materialized.byRelative[relative];
        expect(absolute).toBeDefined();
        const info = await stat(absolute as string);
        expect(info.isDirectory()).toBe(true);
      }
    });
  });
});
