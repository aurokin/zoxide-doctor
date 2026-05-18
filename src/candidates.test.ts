import { describe, expect, test } from "bun:test";
import { buildCandidates } from "./candidates.js";
import type { FinishedZState } from "./shell-state.js";
import type { ZoxideEntry } from "./zoxide.js";

const baseState: FinishedZState = {
  schema_version: 1,
  status: "finished",
  attempt_id: "test",
  query_argv: ["ascan"],
  before_pwd: "/Users/auro/code",
  after_pwd: "/Users/auro/code/wrong",
  exit_status: 0,
  shell: "zsh",
  started_at: "2026-05-14T00:00:00.000Z",
  finished_at: "2026-05-14T00:00:01.000Z",
};

describe("buildCandidates", () => {
  test("ranks agentscan high for ascan", () => {
    const entries: ZoxideEntry[] = [
      { path: "/Users/auro/code", score: 100, rank: 1 },
      { path: "/Users/auro/code/agentscan", score: 5, rank: 2 },
      { path: "/Users/auro/code/agentchat", score: 4, rank: 3 },
    ];

    const candidates = buildCandidates({ state: baseState, entries, limit: 3 });

    expect(candidates[0]?.path).toBe("/Users/auro/code/agentscan");
    expect(candidates[0]?.id).toBe("c001");
    expect(candidates[0]?.reasons).toContain("basename subsequence");
  });

  test("always includes the wrong landing candidate even when outside limit", () => {
    const entries: ZoxideEntry[] = [
      { path: "/Users/auro/code/agentscan", score: 10, rank: 1 },
      { path: "/Users/auro/code/other", score: 9, rank: 2 },
      { path: "/Users/auro/code/wrong", score: 1, rank: 3 },
    ];

    const candidates = buildCandidates({ state: baseState, entries, limit: 1 });

    expect(candidates.some((candidate) => candidate.path === "/Users/auro/code/wrong")).toBe(true);
    expect(candidates.find((candidate) => candidate.path === "/Users/auro/code/wrong")?.wrong_landing_candidate).toBe(
      true,
    );
  });

  test("excludes rejected recovery paths before assigning candidate IDs", () => {
    const entries: ZoxideEntry[] = [
      { path: "/Users/auro/code/agentscan", score: 10, rank: 1 },
      { path: "/Users/auro/code/agentchat", score: 9, rank: 2 },
      { path: "/Users/auro/code/wrong", score: 8, rank: 3 },
    ];

    const candidates = buildCandidates({
      state: baseState,
      entries,
      rejectedPaths: ["/Users/auro/code/agentscan"],
      limit: 3,
    });

    expect(candidates.some((candidate) => candidate.path === "/Users/auro/code/agentscan")).toBe(false);
    expect(candidates[0]?.id).toBe("c001");
    expect(candidates[0]?.path).toBe("/Users/auro/code/agentchat");
  });
});
