import type { Candidate } from "../candidates.js";
import { buildSelectionPrompt, parseSelectionResponse, type SelectionResponse } from "../prompt.js";
import type { FinishedZState } from "../shell-state.js";

export type SelectionResult = {
  selection: SelectionResponse;
  candidate: Candidate | null;
  raw_text: string;
  usage: unknown;
};

export async function selectCandidate(input: {
  state: FinishedZState;
  candidates: Candidate[];
  rejectedPaths?: string[];
}): Promise<SelectionResult> {
  const { completeSimple, getModel } = await import("@earendil-works/pi-ai");
  const model = getModel("openrouter", "deepseek/deepseek-v4-flash");
  if (!model) {
    throw new Error("Pi did not return the configured OpenRouter model");
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
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; raw content: ${JSON.stringify(response.content)}`,
    );
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
