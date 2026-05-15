import type { Candidate } from "./candidates.js";
import type { FinishedZState } from "./shell-state.js";

export type SelectionResponse = {
  candidate_id: string | null;
  confidence: number;
  reason: string;
};

export function buildSelectionPrompt(input: {
  state: FinishedZState;
  candidates: Candidate[];
}): { systemPrompt: string; userMessage: string } {
  const query = input.state.query_argv.join(" ").trim();
  const candidateBlock = input.candidates
    .map((candidate) => {
      const flags = candidate.wrong_landing_candidate ? " wrong_landing_candidate=true" : "";
      return `${candidate.id}. ${sanitizeForPrompt(candidate.display_path)}${flags}`;
    })
    .join("\n");

  return {
    systemPrompt: [
      "You are zdr, a directory disambiguation helper for the zoxide CLI tool.",
      "Given a user's short query, recorded zoxide jump context, and candidate directories, return the single best candidate ID the user most likely intended to navigate to.",
      "Recognize abbreviations, initialisms, and partial matches that simple substring search would miss.",
      "Do not choose a candidate marked wrong_landing_candidate unless every other candidate is clearly worse.",
      'Output strict JSON only: {"candidate_id":"c001","confidence":0.0,"reason":"short reason"}',
      'If no candidate is good, output: {"candidate_id":null,"confidence":0.0,"reason":"why"}',
    ].join("\n"),
    userMessage: [
      "=== Stable prefix ===",
      `Candidates (ranked, top ${input.candidates.length}):`,
      candidateBlock,
      "",
      "=== Volatile tail ===",
      `Query: ${sanitizeForPrompt(query)}`,
      `Before pwd: ${sanitizeForPrompt(redactPath(input.state.before_pwd))}`,
      `Landed pwd: ${sanitizeForPrompt(redactPath(input.state.after_pwd))}`,
      `Zoxide exit status: ${input.state.exit_status}`,
    ].join("\n"),
  };
}

export function parseSelectionResponse(raw: string, candidates: Candidate[]): SelectionResponse {
  const parsed = JSON.parse(extractJson(raw)) as unknown;
  if (!isSelectionResponse(parsed)) {
    throw new Error("model response did not match selection schema");
  }
  if (parsed.candidate_id !== null && !candidates.some((candidate) => candidate.id === parsed.candidate_id)) {
    throw new Error(`model selected unknown candidate_id: ${parsed.candidate_id}`);
  }
  return parsed;
}

function extractJson(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("model response did not contain JSON");
  }
  return trimmed.slice(start, end + 1);
}

function isSelectionResponse(value: unknown): value is SelectionResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const maybe = value as Record<string, unknown>;
  return (
    (typeof maybe.candidate_id === "string" || maybe.candidate_id === null) &&
    typeof maybe.confidence === "number" &&
    Number.isFinite(maybe.confidence) &&
    maybe.confidence >= 0 &&
    maybe.confidence <= 1 &&
    typeof maybe.reason === "string"
  );
}

function redactPath(path: string): string {
  const home = process.env.HOME;
  if (home && path === home) {
    return "~";
  }
  if (home && path.startsWith(`${home}/`)) {
    return `~/${path.slice(home.length + 1)}`;
  }
  return path.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}

function sanitizeForPrompt(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\b(?:sk|ghp|github_pat|glpat|xox[baprs]?)-[A-Za-z0-9_-]{12,}\b/gi, "[redacted-secret]")
    .replace(/\b[a-f0-9]{32,}\b/gi, "[redacted-token]")
    .replace(/\b(?=[A-Za-z0-9_-]{24,}\b)(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_-]+\b/g, "[redacted-token]");
}
