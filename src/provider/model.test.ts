import { describe, expect, mock, test } from "bun:test";
import { resolveConfiguredModel } from "./model.js";

mock.module("@earendil-works/pi-ai/compat", () => ({
  getProviders: () => ["github-copilot"],
  getModels: () => [
    {
      id: "gpt-4.1",
      provider: "github-copilot",
      baseUrl: "https://api.githubcopilot.com",
    },
  ],
}));

mock.module("@earendil-works/pi-ai/oauth", () => ({
  getOAuthProvider: (provider: string) =>
    provider === "github-copilot"
      ? {
          modifyModels: (models: Array<Record<string, unknown>>) =>
            models.map((model) => ({
              ...model,
              baseUrl: "https://enterprise.example.com/copilot",
            })),
        }
      : undefined,
}));

describe("resolveConfiguredModel", () => {
  test("applies OAuth provider model modifiers before selecting the model", async () => {
    const model = await resolveConfiguredModel(
      {
        name: "github-copilot",
        model: "gpt-4.1",
      },
      {
        apiKey: "token",
        credentials: {
          access: "token",
          refresh: "refresh",
          expires: Date.now() + 60_000,
          enterpriseUrl: "https://enterprise.example.com",
        },
      },
    );

    expect(model).toMatchObject({
      id: "gpt-4.1",
      provider: "github-copilot",
      baseUrl: "https://enterprise.example.com/copilot",
    });
  });
});
