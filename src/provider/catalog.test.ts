import { describe, expect, mock, test } from "bun:test";
import { listProviders } from "./catalog.js";

mock.module("@earendil-works/pi-ai", () => ({
  getProviders: () => ["openrouter", "openai-codex"],
  getModels: (provider: string) =>
    provider === "openai-codex"
      ? [
          {
            id: "gpt-5.3-codex-spark",
            provider: "openai-codex",
            api: "openai-codex-responses",
          },
        ]
      : [
          {
            id: "google/gemini-2.5-flash-lite",
            provider: "openrouter",
            api: "openai-completions",
          },
        ],
}));

mock.module("@earendil-works/pi-ai/oauth", () => ({
  getOAuthProviders: () => [{ id: "openai-codex" }],
}));

describe("provider catalog", () => {
  test("lists Pi providers with model counts and OAuth support", async () => {
    await expect(listProviders()).resolves.toEqual({
      schema_version: 1,
      command: "provider-list",
      providers: [
        { name: "openrouter", model_count: 1, oauth_supported: false },
        { name: "openai-codex", model_count: 1, oauth_supported: true },
      ],
    });
  });

  test("includes model details when a provider is selected", async () => {
    await expect(listProviders("openai-codex")).resolves.toEqual({
      schema_version: 1,
      command: "provider-list",
      providers: [{ name: "openai-codex", model_count: 1, oauth_supported: true }],
      models: [
        {
          id: "gpt-5.3-codex-spark",
          provider: "openai-codex",
          api: "openai-codex-responses",
        },
      ],
    });
  });

  test("rejects unknown provider names", async () => {
    await expect(listProviders("missing")).rejects.toThrow("Pi did not return provider missing");
  });
});
