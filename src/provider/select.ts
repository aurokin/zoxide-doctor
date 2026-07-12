import type { Candidate } from "../candidates.js";
import { DEFAULT_CONFIG, type ZdrConfig } from "../config.js";
import { buildSelectionPrompt, parseSelectionResponse, type SelectionResponse } from "../prompt.js";
import type { FinishedZState } from "../shell-state.js";
import { resolveProviderAuth } from "./auth.js";
import { resolveConfiguredModel } from "./model.js";
import { selectionCompletionOptions } from "./options.js";

export type SelectionResult = {
  selection: SelectionResponse;
  candidate: Candidate | null;
  raw_text: string;
  usage: unknown;
  timings?: SelectionTimings;
};

export type ProviderReasoning = "minimal" | "low" | "medium" | "high" | "xhigh";

export type SelectionTimings = {
  model_resolve_ms: number;
  prompt_build_ms: number;
  provider_complete_ms: number;
  response_parse_ms: number;
  total_ms: number;
};

const SELECTION_MAX_TOKENS = 256;
// Reasoning models spend output tokens on hidden reasoning before emitting the
// JSON answer, so 256 is routinely exhausted mid-reasoning (stopReason
// "length") leaving zero usable text. Give them headroom. The answer itself is
// still a single JSON line — this larger ceiling only covers reasoning, it does
// not let the response grow.
const REASONING_SELECTION_MAX_TOKENS = 2048;

export async function selectCandidate(input: {
  state: FinishedZState;
  candidates: Candidate[];
  rejectedPaths?: string[];
  provider?: ZdrConfig["provider"];
  privacy?: ZdrConfig["privacy"];
  reasoning?: ProviderReasoning;
}): Promise<SelectionResult> {
  const startedAt = performance.now();
  const { completeSimple } = await import("@earendil-works/pi-ai/compat");
  const provider = input.provider ?? DEFAULT_CONFIG.provider;
  if (provider.name === "openai-codex") {
    // pi-ai forces originator "pi" on the Codex backend, which the server
    // routes to non-existent checkpoints for newer models (e.g. gpt-5.6-luna).
    // Present the genuine Codex CLI identity instead. See codex-identity.ts.
    const { ensureCodexClientIdentity } = await import("./codex-identity.js");
    ensureCodexClientIdentity();
  }
  const auth = await resolveProviderAuth(provider.name);
  const modelResolveStartedAt = performance.now();
  const model = await resolveConfiguredModel(provider, auth);
  const modelResolveMs = elapsedMs(modelResolveStartedAt);
  if (!model) {
    throw new Error(`Pi did not return configured ${provider.name} model ${provider.model}`);
  }

  const promptBuildStartedAt = performance.now();
  const prompt = buildSelectionPrompt(input);
  const promptBuildMs = elapsedMs(promptBuildStartedAt);
  const providerCompleteStartedAt = performance.now();
  const response = await completeSimple(
    model,
    {
      systemPrompt: prompt.systemPrompt,
      messages: [
        {
          role: "user",
          content: prompt.userMessage,
          timestamp: Date.now(),
        },
      ],
    },
    selectionCompletionOptions({
      provider,
      maxTokens: model.reasoning ? REASONING_SELECTION_MAX_TOKENS : SELECTION_MAX_TOKENS,
      timeoutMs: 10_000,
      ...(input.reasoning ? { reasoning: input.reasoning } : {}),
      ...(auth ? { apiKey: auth.apiKey } : {}),
    }),
  );
  const providerCompleteMs = elapsedMs(providerCompleteStartedAt);

  const responseParseStartedAt = performance.now();
  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
  const rawText =
    text.length > 0
      ? text
      : response.content
          .filter((block) => block.type === "thinking")
          .map((block) => block.thinking)
          .join("")
          .trim();
  let selection;
  try {
    selection = parseSelectionResponse(rawText, input.candidates);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${detail}; ${providerResponseSummary(rawText, response.stopReason, response.errorMessage)}`);
  }
  const responseParseMs = elapsedMs(responseParseStartedAt);
  return {
    selection,
    candidate: selection.candidate_id
      ? input.candidates.find((candidate) => candidate.id === selection.candidate_id) ?? null
      : null,
    raw_text: rawText,
    usage: response.usage,
    timings: {
      model_resolve_ms: modelResolveMs,
      prompt_build_ms: promptBuildMs,
      provider_complete_ms: providerCompleteMs,
      response_parse_ms: responseParseMs,
      total_ms: elapsedMs(startedAt),
    },
  };
}

function elapsedMs(start: number): number {
  return Math.max(0, Math.round((performance.now() - start) * 1000) / 1000);
}

function providerResponseSummary(rawText: string, stopReason?: string, errorMessage?: string): string {
  if (stopReason === "error" && typeof errorMessage === "string" && errorMessage.length > 0) {
    return `provider returned an error: ${truncateProviderPreview(redactProviderText(errorMessage))}`;
  }
  const truncatedNote =
    stopReason === "length" ? "response was truncated before completing JSON (hit max tokens); " : "";
  const preview = redactProviderText(rawText);
  return `${truncatedNote}provider returned ${rawText.length} text chars; preview: ${truncateProviderPreview(preview)}`;
}

function redactProviderText(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\b(?:sk|ghp|github_pat|glpat|xox[baprs]?)-[A-Za-z0-9_-]{12,}\b/gi, "[redacted-secret]")
    .replace(/\b[a-f0-9]{32,}\b/gi, "[redacted-token]")
    .replace(/\b(?=[A-Za-z0-9_-]{24,}\b)(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_-]+\b/g, "[redacted-token]");
}

function truncateProviderPreview(value: string): string {
  const maxLength = 160;
  if (value.length <= maxLength) {
    return value;
  }
  const truncated = value.slice(0, maxLength);
  const markerStart = truncated.lastIndexOf("[redacted-");
  if (markerStart !== -1 && !truncated.slice(markerStart).includes("]")) {
    return truncated.slice(0, markerStart);
  }
  return truncated;
}
