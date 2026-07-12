import { describe, expect, test } from "bun:test";
import type { Candidate } from "../candidates.js";
import type { SelectionResult } from "../provider/select.js";
import type { EvalCase } from "./cases.js";
import {
  createLiveBackend,
  type BackendSelectionInput,
  type EvalBackend,
  parseBackendSpec,
  prepareCase,
  runLive,
  runRecall,
  scoreRecallCase,
} from "./runner.js";

const ROOT = "/fake/home";

function pickResult(candidate: Candidate | null): SelectionResult {
  return {
    selection: {
      candidate_id: candidate?.id ?? null,
      confidence: 0.9,
      reason: "fake",
    },
    candidate,
    raw_text: "{}",
    usage: { total_tokens: 12 },
  };
}

// A fully controllable fake backend keyed off the case id (encoded in the
// state attempt_id as `eval-<id>`). Never touches the real backend module.
function fakeBackend(id: string, decide: (caseId: string, input: BackendSelectionInput) => Candidate | null): EvalBackend {
  return {
    id,
    async select(input) {
      const caseId = input.state.attempt_id.replace(/^eval-/, "");
      return pickResult(decide(caseId, input));
    },
  };
}

function candidateByPathSuffix(input: BackendSelectionInput, suffix: string): Candidate | null {
  return input.candidates.find((candidate) => candidate.path.endsWith(suffix)) ?? null;
}

describe("runRecall", () => {
  test("scores a known-answer setup: found at rank 1, lexical win", () => {
    const cases: EvalCase[] = [
      {
        id: "s-api",
        category: "abbreviation",
        description: "synthetic",
        query: "api",
        mode: "direct",
        expected: "code/api",
        db: [
          { path: "code/api", score: 5 },
          { path: "code/backend", score: 3 },
        ],
      },
    ];
    const report = runRecall(cases, ROOT);
    expect(report.overall.total).toBe(1);
    expect(report.overall.found).toBe(1);
    expect(report.overall.recall).toBe(1);
    expect(report.cases[0]?.rank).toBe(1);
    expect(report.cases[0]?.topLexicalIsExpected).toBe(true);
    expect(report.misses.length).toBe(0);
  });

  test("null-expected cases are reported separately and are recall-exempt", () => {
    const cases: EvalCase[] = [
      {
        id: "s-null",
        category: "no-answer",
        description: "synthetic",
        query: "zzz",
        mode: "direct",
        expected: null,
        db: [{ path: "code/blog", score: 5 }],
      },
    ];
    const report = runRecall(cases, ROOT);
    expect(report.overall.total).toBe(0);
    expect(report.nullCases.length).toBe(1);
    expect(report.nullCases[0]?.id).toBe("s-null");
  });

  test("detects a recall miss when expected falls below the candidate limit", () => {
    const junk = Array.from({ length: 55 }, (_, index) => ({ path: `junk/d${index}`, score: index + 1 }));
    const evalCase: EvalCase = {
      id: "s-buried",
      category: "abbreviation",
      description: "synthetic buried",
      query: "qqqq",
      mode: "direct",
      expected: "junk/target",
      db: [{ path: "junk/target", score: 0.1 }, ...junk],
    };
    const result = scoreRecallCase(prepareCase(evalCase, ROOT));
    expect("expectedPath" in result).toBe(true);
    if ("expectedPath" in result) {
      expect(result.found).toBe(false);
      expect(result.rank).toBeNull();
    }
  });
});

const LIVE_CASES: EvalCase[] = [
  {
    id: "L1",
    category: "abbreviation",
    description: "non-null, backend correct",
    query: "api",
    mode: "direct",
    expected: "code/api",
    db: [{ path: "code/api", score: 5 }],
  },
  {
    id: "L2",
    category: "no-answer",
    description: "null-expected, backend predicts null",
    query: "zzz",
    mode: "direct",
    expected: null,
    db: [{ path: "code/blog", score: 5 }],
  },
  {
    id: "L3",
    category: "abbreviation",
    description: "non-null, backend wrongly predicts null",
    query: "backend",
    mode: "direct",
    expected: "code/backend",
    db: [{ path: "code/backend", score: 5 }],
  },
];

describe("runLive", () => {
  test("computes accuracy, null-precision, null-recall, and misses", async () => {
    const backend = fakeBackend("good", (caseId, input) => {
      if (caseId === "L1") {
        return candidateByPathSuffix(input, "/code/api");
      }
      // L2 and L3 both predict null.
      return null;
    });

    const report = await runLive([backend], LIVE_CASES, ROOT);
    const summary = report.summaries[0];
    expect(summary).toBeDefined();
    if (!summary) {
      return;
    }
    expect(summary.runs).toBe(3);
    expect(summary.correct).toBe(2); // L1 correct, L2 correct-null, L3 wrong
    expect(summary.accuracy).toBe(0.667);
    expect(summary.errorCount).toBe(0);
    expect(summary.nullPrecision).toBe(0.5); // predicted null on L2,L3; only L2 was expected-null
    expect(summary.nullRecall).toBe(1); // the one expected-null (L2) was caught
    expect(summary.misses.map((miss) => miss.caseId)).toEqual(["L3"]);
    expect(summary.latencyP50).not.toBeNull();
  });

  test("records carry the full jsonl shape", async () => {
    const backend = fakeBackend("good", (_caseId, input) => input.candidates[0] ?? null);
    const report = await runLive([backend], [LIVE_CASES[0] as EvalCase], ROOT);
    const record = report.records[0];
    expect(record).toBeDefined();
    if (!record) {
      return;
    }
    expect(Object.keys(record).sort()).toEqual(
      [
        "backendId",
        "caseId",
        "category",
        "confidence",
        "correct",
        "error",
        "expectedPath",
        "isNullExpected",
        "latencyMs",
        "pickedPath",
        "predictedNull",
        "query",
        "repeat",
        "usage",
      ].sort(),
    );
    expect(record.backendId).toBe("good");
    expect(record.error).toBeNull();
  });

  test("repeat produces one record per case per iteration", async () => {
    const backend = fakeBackend("good", (_caseId, input) => input.candidates[0] ?? null);
    const report = await runLive([backend], [LIVE_CASES[0] as EvalCase], ROOT, { repeat: 3 });
    expect(report.records.length).toBe(3);
    expect(report.records.map((record) => record.repeat)).toEqual([1, 2, 3]);
  });

  test("thrown backend errors are counted as errors, not silent wrong picks", async () => {
    const backend: EvalBackend = {
      id: "boom",
      async select() {
        throw new Error("provider exploded");
      },
    };
    const report = await runLive([backend], [LIVE_CASES[0] as EvalCase], ROOT);
    const summary = report.summaries[0];
    expect(summary?.errorCount).toBe(1);
    expect(summary?.correct).toBe(0);
    expect(summary?.errors[0]?.error).toBe("provider exploded");
    expect(summary?.misses.length).toBe(0); // errors tracked separately from misses
  });

  test("a hanging backend is cut off by the timeout guard", async () => {
    const backend: EvalBackend = {
      id: "hang",
      select() {
        return new Promise<SelectionResult>(() => {});
      },
    };
    const report = await runLive([backend], [LIVE_CASES[0] as EvalCase], ROOT, { timeoutMs: 20 });
    const record = report.records[0];
    expect(record?.error).toContain("timed out");
    expect(record?.correct).toBe(false);
  });

  test("concurrency runs all tasks and preserves counts", async () => {
    const backend = fakeBackend("good", (_caseId, input) => input.candidates[0] ?? null);
    const report = await runLive([backend], LIVE_CASES, ROOT, { repeat: 2, concurrency: 4 });
    expect(report.records.length).toBe(6);
    expect(report.summaries[0]?.runs).toBe(6);
  });
});

describe("parseBackendSpec", () => {
  test("parses pi and claude specs", () => {
    expect(parseBackendSpec("pi:openai-codex:gpt-5.3-codex-spark").tier).toEqual({
      backend: "pi",
      name: "openai-codex",
      model: "gpt-5.3-codex-spark",
    });
    expect(parseBackendSpec("claude:haiku").tier).toEqual({ backend: "claude", model: "haiku" });
  });

  test("rejects malformed specs", () => {
    expect(() => parseBackendSpec("pi:onlyprovider")).toThrow();
    expect(() => parseBackendSpec("claude:")).toThrow();
    expect(() => parseBackendSpec("openai:gpt")).toThrow();
  });

  test("createLiveBackend wraps a spec without importing the real backend module", () => {
    const backend = createLiveBackend(parseBackendSpec("claude:haiku"));
    expect(backend.id).toBe("claude:haiku");
    expect(typeof backend.select).toBe("function");
  });
});
