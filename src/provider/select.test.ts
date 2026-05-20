import { afterEach, describe, expect, mock, test } from "bun:test";
import type { Candidate } from "../candidates.js";
import type { FinishedZState } from "../shell-state.js";
import { selectCandidate } from "./select.js";

const completeSimple = mock(async () => ({
  content: [{ type: "text", text: malformedProviderText }],
  usage: null,
}));

const malformedProviderText = `${"x".repeat(150)} auro@example.com sk-live-secret0123456789abcdef 0123456789abcdef0123456789abcdef`;

mock.module("@earendil-works/pi-ai", () => ({
  completeSimple,
  getProviders: () => ["openrouter"],
  getModels: () => [{ id: "deepseek/deepseek-v4-flash" }],
}));

afterEach(() => {
  completeSimple.mockClear();
});

describe("selectCandidate", () => {
  test("redacts and bounds provider parse error previews", async () => {
    await expect(
      selectCandidate({
        state: finishedZState(),
        candidates: [candidate()],
      }),
    ).rejects.toThrow(
      `model response did not contain JSON; provider returned ${malformedProviderText.length} text chars; preview: ${"x".repeat(150)} `,
    );
    await expect(
      selectCandidate({
        state: finishedZState(),
        candidates: [candidate()],
      }),
    ).rejects.not.toThrow("auro@example.com");
    await expect(
      selectCandidate({
        state: finishedZState(),
        candidates: [candidate()],
      }),
    ).rejects.not.toThrow("sk-live-secret");
  });

  test("passes reasoning control to Pi when requested", async () => {
    completeSimple.mockImplementationOnce(async () => ({
      content: [{ type: "text", text: '{"candidate_id":"c001","confidence":0.8,"reason":"selected"}' }],
      usage: null,
    }));

    await selectCandidate({
      state: finishedZState(),
      candidates: [candidate()],
      reasoning: "high",
    });

    const call = completeSimple.mock.calls[0] as unknown[] | undefined;
    expect(call?.[2]).toMatchObject({
      reasoning: "high",
    });
  });
});

function candidate(): Candidate {
  return {
    id: "c001",
    path: "/tmp/agentscan",
    display_path: "/tmp/agentscan",
    zoxide_rank: 1,
    zoxide_score: 10,
    lexical_score: 10,
    total_score: 20,
    reasons: ["test"],
    wrong_landing_candidate: false,
  };
}

function finishedZState(): FinishedZState {
  return {
    schema_version: 1,
    status: "finished",
    attempt_id: "attempt-1",
    query_argv: ["ascan"],
    before_pwd: "/tmp",
    after_pwd: "/tmp/wrong",
    exit_status: 0,
    shell: "zsh",
    started_at: "2026-05-18T00:00:00.000Z",
    finished_at: "2026-05-18T00:00:01.000Z",
  };
}
