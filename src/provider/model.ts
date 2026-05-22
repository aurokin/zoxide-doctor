import type { ZdrConfig } from "../config.js";
import type { ProviderAuth } from "./auth.js";

export async function resolveConfiguredModel(provider: ZdrConfig["provider"], auth?: ProviderAuth) {
  const { getModels, getProviders } = await import("@earendil-works/pi-ai");
  const knownProvider = getProviders().find((candidate) => candidate === provider.name);
  if (!knownProvider) {
    return null;
  }
  let models = getModels(knownProvider) as Array<ReturnType<typeof getModels>[number]>;
  if (auth) {
    const { getOAuthProvider } = await import("@earendil-works/pi-ai/oauth");
    const oauthProvider = getOAuthProvider(provider.name);
    if (oauthProvider?.modifyModels) {
      models = oauthProvider.modifyModels(models, auth.credentials) as typeof models;
    }
  }
  return models.find((model) => model.id === provider.model) ?? null;
}
