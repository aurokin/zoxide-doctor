type SmokeOptions = {
  live: boolean;
};

export async function smokePiOpenRouter(options: SmokeOptions): Promise<{ code: number }> {
  const { completeSimple, getModel } = await import("@earendil-works/pi-ai");

  const model = getModel("openrouter", "deepseek/deepseek-v4-flash");
  if (!model) {
    console.error("zdr: Pi did not return the configured OpenRouter model");
    return { code: 1 };
  }

  const result: Record<string, unknown> = {
    provider: model.provider,
    model: model.id,
    api: model.api,
  };

  if (options.live) {
    if (!process.env.OPENROUTER_API_KEY) {
      console.error("zdr: OPENROUTER_API_KEY is required for provider-smoke --live");
      return { code: 2 };
    }

    const response = await completeSimple(
      model,
      {
        systemPrompt: "Return strict JSON only.",
        messages: [
          {
            role: "user",
            content: "Return {\"ok\":true} and nothing else.",
            timestamp: Date.now(),
          },
        ],
      },
      {
        maxTokens: 80,
        temperature: 0,
        timeoutMs: 10_000,
      },
    );
    result.stopReason = response.stopReason;
    result.usage = response.usage;
    result.content = response.content;
  }

  console.log(JSON.stringify(result, null, 2));
  return { code: 0 };
}
