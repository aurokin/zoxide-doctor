import { describe, expect, test } from "bun:test";
import type { Candidate } from "./candidates.js";
import { buildSelectionPrompt, parseSelectionResponse } from "./prompt.js";
import type { FinishedZState } from "./shell-state.js";

const state: FinishedZState = {
  schema_version: 1,
  status: "finished",
  attempt_id: "test",
  query_argv: ["john@example.com", "sk-test_1234567890abcdef"],
  before_pwd: "/Users/auro/code/abcdefabcdefabcdefabcdefabcdefab",
  after_pwd: "/Users/auro/code/john@example.com",
  exit_status: 0,
  shell: "zsh",
  started_at: "2026-05-14T00:00:00.000Z",
  finished_at: "2026-05-14T00:00:01.000Z",
};

const candidates: Candidate[] = [
  {
    id: "c001",
    path: "/Users/auro/code/secret",
    display_path: "~/code/john@example.com/abc123abc123abc123abc123abc123",
    zoxide_rank: 1,
    zoxide_score: 1,
    lexical_score: 1,
    total_score: 1,
    reasons: [],
    wrong_landing_candidate: false,
  },
];

describe("buildSelectionPrompt", () => {
  test("redacts sensitive query and path data before provider calls", () => {
    const prompt = buildSelectionPrompt({
      state,
      candidates,
      rejectedPaths: ["/Users/auro/code/rejected-secret@example.com"],
    });

    expect(prompt.userMessage).toContain("[redacted-email]");
    expect(prompt.userMessage).toContain("[redacted-secret]");
    expect(prompt.userMessage).toContain("[redacted-token]");
    expect(prompt.userMessage).toContain("Already tried wrong:");
    expect(prompt.userMessage).not.toContain("john@example.com");
    expect(prompt.userMessage).not.toContain("rejected-secret@example.com");
    expect(prompt.userMessage).not.toContain("sk-test_1234567890abcdef");
    expect(prompt.userMessage).not.toContain("abcdefabcdefabcdefabcdefabcdefab");
  });

  test("honors privacy redaction settings", () => {
    const prompt = buildSelectionPrompt({
      state,
      candidates,
      privacy: {
        redact_home: false,
        redact_emails: false,
        redact_secrets: true,
        redact_tokens: true,
      },
    });

    expect(prompt.userMessage).toContain("/Users/auro/code");
    expect(prompt.userMessage).toContain("john@example.com");
    expect(prompt.userMessage).toContain("/Users/auro/code/secret");
    expect(prompt.userMessage).toContain("[redacted-secret]");
    expect(prompt.userMessage).toContain("[redacted-token]");
    expect(prompt.userMessage).not.toContain("sk-test_1234567890abcdef");
  });
});

describe("parseSelectionResponse", () => {
  test("accepts strict JSON selection", () => {
    expect(
      parseSelectionResponse('{"candidate_id":"c001","confidence":0.75,"reason":"good match"}', candidates),
    ).toEqual({
      candidate_id: "c001",
      confidence: 0.75,
      reason: "good match",
    });
  });

  test("extracts JSON from surrounding text", () => {
    expect(
      parseSelectionResponse('thinking...\n{"candidate_id":null,"confidence":0,"reason":"none"}', candidates),
    ).toEqual({
      candidate_id: null,
      confidence: 0,
      reason: "none",
    });
  });

  test("rejects unknown candidate IDs", () => {
    expect(() =>
      parseSelectionResponse('{"candidate_id":"c999","confidence":0.75,"reason":"bad id"}', candidates),
    ).toThrow("unknown candidate_id");
  });

  test("rejects invalid confidence", () => {
    expect(() =>
      parseSelectionResponse('{"candidate_id":"c001","confidence":2,"reason":"too high"}', candidates),
    ).toThrow("selection schema");
  });
});
