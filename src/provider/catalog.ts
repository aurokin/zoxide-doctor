export type ProviderCatalog = {
  schema_version: 1;
  command: "provider-list";
  providers: ProviderSummary[];
  models?: ProviderModel[];
};

export type ProviderSummary = {
  name: string;
  model_count: number;
  oauth_supported: boolean;
};

export type ProviderModel = {
  id: string;
  provider: string;
  api: string;
};

export async function listProviders(providerName?: string): Promise<ProviderCatalog> {
  const { getModels, getProviders } = await import("@earendil-works/pi-ai/compat");
  const { getKnownOAuthProviders } = await import("./auth.js");
  const providerNames = getProviders();
  const oauthProviders = new Set(await getKnownOAuthProviders());

  const selectedProvider = providerName ? providerNames.find((name) => name === providerName) : undefined;
  if (providerName && !selectedProvider) {
    throw new Error(`Pi did not return provider ${providerName}`);
  }

  const selectedProviderNames = selectedProvider ? [selectedProvider] : providerNames;
  const providers = selectedProviderNames.map((name) => ({
    name,
    model_count: getModels(name).length,
    oauth_supported: oauthProviders.has(name),
  }));

  return {
    schema_version: 1,
    command: "provider-list",
    providers,
    ...(selectedProvider
      ? {
          models: getModels(selectedProvider).map((model) => ({
            id: model.id,
            provider: model.provider,
            api: model.api,
          })),
        }
      : {}),
  };
}
