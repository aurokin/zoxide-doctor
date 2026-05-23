import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Candidate } from "../candidates.js";
import type { FinishedZState } from "../shell-state.js";
import { selectCandidate } from "./select.js";

const completeSimple = mock(async () => ({
  content: [{ type: "text", text: malformedProviderText }],
  usage: null,
}));

const malformedProviderText = `${"x".repeat(150)} auro@example.com sk-live-secret0123456789abcdef 0123456789abcdef0123456789abcdef`;
let tempDir: string;
let previousXdgConfigHome: string | undefined;

mock.module("@earendil-works/pi-ai", () => ({
  completeSimple,
  getProviders: () => ["openrouter", "openai-codex", "fireworks"],
  getModels: (provider: string) =>
    ({
      "openai-codex": [{ id: "gpt-5.3-codex-spark" }],
      fireworks: [{ id: "accounts/fireworks/models/gpt-oss-20b" }],
      openrouter: [{ id: "google/gemini-2.5-flash-lite" }],
    })[provider] ?? [],
}));

beforeEach(async () => {
  previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  tempDir = await mkdtemp(join(tmpdir(), "zdr-select-"));
  process.env.XDG_CONFIG_HOME = tempDir;
});

afterEach(() => {
  completeSimple.mockClear();
  if (previousXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
  }
  return rm(tempDir, { recursive: true, force: true });
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
      maxTokens: 256,
      reasoning: "high",
    });
  });

  test("omits reasoning by default and reports timings", async () => {
    completeSimple.mockImplementationOnce(async () => ({
      content: [{ type: "text", text: '{"candidate_id":"c001","confidence":0.8,"reason":"selected"}' }],
      usage: null,
    }));

    const result = await selectCandidate({
      state: finishedZState(),
      candidates: [candidate()],
    });

    const call = completeSimple.mock.calls[0] as unknown[] | undefined;
    expect(call?.[2]).toMatchObject({
      maxTokens: 256,
    });
    expect(call?.[2]).not.toHaveProperty("reasoning");
    expect(result.timings).toMatchObject({
      model_resolve_ms: expect.any(Number),
      prompt_build_ms: expect.any(Number),
      provider_complete_ms: expect.any(Number),
      response_parse_ms: expect.any(Number),
      total_ms: expect.any(Number),
    });
  });

  test("normalizes OpenAI Codex options", async () => {
    completeSimple.mockImplementationOnce(async () => ({
      content: [{ type: "text", text: '{"candidate_id":"c001","confidence":0.8,"reason":"selected"}' }],
      usage: null,
    }));

    await selectCandidate({
      state: finishedZState(),
      candidates: [candidate()],
      provider: {
        name: "openai-codex",
        model: "gpt-5.3-codex-spark",
      },
    });

    const call = completeSimple.mock.calls[0] as unknown[] | undefined;
    expect(call?.[2]).toMatchObject({
      maxTokens: 256,
      reasoning: "minimal",
    });
    expect(call?.[2]).not.toHaveProperty("temperature");
  });

  test("defaults Fireworks to minimal reasoning", async () => {
    completeSimple.mockImplementationOnce(async () => ({
      content: [{ type: "text", text: '{"candidate_id":"c001","confidence":0.8,"reason":"selected"}' }],
      usage: null,
    }));

    await selectCandidate({
      state: finishedZState(),
      candidates: [candidate()],
      provider: {
        name: "fireworks",
        model: "accounts/fireworks/models/gpt-oss-20b",
      },
    });

    const call = completeSimple.mock.calls[0] as unknown[] | undefined;
    expect(call?.[2]).toMatchObject({
      maxTokens: 256,
      reasoning: "minimal",
      temperature: 0,
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
