import { describe, expect, test } from "bun:test";
import { runProviderBenchmark, summarizeProviderBenchmark, type ProviderBenchmarkContext } from "./benchmark.js";
import type { Candidate } from "./candidates.js";

describe("provider benchmark", () => {
  test("summarizes latency, selected paths, tokens, and cost", () => {
    expect(
      summarizeProviderBenchmark([
        {
          index: 1,
          ok: true,
          duration_ms: 10,
          metadata: {
            selected_path: "/tmp/agentscan",
            provider_timings: { provider_complete_ms: 8 },
            provider_usage: { total_tokens: 100, cost_total: 0.01 },
          },
        },
        {
          index: 2,
          ok: true,
          duration_ms: 20,
          metadata: {
            selected_path: "/tmp/agentscan",
            provider_timings: { provider_complete_ms: 18 },
            provider_usage: { total_tokens: 200, cost_total: 0.03 },
          },
        },
        {
          index: 3,
          ok: false,
          duration_ms: 5,
          error: "provider unavailable",
        },
      ]),
    ).toMatchObject({
      iteration_count: 3,
      success_count: 2,
      failure_count: 1,
      selection_duration_ms: {
        min: 10,
        p50: 10,
        p95: 20,
        max: 20,
        average: 15,
      },
      provider_complete_ms: {
        min: 8,
        p50: 8,
        p95: 18,
        max: 18,
        average: 13,
      },
      selected_paths: {
        "/tmp/agentscan": 2,
      },
      usage: {
        total_tokens: 300,
        average_tokens: 150,
        cost_total: 0.04,
        average_cost: 0.02,
      },
    });
  });

  test("runs iterations and reports failures without aborting the benchmark", async () => {
    const context = benchmarkContext();
    const events: number[] = [];
    let calls = 0;

    const result = await runProviderBenchmark({
      context,
      provider: { name: "openrouter", model: "google/gemini-2.5-flash-lite" },
      privacy: {
        redact_home: true,
        redact_emails: true,
        redact_secrets: true,
        redact_tokens: true,
      },
      repeat: 2,
      selectCandidate: async ({ candidates }) => {
        calls += 1;
        if (calls === 2) {
          throw new Error("provider unavailable");
        }
        return {
          selection: { candidate_id: "c001", confidence: 0.9, reason: "selected" },
          candidate: candidates[0] ?? null,
          raw_text: "",
          usage: null,
        };
      },
      onIteration: (iteration) => events.push(iteration.index),
      now: fakeClock([0, 10, 20, 30, 50]),
    });

    expect(result.ok).toBe(false);
    expect(result.iterations).toMatchObject([
      {
        index: 1,
        ok: true,
        duration_ms: 10,
      },
      {
        index: 2,
        ok: false,
        duration_ms: 20,
        error: "provider unavailable",
      },
    ]);
    expect(result.summary).toMatchObject({
      iteration_count: 2,
      success_count: 1,
      failure_count: 1,
    });
    expect(events).toEqual([1, 2]);
  });
});

function benchmarkContext(): ProviderBenchmarkContext {
  return {
    state: {
      schema_version: 1,
      status: "finished",
      attempt_id: "direct-query",
      query_argv: ["ascan"],
      before_pwd: "/tmp",
      after_pwd: "",
      exit_status: 0,
      shell: "direct-query",
      started_at: "2026-05-18T00:00:00.000Z",
      finished_at: "2026-05-18T00:00:00.000Z",
    },
    rejectedPaths: [],
    candidates: [candidate("/tmp/agentscan")],
    entryCount: 1,
  };
}

function candidate(path: string): Candidate {
  return {
    id: "c001",
    path,
    display_path: path,
    zoxide_rank: 1,
    zoxide_score: 10,
    lexical_score: 100,
    total_score: 110,
    reasons: ["test"],
    wrong_landing_candidate: false,
  };
}

function fakeClock(values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}
