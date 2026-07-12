import type { Candidate } from "./candidates.js";
import { DEFAULT_CONFIG, type ZdrConfig } from "./config.js";
import type { FinishedZState } from "./shell-state.js";

export type SelectionResponse = {
  candidate_id: string | null;
  confidence: number;
  reason: string;
};

export function buildSelectionPrompt(input: {
  state: FinishedZState;
  candidates: Candidate[];
  rejectedPaths?: string[];
  privacy?: ZdrConfig["privacy"];
}): { systemPrompt: string; userMessage: string } {
  const query = input.state.query_argv.join(" ").trim();
  const privacy = input.privacy ?? DEFAULT_CONFIG.privacy;
  const candidateBlock = input.candidates
    .map((candidate) => {
      const flags = candidate.wrong_landing_candidate ? " wrong_landing_candidate=true" : "";
      return `${candidate.id}. ${sanitizeForPrompt(redactPath(candidate.path, privacy), privacy)}${flags}`;
    })
    .join("\n");

  return {
    systemPrompt: [
      "You are zdr, a directory disambiguation helper for the zoxide CLI tool.",
      "Given a user's short query, recorded zoxide jump context, and candidate directories, return the single best candidate ID the user most likely intended to navigate to.",
      "Recognize abbreviations, initialisms, and partial matches that simple substring search would miss.",
      "A candidate that merely contains the query as a literal substring is not automatically the best: a name the query abbreviates can beat one that just contains it, and the live working copy of a project beats an archived or backup duplicate of that same project.",
      "Do not choose a candidate marked wrong_landing_candidate unless every other candidate is clearly worse.",
      'Output strict JSON only: {"candidate_id":"c001","confidence":0.0,"reason":"short reason"}',
      "Return null when no candidate matches what the query means. A directory that is only topically related (same domain, different thing) is not a match; prefer null over a loosely-related guess.",
      'If no candidate is good, output: {"candidate_id":null,"confidence":0.0,"reason":"why"}',
    ].join("\n"),
    userMessage: [
      "=== Stable prefix ===",
      `Candidates (ranked, top ${input.candidates.length}):`,
      candidateBlock,
      "",
      "=== Volatile tail ===",
      `Query: ${sanitizeForPrompt(query, privacy)}`,
      `Before pwd: ${sanitizeForPrompt(redactPath(input.state.before_pwd, privacy), privacy)}`,
      `Landed pwd: ${sanitizeForPrompt(redactPath(input.state.after_pwd, privacy), privacy)}`,
      `Already tried wrong: ${formatRejectedPaths(input.rejectedPaths ?? [], privacy)}`,
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

function redactPath(path: string, privacy: ZdrConfig["privacy"]): string {
  if (!privacy.redact_home) {
    return path;
  }
  const home = process.env.HOME;
  if (home && path === home) {
    return "~";
  }
  if (home && path.startsWith(`${home}/`)) {
    return `~/${path.slice(home.length + 1)}`;
  }
  return path.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}

function sanitizeForPrompt(value: string, privacy: ZdrConfig["privacy"]): string {
  let sanitized = value;
  if (privacy.redact_emails) {
    sanitized = sanitized.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]");
  }
  if (privacy.redact_secrets) {
    sanitized = sanitized.replace(/\b(?:sk|ghp|github_pat|glpat|xox[baprs]?)-[A-Za-z0-9_-]{12,}\b/gi, "[redacted-secret]");
  }
  if (privacy.redact_tokens) {
    sanitized = sanitized
      .replace(/\b[a-f0-9]{32,}\b/gi, "[redacted-token]")
      .replace(/\b(?=[A-Za-z0-9_-]{24,}\b)(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_-]+\b/g, "[redacted-token]");
  }
  return sanitized;
}

function formatRejectedPaths(paths: string[], privacy: ZdrConfig["privacy"]): string {
  if (paths.length === 0) {
    return "none";
  }
  return paths.map((path) => sanitizeForPrompt(redactPath(path, privacy), privacy)).join(", ");
}
