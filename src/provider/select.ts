import type { Candidate } from "../candidates.js";
import { DEFAULT_CONFIG, type ZdrConfig } from "../config.js";
import { buildSelectionPrompt, parseSelectionResponse, type SelectionResponse } from "../prompt.js";
import type { FinishedZState } from "../shell-state.js";
import { resolveConfiguredModel } from "./model.js";

export type SelectionResult = {
  selection: SelectionResponse;
  candidate: Candidate | null;
  raw_text: string;
  usage: unknown;
};

export type ProviderReasoning = "minimal" | "low" | "medium" | "high" | "xhigh";

export async function selectCandidate(input: {
  state: FinishedZState;
  candidates: Candidate[];
  rejectedPaths?: string[];
  provider?: ZdrConfig["provider"];
  privacy?: ZdrConfig["privacy"];
  reasoning?: ProviderReasoning;
}): Promise<SelectionResult> {
  const { completeSimple } = await import("@earendil-works/pi-ai");
  const provider = input.provider ?? DEFAULT_CONFIG.provider;
  const model = await resolveConfiguredModel(provider);
  if (!model) {
    throw new Error(`Pi did not return configured ${provider.name} model ${provider.model}`);
  }

  const prompt = buildSelectionPrompt(input);
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
    {
      maxTokens: 1024,
      temperature: 0,
      timeoutMs: 10_000,
      ...(input.reasoning ? { reasoning: input.reasoning } : {}),
    },
  );

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
    throw new Error(`${error instanceof Error ? error.message : String(error)}; ${providerResponseSummary(rawText)}`);
  }
  return {
    selection,
    candidate: selection.candidate_id
      ? input.candidates.find((candidate) => candidate.id === selection.candidate_id) ?? null
      : null,
    raw_text: rawText,
    usage: response.usage,
  };
}

function providerResponseSummary(rawText: string): string {
  const preview = redactProviderText(rawText);
  return `provider returned ${rawText.length} text chars; preview: ${truncateProviderPreview(preview)}`;
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
