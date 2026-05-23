import { DEFAULT_CONFIG, type ZdrConfig } from "../config.js";
import { isKnownOAuthProvider, resolveProviderAuth } from "./auth.js";
import { resolveConfiguredModel } from "./model.js";
import { selectionCompletionOptions } from "./options.js";

type SmokeOptions = {
  live: boolean;
  provider?: ZdrConfig["provider"];
};

export async function smokePiOpenRouter(options: SmokeOptions): Promise<{ code: number }> {
  const { completeSimple } = await import("@earendil-works/pi-ai");
  const provider = options.provider ?? DEFAULT_CONFIG.provider;
  const auth = await resolveProviderAuth(provider.name);

  const model = await resolveConfiguredModel(provider, auth);
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
    if (provider.name === "openrouter" && !process.env.OPENROUTER_API_KEY && !auth) {
      console.error("zdr: OPENROUTER_API_KEY is required for provider-smoke --live");
      return { code: 2 };
    }
    if ((await isKnownOAuthProvider(provider.name)) && !auth) {
      console.error(`zdr: run 'zdr provider-login ${provider.name}' before provider-smoke --live`);
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
      selectionCompletionOptions({
        provider,
        maxTokens: 80,
        timeoutMs: 10_000,
        ...(auth ? { apiKey: auth.apiKey } : {}),
      }),
    );
    result.stopReason = response.stopReason;
    result.usage = response.usage;
    result.text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
  }

  console.log(JSON.stringify(result, null, 2));
  return { code: 0 };
}
