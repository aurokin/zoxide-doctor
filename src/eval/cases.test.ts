import { describe, expect, test } from "bun:test";
import { CASES, CATEGORIES, type EvalCase } from "./cases.js";
import { FIXTURE_DIR_SET } from "./fixture.js";
import { prepareCase } from "./runner.js";

// Cases whose expected directory is intentionally NOT discoverable at the
// candidate stage (adversarial recall failures). Documented in docs/evals.md.
const KNOWN_RECALL_MISSES = new Set(["abbr-papermario"]);

function expectedPaths(evalCase: EvalCase): string[] {
  if (evalCase.expected === null) {
    return [];
  }
  return Array.isArray(evalCase.expected) ? evalCase.expected : [evalCase.expected];
}

function referencedPaths(evalCase: EvalCase): string[] {
  const paths: string[] = [...expectedPaths(evalCase)];
  for (const entry of evalCase.db) {
    paths.push(entry.path);
  }
  if (evalCase.wrongLanding) {
    paths.push(evalCase.wrongLanding);
  }
  for (const rejected of evalCase.rejectedPaths ?? []) {
    paths.push(rejected);
  }
  if (evalCase.beforePwd) {
    paths.push(evalCase.beforePwd);
  }
  return paths;
}

describe("cases corpus", () => {
  test("has 45-60 cases spread across every category", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(45);
    expect(CASES.length).toBeLessThanOrEqual(60);
    for (const category of CATEGORIES) {
      const count = CASES.filter((evalCase) => evalCase.category === category).length;
      expect(count).toBeGreaterThanOrEqual(3);
    }
  });

  test("case ids are unique", () => {
    const ids = CASES.map((evalCase) => evalCase.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every referenced path exists in the fixture (catches corpus typos)", () => {
    for (const evalCase of CASES) {
      for (const path of referencedPaths(evalCase)) {
        const relative = path.replace(/^~\//, "");
        if (!FIXTURE_DIR_SET.has(relative)) {
          throw new Error(`case ${evalCase.id} references path not in fixture: ${path}`);
        }
      }
    }
  });

  test("every accepted expected path is present in its own db", () => {
    for (const evalCase of CASES) {
      const dbPaths = new Set(evalCase.db.map((entry) => entry.path));
      for (const expected of expectedPaths(evalCase)) {
        expect(dbPaths.has(expected)).toBe(true);
      }
    }
  });

  test("recovery cases set a wrong landing that is in their db", () => {
    for (const evalCase of CASES.filter((item) => item.mode === "recovery")) {
      expect(evalCase.wrongLanding).toBeDefined();
      const dbPaths = new Set(evalCase.db.map((entry) => entry.path));
      expect(dbPaths.has(evalCase.wrongLanding as string)).toBe(true);
    }
  });

  test("escalation cases reject a path that is in their db", () => {
    for (const evalCase of CASES.filter((item) => item.category === "escalation")) {
      expect((evalCase.rejectedPaths ?? []).length).toBeGreaterThan(0);
      const dbPaths = new Set(evalCase.db.map((entry) => entry.path));
      for (const rejected of evalCase.rejectedPaths ?? []) {
        expect(dbPaths.has(rejected)).toBe(true);
      }
    }
  });

  test("every accepted expected path is discoverable in candidates (except documented recall misses)", () => {
    for (const evalCase of CASES) {
      if (evalCase.expected === null) {
        continue;
      }
      const prepared = prepareCase(evalCase, "/fake/home");
      for (const expected of prepared.expectedPaths) {
        const found = prepared.candidates.some((candidate) => candidate.path === expected);
        if (KNOWN_RECALL_MISSES.has(evalCase.id)) {
          expect(found).toBe(false);
        } else if (!found) {
          throw new Error(`case ${evalCase.id} expected path is not in candidates: ${expected}`);
        }
      }
    }
  });

  test("rejected paths never appear in candidates", () => {
    for (const evalCase of CASES.filter((item) => (item.rejectedPaths ?? []).length > 0)) {
      const prepared = prepareCase(evalCase, "/fake/home");
      for (const rejected of prepared.rejectedPaths) {
        expect(prepared.candidates.some((candidate) => candidate.path === rejected)).toBe(false);
      }
    }
  });
});
