import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  getAuthPath,
  getProviderAuthStatuses,
  isKnownOAuthProvider,
  loginProvider,
  logoutProvider,
  readAuthStore,
  resolveProviderApiKey,
} from "./auth.js";

let tempDir: string;
let previousXdgConfigHome: string | undefined;

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
  tempDir = await mkdtemp(join(tmpdir(), "zdr-auth-"));
  process.env.XDG_CONFIG_HOME = tempDir;
  login.mockClear();
  getOAuthApiKey.mockClear();
});

afterEach(async () => {
  if (previousXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
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

  test("rejects invalid auth store credentials", async () => {
    const path = getAuthPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ "openai-codex": { type: "api_key", key: "secret" } }));
    await chmod(path, 0o600);

    await expect(readAuthStore(path)).rejects.toThrow("unsupported type");
  });
});
