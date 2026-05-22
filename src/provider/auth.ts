import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getConfigPaths } from "../config.js";

export type OAuthCredential = {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  [key: string]: unknown;
};

export type AuthStore = Record<string, OAuthCredential>;

export type ProviderAuthStatus = {
  provider: string;
  authenticated: boolean;
  type?: "oauth";
  expired?: boolean;
  expires_at?: string;
  refresh_available?: boolean;
};

export type OAuthLoginCallbacks = {
  onAuth: (info: { url: string; instructions?: string }) => void;
  onPrompt: (prompt: { message: string; placeholder?: string; allowEmpty?: boolean }) => Promise<string>;
  onProgress?: (message: string) => void;
  onManualCodeInput?: () => Promise<string>;
};

type OAuthCredentials = {
  access: string;
  refresh: string;
  expires: number;
  [key: string]: unknown;
};

export type ProviderAuth = {
  apiKey: string;
  credentials: OAuthCredentials;
};

const AUTH_FILE_MODE = 0o600;
const AUTH_DIR_MODE = 0o700;

export function getAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getConfigPaths(env).configDir, "auth.json");
}

export async function loginProvider(provider: string, callbacks: OAuthLoginCallbacks): Promise<void> {
  const { getOAuthProvider } = await import("@earendil-works/pi-ai/oauth");
  const oauthProvider = getOAuthProvider(provider);
  if (!oauthProvider) {
    throw new Error(`provider does not support OAuth login: ${provider}`);
  }

  const credentials = (await oauthProvider.login(callbacks)) as OAuthCredentials;
  const store = await readAuthStore();
  store[provider] = { type: "oauth", ...credentials };
  await writeAuthStore(store);
}

export async function logoutProvider(provider: string): Promise<boolean> {
  const store = await readAuthStore();
  if (!store[provider]) {
    return false;
  }
  delete store[provider];
  await writeAuthStore(store);
  return true;
}

export async function getProviderAuthStatuses(providers?: string[]): Promise<ProviderAuthStatus[]> {
  const providerList = providers ?? (await getKnownOAuthProviders());
  const store = await readAuthStore();
  return providerList.map((provider) => {
    const credential = store[provider];
    if (!credential) {
      return { provider, authenticated: false };
    }
    return {
      provider,
      authenticated: true,
      type: "oauth",
      expired: Date.now() >= credential.expires,
      expires_at: new Date(credential.expires).toISOString(),
      refresh_available: credential.refresh.length > 0,
    };
  });
}

export async function resolveProviderApiKey(provider: string): Promise<string | undefined> {
  return (await resolveProviderAuth(provider))?.apiKey;
}

export async function resolveProviderAuth(provider: string): Promise<ProviderAuth | undefined> {
  if (!isKnownOAuthProvider(provider)) {
    return undefined;
  }

  const store = await readAuthStore();
  const credential = store[provider];
  if (!credential) {
    return undefined;
  }

  const { getOAuthApiKey } = await import("@earendil-works/pi-ai/oauth");
  const credentials = Object.fromEntries(
    Object.entries(store).map(([key, value]) => {
      const { type: _type, ...oauthCredentials } = value;
      return [key, oauthCredentials];
    }),
  );
  const result = (await getOAuthApiKey(provider, credentials)) as
    | { apiKey: string; newCredentials: OAuthCredentials }
    | null;
  if (!result) {
    return undefined;
  }

  store[provider] = { type: "oauth", ...result.newCredentials };
  await writeAuthStore(store);
  return {
    apiKey: result.apiKey,
    credentials: result.newCredentials,
  };
}

export function isKnownOAuthProvider(provider: string): boolean {
  return provider === "openai-codex" || provider === "anthropic" || provider === "github-copilot";
}

export async function readAuthStore(path = getAuthPath()): Promise<AuthStore> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isNotFound(error)) {
      return {};
    }
    throw error;
  }
  if (!isRecord(raw)) {
    throw new Error("auth store did not match expected schema");
  }
  return Object.fromEntries(
    Object.entries(raw).map(([provider, value]) => [provider, parseOAuthCredential(provider, value)]),
  );
}

async function writeAuthStore(store: AuthStore, path = getAuthPath()): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: AUTH_DIR_MODE });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(store, null, 2)}\n`, { mode: AUTH_FILE_MODE });
  await chmod(tmpPath, AUTH_FILE_MODE);
  try {
    await rename(tmpPath, path);
    await chmod(path, AUTH_FILE_MODE);
  } catch (error) {
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
}

async function getKnownOAuthProviders(): Promise<string[]> {
  const { getOAuthProviders } = await import("@earendil-works/pi-ai/oauth");
  return getOAuthProviders().map((provider: { id: string }) => provider.id);
}

function parseOAuthCredential(provider: string, value: unknown): OAuthCredential {
  if (!isRecord(value)) {
    throw new Error(`auth credential for ${provider} must be an object`);
  }
  if (value.type !== "oauth") {
    throw new Error(`auth credential for ${provider} has unsupported type`);
  }
  if (typeof value.access !== "string" || value.access.length === 0) {
    throw new Error(`auth credential for ${provider} is missing access token`);
  }
  if (typeof value.refresh !== "string") {
    throw new Error(`auth credential for ${provider} is missing refresh token`);
  }
  if (typeof value.expires !== "number" || !Number.isFinite(value.expires)) {
    throw new Error(`auth credential for ${provider} is missing expiry`);
  }
  return value as OAuthCredential;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
