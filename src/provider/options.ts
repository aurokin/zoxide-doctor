import type { ZdrConfig } from "../config.js";
import type { ProviderReasoning } from "./select.js";

export type SelectionCompletionOptions = {
  maxTokens: number;
  timeoutMs: number;
  temperature?: number;
  reasoning?: ProviderReasoning;
  apiKey?: string;
  transport?: "sse";
};

export function selectionCompletionOptions(input: {
  provider: ZdrConfig["provider"];
  maxTokens: number;
  timeoutMs: number;
  reasoning?: ProviderReasoning;
  apiKey?: string;
}): SelectionCompletionOptions {
  const reasoning = input.reasoning ?? defaultReasoning(input.provider.name);
  const isCodex = input.provider.name === "openai-codex";
  return {
    maxTokens: input.maxTokens,
    timeoutMs: input.timeoutMs,
    ...(isCodex ? {} : { temperature: 0 }),
    // Force SSE for the Codex backend so requests flow through global `fetch`,
    // where the Codex CLI client-identity override is applied (see
    // codex-identity.ts). The WebSocket transport bypasses `fetch` and would
    // strand the override, breaking models like gpt-5.6-luna.
    ...(isCodex ? { transport: "sse" as const } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(input.apiKey ? { apiKey: input.apiKey } : {}),
  };
}

function defaultReasoning(providerName: string): ProviderReasoning | undefined {
  if (providerName === "openai-codex" || providerName === "fireworks") {
    return "minimal";
  }
  return undefined;
}
