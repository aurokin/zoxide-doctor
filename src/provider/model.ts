import type { ZdrConfig } from "../config.js";

export async function resolveConfiguredModel(provider: ZdrConfig["provider"]) {
  const { getModels, getProviders } = await import("@earendil-works/pi-ai");
  const knownProvider = getProviders().find((candidate) => candidate === provider.name);
  if (!knownProvider) {
    return null;
  }
  return getModels(knownProvider).find((model) => model.id === provider.model) ?? null;
}
