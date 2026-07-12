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

export function getPiSharedAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PI_CODING_AGENT_DIR;
  const agentDir =
    override && override.length > 0 ? expandTilde(override, env) : join(homeDir(env), ".pi", "agent");
  return join(agentDir, "auth.json");
}

export async function loginProvider(provider: string, callbacks: OAuthLoginCallbacks): Promise<void> {
  const { getOAuthProvider } = await import("@earendil-works/pi-ai/oauth");
  const oauthProvider = getOAuthProvider(provider);
  if (!oauthProvider) {
    throw new Error(`provider does not support OAuth login: ${provider}`);
  }

  const credentials = (await oauthProvider.login({
    ...callbacks,
    // 0.80 requires these callbacks. zdr only drives the default browser login
    // flow, so select the default (first) method and never surface a device code.
    onDeviceCode: () => {},
    onSelect: async (prompt) => prompt.options[0]?.id,
  })) as OAuthCredentials;
  await serializeAuthStoreWrite(async () => {
    const store = await readAuthStore();
    store[provider] = { type: "oauth", ...credentials };
    await writeAuthStore(store);
  });
}

export async function logoutProvider(provider: string): Promise<boolean> {
  return serializeAuthStoreWrite(async () => {
    const store = await readAuthStore();
    if (!store[provider]) {
      return false;
    }
    delete store[provider];
    await writeAuthStore(store);
    return true;
  });
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
  if (!(await isKnownOAuthProvider(provider))) {
    return undefined;
  }

  const store = await readAuthStore();
  const stored = store[provider];
  // Imported Pi credentials stay in memory only. They are persisted into
  // zdr's store below, but only once the OAuth exchange succeeds — otherwise
  // an expired/invalid import would be retained and block later re-imports.
  const credential = stored ?? (await importPiSharedCredential(provider));
  if (!credential) {
    return undefined;
  }

  let result = await exchangeOAuthCredential(provider, store, credential);
  if (!result && stored) {
    // The zdr-store credential failed the exchange; the Pi CLI store may hold
    // a fresher login for the same provider, so fall back to importing it.
    const fallback = await importPiSharedCredential(provider);
    if (fallback && (fallback.refresh !== stored.refresh || fallback.access !== stored.access)) {
      result = await exchangeOAuthCredential(provider, store, fallback);
    }
  }
  if (!result) {
    return undefined;
  }

  await serializeAuthStoreWrite(async () => {
    const current = await readAuthStore();
    current[provider] = { type: "oauth", ...result.newCredentials };
    await writeAuthStore(current);
  });
  return {
    apiKey: result.apiKey,
    credentials: result.newCredentials,
  };
}

async function exchangeOAuthCredential(
  provider: string,
  store: AuthStore,
  credential: AuthStore[string],
): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
  const { getOAuthApiKey } = await import("@earendil-works/pi-ai/oauth");
  const working: AuthStore = { ...store, [provider]: credential };
  const credentials = Object.fromEntries(
    Object.entries(working).map(([key, value]) => {
      const { type: _type, ...oauthCredentials } = value;
      return [key, oauthCredentials];
    }),
  );
  return (await getOAuthApiKey(provider, credentials)) as
    | { apiKey: string; newCredentials: OAuthCredentials }
    | null;
}

export async function isKnownOAuthProvider(provider: string): Promise<boolean> {
  return (await getKnownOAuthProviders()).includes(provider);
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

// Serializes read-modify-write of the auth store within this process so
// concurrent credential persists cannot clobber one another or race on the
// temp-file rename below.
let authStoreWriteChain: Promise<unknown> = Promise.resolve();

function serializeAuthStoreWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = authStoreWriteChain.then(fn, fn);
  authStoreWriteChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// Monotonic counter guarantees a unique temp path even for writes issued in the
// same process within the same millisecond.
let tmpWriteCounter = 0;

async function writeAuthStore(store: AuthStore, path = getAuthPath()): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: AUTH_DIR_MODE });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.${tmpWriteCounter++}.tmp`;
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

export async function getKnownOAuthProviders(): Promise<string[]> {
  const { getOAuthProviders } = await import("@earendil-works/pi-ai/oauth");
  return getOAuthProviders().map((provider: { id: string }) => provider.id);
}

export async function readPiSharedProviders(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const store = await readPiSharedStore(env);
  return Object.keys(store);
}

async function importPiSharedCredential(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OAuthCredential | undefined> {
  const store = await readPiSharedStore(env);
  return store[provider];
}

async function readPiSharedStore(env: NodeJS.ProcessEnv): Promise<AuthStore> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(getPiSharedAuthPath(env), "utf8")) as unknown;
  } catch {
    return {};
  }
  if (!isRecord(raw)) {
    return {};
  }
  const store: AuthStore = {};
  for (const [provider, value] of Object.entries(raw)) {
    try {
      store[provider] = parseOAuthCredential(provider, value);
    } catch {
      // Skip credentials that do not match the expected OAuth shape.
    }
  }
  return store;
}

function expandTilde(path: string, env: NodeJS.ProcessEnv): string {
  if (path === "~") {
    return homeDir(env);
  }
  if (path.startsWith("~/")) {
    return join(homeDir(env), path.slice(2));
  }
  return path;
}

function homeDir(env: NodeJS.ProcessEnv): string {
  if (env.HOME && env.HOME.length > 0) {
    return env.HOME;
  }
  throw new Error("HOME is required to resolve the Pi shared auth path");
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
