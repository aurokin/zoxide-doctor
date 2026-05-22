import type { ZdrConfig } from "../config.js";
import type { ProviderReasoning } from "./select.js";

export type SelectionCompletionOptions = {
  maxTokens: number;
  timeoutMs: number;
  temperature?: number;
  reasoning?: ProviderReasoning;
  apiKey?: string;
};

export function selectionCompletionOptions(input: {
  provider: ZdrConfig["provider"];
  maxTokens: number;
  timeoutMs: number;
  reasoning?: ProviderReasoning;
  apiKey?: string;
}): SelectionCompletionOptions {
  const reasoning =
    input.reasoning ?? (input.provider.name === "openai-codex" ? ("minimal" satisfies ProviderReasoning) : undefined);
  return {
    maxTokens: input.maxTokens,
    timeoutMs: input.timeoutMs,
    ...(input.provider.name === "openai-codex" ? {} : { temperature: 0 }),
    ...(reasoning ? { reasoning } : {}),
    ...(input.apiKey ? { apiKey: input.apiKey } : {}),
  };
}
