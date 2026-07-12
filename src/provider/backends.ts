import type { Candidate } from "../candidates.js";
import { DEFAULT_CONFIG, type ZdrConfig } from "../config.js";
import type { FinishedZState } from "../shell-state.js";
import type { ProviderReasoning, SelectionResult } from "./select.js";

export type BackendKind = "pi" | "claude";

export type BackendTierSpec = {
  backend: BackendKind;
  name?: string; // pi provider name (e.g. "openrouter", "openai-codex"); ignored for claude
  model: string; // pi model id, or claude model alias/id (e.g. "haiku", "sonnet")
};

export type BackendSelectionInput = {
  state: FinishedZState;
  candidates: Candidate[];
  rejectedPaths?: string[];
  privacy?: ZdrConfig["privacy"];
  reasoning?: ProviderReasoning;
};

export async function selectWithBackend(
  spec: BackendTierSpec,
  input: BackendSelectionInput,
): Promise<SelectionResult> {
  if (spec.backend === "claude") {
    const { selectWithClaude } = await import("./claude.js");
    return selectWithClaude({ ...input, model: spec.model });
  }
  const { selectCandidate } = await import("./select.js");
  return selectCandidate({
    ...input,
    provider: { name: spec.name ?? DEFAULT_CONFIG.provider.name, model: spec.model },
  });
}
