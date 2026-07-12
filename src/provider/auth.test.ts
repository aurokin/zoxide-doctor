import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  getAuthPath,
  getPiSharedAuthPath,
  getProviderAuthStatuses,
  isKnownOAuthProvider,
  loginProvider,
  logoutProvider,
  readAuthStore,
  readPiSharedProviders,
  resolveProviderApiKey,
} from "./auth.js";

let tempDir: string;
let previousXdgConfigHome: string | undefined;
let previousPiDir: string | undefined;

const login = mock(async () => ({
  access: "access-1",
  refresh: "refresh-1",
  expires: Date.now() + 60_000,
  accountId: "account-1",
}));
const getOAuthApiKey = mock(async () => ({
  apiKey: "access-2",
  newCredentials: {
    access: "access-2",
    refresh: "refresh-2",
    expires: Date.now() + 120_000,
    accountId: "account-1",
  },
}));

mock.module("@earendil-works/pi-ai/oauth", () => ({
  getOAuthProvider: (provider: string) =>
    provider === "openai-codex"
      ? {
          id: "openai-codex",
          login,
        }
      : undefined,
  getOAuthProviders: () => [{ id: "openai-codex" }, { id: "github-copilot" }],
  getOAuthApiKey,
}));

beforeEach(async () => {
  previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  previousPiDir = process.env.PI_CODING_AGENT_DIR;
  tempDir = await mkdtemp(join(tmpdir(), "zdr-auth-"));
  process.env.XDG_CONFIG_HOME = tempDir;
  delete process.env.PI_CODING_AGENT_DIR;
  login.mockClear();
  getOAuthApiKey.mockClear();
});

afterEach(async () => {
  if (previousXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
  }
  if (previousPiDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = previousPiDir;
  }
  await rm(tempDir, { recursive: true, force: true });
});

describe("provider auth", () => {
  test("logs in and writes credentials with private file mode", async () => {
    await loginProvider("openai-codex", {
      onAuth: () => {},
      onPrompt: async () => "",
    });

    const path = getAuthPath();
    const saved = await readAuthStore(path);
    expect(saved["openai-codex"]?.access).toBe("access-1");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("reports auth status without exposing token material", async () => {
    await loginProvider("openai-codex", {
      onAuth: () => {},
      onPrompt: async () => "",
    });

    const statuses = await getProviderAuthStatuses();

    expect(statuses[0]).toMatchObject({
      provider: "openai-codex",
      authenticated: true,
      type: "oauth",
      expired: false,
      refresh_available: true,
    });
    expect(JSON.stringify(statuses)).not.toContain("access-1");
    expect(JSON.stringify(statuses)).not.toContain("refresh-1");
  });

  test("resolves and persists refreshed OAuth access token", async () => {
    await loginProvider("openai-codex", {
      onAuth: () => {},
      onPrompt: async () => "",
    });

    await expect(resolveProviderApiKey("openai-codex")).resolves.toBe("access-2");

    const saved = await readAuthStore();
    expect(saved["openai-codex"]?.access).toBe("access-2");
    expect(getOAuthApiKey).toHaveBeenCalledWith(
      "openai-codex",
      expect.objectContaining({
        "openai-codex": expect.objectContaining({
          access: "access-1",
          refresh: "refresh-1",
        }),
      }),
    );
  });

  test("uses Pi OAuth registry for supported providers", async () => {
    expect(await isKnownOAuthProvider("github-copilot")).toBe(true);
    expect(await isKnownOAuthProvider("openrouter")).toBe(false);
  });

  test("logs out one provider", async () => {
    await loginProvider("openai-codex", {
      onAuth: () => {},
      onPrompt: async () => "",
    });

    await expect(logoutProvider("openai-codex")).resolves.toBe(true);
    await expect(logoutProvider("openai-codex")).resolves.toBe(false);
    await expect(readAuthStore()).resolves.toEqual({});
  });

  test("imports an OAuth credential from the Pi shared store on first use", async () => {
    const piDir = join(tempDir, "pi-agent");
    process.env.PI_CODING_AGENT_DIR = piDir;
    const piAuthPath = getPiSharedAuthPath();
    await mkdir(dirname(piAuthPath), { recursive: true });
    await writeFile(
      piAuthPath,
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "pi-access",
          refresh: "pi-refresh",
          expires: Date.now() + 60_000,
          accountId: "pi-account",
        },
      }),
    );

    await expect(resolveProviderApiKey("openai-codex")).resolves.toBe("access-2");

    // The imported credential is copied into zdr's own store...
    const zdrStore = await readAuthStore();
    expect(zdrStore["openai-codex"]).toBeDefined();
    // ...and the Pi shared store is never modified.
    const piStore = JSON.parse(await Bun.file(piAuthPath).text()) as Record<string, { access: string }>;
    expect(piStore["openai-codex"]?.access).toBe("pi-access");
    expect(getOAuthApiKey).toHaveBeenCalledWith(
      "openai-codex",
      expect.objectContaining({ "openai-codex": expect.objectContaining({ access: "pi-access" }) }),
    );
  });

  test("does not retain an imported Pi credential when the OAuth exchange fails", async () => {
    const piDir = join(tempDir, "pi-agent");
    process.env.PI_CODING_AGENT_DIR = piDir;
    const piAuthPath = getPiSharedAuthPath();
    await mkdir(dirname(piAuthPath), { recursive: true });
    await writeFile(
      piAuthPath,
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "pi-access",
          refresh: "pi-refresh",
          expires: Date.now() + 60_000,
          accountId: "pi-account",
        },
      }),
    );

    // First exchange fails (well-formed but expired/invalid tokens).
    getOAuthApiKey.mockImplementationOnce((async () => null) as unknown as typeof getOAuthApiKey);
    await expect(resolveProviderApiKey("openai-codex")).resolves.toBeUndefined();

    // The failed import must not linger in zdr's store.
    await expect(readAuthStore()).resolves.toEqual({});

    // A subsequent call with a now-working exchange re-imports fresh from Pi.
    await expect(resolveProviderApiKey("openai-codex")).resolves.toBe("access-2");
    expect(getOAuthApiKey).toHaveBeenLastCalledWith(
      "openai-codex",
      expect.objectContaining({ "openai-codex": expect.objectContaining({ access: "pi-access" }) }),
    );
    const zdrStore = await readAuthStore();
    expect(zdrStore["openai-codex"]?.access).toBe("access-2");
  });

  test("falls back to the Pi shared store when the zdr credential fails the exchange", async () => {
    await loginProvider("openai-codex", {
      onAuth: () => {},
      onPrompt: async () => "",
    });
    const piDir = join(tempDir, "pi-agent");
    process.env.PI_CODING_AGENT_DIR = piDir;
    const piAuthPath = getPiSharedAuthPath();
    await mkdir(dirname(piAuthPath), { recursive: true });
    await writeFile(
      piAuthPath,
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "pi-access",
          refresh: "pi-refresh",
          expires: Date.now() + 60_000,
          accountId: "pi-account",
        },
      }),
    );

    // The stale zdr-store credential fails the exchange; the fresher Pi login succeeds.
    getOAuthApiKey.mockImplementationOnce((async () => null) as unknown as typeof getOAuthApiKey);
    await expect(resolveProviderApiKey("openai-codex")).resolves.toBe("access-2");

    expect(getOAuthApiKey).toHaveBeenCalledTimes(2);
    expect(getOAuthApiKey).toHaveBeenNthCalledWith(
      1,
      "openai-codex",
      expect.objectContaining({ "openai-codex": expect.objectContaining({ access: "access-1" }) }),
    );
    expect(getOAuthApiKey).toHaveBeenLastCalledWith(
      "openai-codex",
      expect.objectContaining({ "openai-codex": expect.objectContaining({ access: "pi-access" }) }),
    );
    const zdrStore = await readAuthStore();
    expect(zdrStore["openai-codex"]?.access).toBe("access-2");
  });

  test("lists Pi shared store providers without token material", async () => {
    const piDir = join(tempDir, "pi-agent");
    process.env.PI_CODING_AGENT_DIR = piDir;
    const piAuthPath = getPiSharedAuthPath();
    await mkdir(dirname(piAuthPath), { recursive: true });
    await writeFile(
      piAuthPath,
      JSON.stringify({
        "openai-codex": { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 1000 },
        broken: { type: "api_key" },
      }),
    );

    await expect(readPiSharedProviders()).resolves.toEqual(["openai-codex"]);
  });

  test("serializes concurrent credential persists into a valid store", async () => {
    const piDir = join(tempDir, "pi-agent");
    process.env.PI_CODING_AGENT_DIR = piDir;
    const piAuthPath = getPiSharedAuthPath();
    await mkdir(dirname(piAuthPath), { recursive: true });
    await writeFile(
      piAuthPath,
      JSON.stringify({
        "openai-codex": { type: "oauth", access: "codex-access", refresh: "codex-refresh", expires: Date.now() + 60_000 },
        "github-copilot": { type: "oauth", access: "copilot-access", refresh: "copilot-refresh", expires: Date.now() + 60_000 },
      }),
    );

    const results = await Promise.all([
      resolveProviderApiKey("openai-codex"),
      resolveProviderApiKey("github-copilot"),
      resolveProviderApiKey("openai-codex"),
      resolveProviderApiKey("github-copilot"),
    ]);
    expect(results).toEqual(["access-2", "access-2", "access-2", "access-2"]);

    // Concurrent writes for different providers must not clobber one another.
    const store = await readAuthStore();
    expect(store["openai-codex"]?.access).toBe("access-2");
    expect(store["github-copilot"]?.access).toBe("access-2");
  });

  test("falls through when the Pi shared store is missing", async () => {
    process.env.PI_CODING_AGENT_DIR = join(tempDir, "missing-pi");
    await expect(resolveProviderApiKey("openai-codex")).resolves.toBeUndefined();
    await expect(readPiSharedProviders()).resolves.toEqual([]);
  });

  test("rejects invalid auth store credentials", async () => {
    const path = getAuthPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ "openai-codex": { type: "api_key", key: "secret" } }));
    await chmod(path, 0o600);

    await expect(readAuthStore(path)).rejects.toThrow("unsupported type");
  });
});
