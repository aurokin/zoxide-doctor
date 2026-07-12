import type { Candidate } from "../candidates.js";
import { DEFAULT_CONFIG, type ZdrConfig } from "../config.js";
import { buildSelectionPrompt, parseSelectionResponse } from "../prompt.js";
import type { FinishedZState } from "../shell-state.js";
import type { ProviderReasoning, SelectionResult } from "./select.js";

const SELECTION_TIMEOUT_MS = 30_000;

const SELECTION_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["candidate_id", "confidence", "reason"],
  properties: {
    candidate_id: { type: ["string", "null"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reason: { type: "string" },
  },
};

type ClaudeQueryOptions = {
  model?: string;
  systemPrompt?: string;
  tools?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: string;
  settingSources?: string[];
  mcpServers?: Record<string, unknown>;
  strictMcpConfig?: boolean;
  maxTurns?: number;
  env?: Record<string, string>;
  pathToClaudeCodeExecutable?: string;
  abortController?: AbortController;
  thinking?: { type: "disabled" | "adaptive" };
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
};

type ClaudeResultMessage = {
  type: "result";
  subtype: string;
  result?: string;
  structured_output?: unknown;
  usage?: unknown;
  errors?: string[];
};

type ClaudeMessage = { type: string; [key: string]: unknown };

type ClaudeSdk = {
  query(params: { prompt: string; options?: ClaudeQueryOptions }): AsyncIterable<ClaudeMessage>;
};

export async function selectWithClaude(input: {
  state: FinishedZState;
  candidates: Candidate[];
  rejectedPaths?: string[];
  privacy?: ZdrConfig["privacy"];
  reasoning?: ProviderReasoning;
  model: string;
}): Promise<SelectionResult> {
  const startedAt = performance.now();

  const modelResolveStartedAt = performance.now();
  const executable = resolveClaudeExecutable();
  if (!executable) {
    throw new Error(
      "claude executable not found on PATH; install Claude Code and run 'claude' to log in to your Claude subscription",
    );
  }
  const modelResolveMs = elapsedMs(modelResolveStartedAt);

  const promptBuildStartedAt = performance.now();
  const prompt = buildSelectionPrompt(input);
  const promptBuildMs = elapsedMs(promptBuildStartedAt);

  const { query } = (await import("@anthropic-ai/claude-agent-sdk")) as unknown as ClaudeSdk;

  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(new Error("claude selection timed out")), SELECTION_TIMEOUT_MS);
  const providerCompleteStartedAt = performance.now();
  let result: ClaudeResultMessage | undefined;
  try {
    for await (const message of query({
      prompt: prompt.userMessage,
      options: {
        model: input.model,
        systemPrompt: prompt.systemPrompt,
        tools: [],
        allowedTools: [],
        disallowedTools: [],
        permissionMode: "dontAsk",
        settingSources: [],
        mcpServers: {},
        strictMcpConfig: true,
        maxTurns: 1,
        env: withoutAnthropicApiCredentials(process.env),
        pathToClaudeCodeExecutable: executable,
        abortController: abort,
        outputFormat: { type: "json_schema", schema: SELECTION_JSON_SCHEMA },
        ...claudeReasoningOptions(input.reasoning ?? DEFAULT_CONFIG_REASONING),
      },
    })) {
      if (isResultMessage(message)) {
        result = message;
      }
    }
  } finally {
    clearTimeout(timeout);
  }
  const providerCompleteMs = elapsedMs(providerCompleteStartedAt);

  if (!result) {
    throw new Error("claude returned no result");
  }
  if (result.subtype !== "success") {
    throw new Error(`claude selection failed: ${result.errors?.join("; ") ?? result.subtype}`);
  }

  const responseParseStartedAt = performance.now();
  const { selection, rawText } = parseClaudeSelection(result, input.candidates);
  const responseParseMs = elapsedMs(responseParseStartedAt);

  return {
    selection,
    candidate: selection.candidate_id
      ? input.candidates.find((candidate) => candidate.id === selection.candidate_id) ?? null
      : null,
    raw_text: rawText,
    usage: result.usage ?? null,
    timings: {
      model_resolve_ms: modelResolveMs,
      prompt_build_ms: promptBuildMs,
      provider_complete_ms: providerCompleteMs,
      response_parse_ms: responseParseMs,
      total_ms: elapsedMs(startedAt),
    },
  };
}

const DEFAULT_CONFIG_REASONING: ProviderReasoning = "minimal";

function parseClaudeSelection(
  result: ClaudeResultMessage,
  candidates: Candidate[],
): { selection: ReturnType<typeof parseSelectionResponse>; rawText: string } {
  if (result.structured_output !== undefined && result.structured_output !== null) {
    const rawText = JSON.stringify(result.structured_output);
    try {
      return { selection: parseSelectionResponse(rawText, candidates), rawText };
    } catch {
      // Fall through to text parsing.
    }
  }
  const text = (result.result ?? "").trim();
  return { selection: parseSelectionResponse(text, candidates), rawText: text };
}

function claudeReasoningOptions(reasoning: ProviderReasoning): Pick<ClaudeQueryOptions, "thinking" | "effort"> {
  if (reasoning === "minimal") {
    return { thinking: { type: "disabled" } };
  }
  return { effort: nativeEffort(reasoning) };
}

function nativeEffort(reasoning: ProviderReasoning): "low" | "medium" | "high" | "xhigh" | "max" {
  switch (reasoning) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "xhigh":
      return "xhigh";
    default:
      return "high";
  }
}

function resolveClaudeExecutable(): string | null {
  return Bun.which("claude");
}

function withoutAnthropicApiCredentials(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || key === "ANTHROPIC_API_KEY" || key === "ANTHROPIC_AUTH_TOKEN") {
      continue;
    }
    result[key] = value;
  }
  return result;
}

function isResultMessage(message: ClaudeMessage): message is ClaudeResultMessage {
  return message.type === "result" && typeof (message as ClaudeResultMessage).subtype === "string";
}

function elapsedMs(start: number): number {
  return Math.max(0, Math.round((performance.now() - start) * 1000) / 1000);
}
