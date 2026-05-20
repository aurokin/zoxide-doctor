import { DEFAULT_CONFIG, type ZdrConfig } from "../config.js";
import { resolveConfiguredModel } from "./model.js";

type SmokeOptions = {
  live: boolean;
  provider?: ZdrConfig["provider"];
};

export async function smokePiOpenRouter(options: SmokeOptions): Promise<{ code: number }> {
  const { completeSimple } = await import("@earendil-works/pi-ai");
  const provider = options.provider ?? DEFAULT_CONFIG.provider;

  const model = await resolveConfiguredModel(provider);
  if (!model) {
    console.error(`zdr: Pi did not return configured ${provider.name} model ${provider.model}`);
    return { code: 1 };
  }

  const result: Record<string, unknown> = {
    provider: model.provider,
    model: model.id,
    api: model.api,
  };

  if (options.live) {
    if (provider.name === "openrouter" && !process.env.OPENROUTER_API_KEY) {
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
