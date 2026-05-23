import { getCachePaths } from "../corrections.js";
import {
  parseConfigProviderArgs,
  parseOptionalProviderArg,
  parseSingleProviderArg,
} from "../cli-args.js";
import { getConfigPaths, type LoadedConfig, type ZdrConfig } from "../config.js";
import { getStatePaths, readLastZState } from "../shell-state.js";
import { getTelemetryPaths } from "../telemetry.js";
import {
  getAuthPath,
  isKnownOAuthProvider,
  type OAuthLoginCallbacks,
  type ProviderAuthStatus,
} from "./auth.js";
import { listProviders } from "./catalog.js";
import { resolveConfiguredModel } from "./model.js";
import { smokePiOpenRouter } from "./pi.js";

export type ProviderCommandResult = {
  code: number;
};

export type ProviderCommandDeps = {
  loadConfig: () => Promise<LoadedConfig>;
  setProviderConfig: (provider: ZdrConfig["provider"]) => Promise<LoadedConfig>;
  providerLogin: (provider: string, callbacks: OAuthLoginCallbacks) => Promise<void>;
  providerLogout: (provider: string) => Promise<boolean>;
  providerAuthStatuses: (providers?: string[]) => Promise<ProviderAuthStatus[]>;
  commandExists: (command: string) => boolean;
};

type DoctorCheck = {
  name: string;
  ok: boolean;
  message: string;
  path?: string;
};

export async function providerSmokeCommand(
  args: string[],
  deps: ProviderCommandDeps,
): Promise<ProviderCommandResult> {
  try {
    const config = (await deps.loadConfig()).config;
    return smokePiOpenRouter({ live: args.includes("--live"), provider: config.provider });
  } catch (error) {
    console.error(`zdr: ${error instanceof Error ? error.message : String(error)}`);
    return { code: 1 };
  }
}

export async function doctorCommand(args: string[], deps: ProviderCommandDeps): Promise<ProviderCommandResult> {
  if (args.length > 0) {
    console.error(`zdr: unknown doctor option: ${args[0]}`);
    return { code: 2 };
  }

  const configPaths = getConfigPaths();
  const statePaths = getStatePaths();
  const cachePaths = getCachePaths();
  const telemetryPaths = getTelemetryPaths();
  const checks: DoctorCheck[] = [];
  let loaded: LoadedConfig | null = null;

  try {
    loaded = await deps.loadConfig();
    checks.push({ name: "config", ok: true, message: loaded.source, path: loaded.path });
  } catch (error) {
    checks.push({
      name: "config",
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      path: configPaths.config,
    });
  }

  const provider = loaded?.config.provider ?? null;
  let providerInfo: Record<string, unknown> | null = null;
  if (provider) {
    const { findEnvKeys } = await import("@earendil-works/pi-ai");
    const model = await resolveConfiguredModel(provider);
    checks.push({
      name: "provider_model",
      ok: model !== null,
      message: model ? `${model.provider}/${model.id}` : `${provider.name}/${provider.model} not found`,
    });

    const envKeys = findEnvKeys(provider.name) ?? [];
    const oauth = (await isKnownOAuthProvider(provider.name))
      ? (await deps.providerAuthStatuses([provider.name]))[0]
      : undefined;
    const authOk = oauth ? oauth.authenticated && oauth.expired !== true : envKeys.length > 0;
    checks.push({
      name: "provider_auth",
      ok: authOk,
      message: oauth
        ? oauth.authenticated
          ? oauth.expired
            ? "OAuth credentials expired"
            : "OAuth credentials available"
          : `run 'zdr provider-login ${provider.name}'`
        : envKeys.length > 0
          ? `env: ${envKeys.join(", ")}`
          : `set provider API key for ${provider.name}`,
    });

    providerInfo = {
      ...provider,
      known_model: model !== null,
      api: model?.api ?? null,
      auth: oauth
        ? {
            type: "oauth",
            authenticated: oauth.authenticated,
            expired: oauth.expired ?? null,
            expires_at: oauth.expires_at ?? null,
            refresh_available: oauth.refresh_available ?? null,
          }
        : {
            type: "env",
            env_keys: envKeys,
            authenticated: envKeys.length > 0,
          },
    };
  }

  const zoxideAvailable = deps.commandExists("zoxide");
  checks.push({
    name: "zoxide",
    ok: zoxideAvailable,
    message: zoxideAvailable ? "available" : "zoxide command not found",
  });

  const fzfAvailable = deps.commandExists("fzf");
  const fdAvailable = deps.commandExists("fd");
  const lastZ = await readLastZState().catch(() => null);
  const requiredOk = checks.every((check) => check.ok);
  console.log(
    JSON.stringify(
      {
        schema_version: 1,
        command: "doctor",
        ok: requiredOk,
        checks,
        provider: providerInfo,
        shell: {
          detected: detectedShell(),
          recorded_z_attempt: lastZ !== null,
          note: "A child process cannot inspect whether the current shell has sourced `zdr init`; recorded_z_attempt shows whether shell integration has captured a z jump.",
        },
        tools: {
          zoxide: zoxideAvailable,
          fzf: fzfAvailable,
          fd: fdAvailable,
        },
        paths: {
          config: configPaths.config,
          auth: getAuthPath(),
          state_dir: statePaths.stateDir,
          last_z: statePaths.lastZ,
          recovery_retry: statePaths.recoveryRetry,
          corrections: cachePaths.corrections,
          telemetry_events: telemetryPaths.events,
        },
      },
      null,
      2,
    ),
  );
  return { code: requiredOk ? 0 : 1 };
}

export async function configProviderCommand(
  args: string[],
  deps: ProviderCommandDeps,
): Promise<ProviderCommandResult> {
  const parsed = parseConfigProviderArgs(args);
  if (!parsed.ok) {
    console.error(`zdr: ${parsed.error}`);
    return { code: 2 };
  }
  try {
    const model = await resolveConfiguredModel(parsed.provider);
    if (!model) {
      console.error(`zdr: Pi did not return configured ${parsed.provider.name} model ${parsed.provider.model}`);
      return { code: 1 };
    }
    const config = await deps.setProviderConfig(parsed.provider);
    console.log(
      JSON.stringify(
        {
          schema_version: 1,
          path: config.path,
          provider: config.config.provider,
        },
        null,
        2,
      ),
    );
    return { code: 0 };
  } catch (error) {
    console.error(`zdr: ${error instanceof Error ? error.message : String(error)}`);
    return { code: 1 };
  }
}

export async function providerListCommand(args: string[]): Promise<ProviderCommandResult> {
  const parsed = parseOptionalProviderArg("provider-list", args);
  if (!parsed.ok) {
    console.error(`zdr: ${parsed.error}`);
    return { code: 2 };
  }
  try {
    console.log(JSON.stringify(await listProviders(parsed.provider), null, 2));
    return { code: 0 };
  } catch (error) {
    console.error(`zdr: ${error instanceof Error ? error.message : String(error)}`);
    return { code: 1 };
  }
}

export async function providerLoginCommand(
  args: string[],
  deps: ProviderCommandDeps,
): Promise<ProviderCommandResult> {
  const parsed = parseSingleProviderArg("provider-login", args);
  if (!parsed.ok) {
    console.error(`zdr: ${parsed.error}`);
    return { code: 2 };
  }

  try {
    const loginAbort = new AbortController();
    try {
      await deps.providerLogin(parsed.provider, {
        onAuth: (info) => {
          console.error(`zdr: open this URL to log in to ${parsed.provider}:`);
          console.error(info.url);
          if (info.instructions) {
            console.error(`zdr: ${info.instructions}`);
          }
          openBrowser(info.url);
        },
        onPrompt: async (prompt) => {
          return promptForOAuthInput(prompt.message, loginAbort.signal);
        },
        onProgress: (message) => console.error(`zdr: ${message}`),
        onManualCodeInput: async () => promptForOAuthInput("Paste redirect URL or authorization code:", loginAbort.signal),
      });
    } finally {
      loginAbort.abort();
    }
    console.log(JSON.stringify({ schema_version: 1, provider: parsed.provider, authenticated: true }, null, 2));
    return { code: 0 };
  } catch (error) {
    console.error(`zdr: ${error instanceof Error ? error.message : String(error)}`);
    return { code: 1 };
  }
}

export async function providerLogoutCommand(
  args: string[],
  deps: ProviderCommandDeps,
): Promise<ProviderCommandResult> {
  const parsed = parseSingleProviderArg("provider-logout", args);
  if (!parsed.ok) {
    console.error(`zdr: ${parsed.error}`);
    return { code: 2 };
  }
  try {
    const removed = await deps.providerLogout(parsed.provider);
    console.log(JSON.stringify({ schema_version: 1, provider: parsed.provider, removed }, null, 2));
    return { code: 0 };
  } catch (error) {
    console.error(`zdr: ${error instanceof Error ? error.message : String(error)}`);
    return { code: 1 };
  }
}

export async function providerAuthStatusCommand(
  args: string[],
  deps: ProviderCommandDeps,
): Promise<ProviderCommandResult> {
  const parsed = parseOptionalProviderArg("provider-auth-status", args);
  if (!parsed.ok) {
    console.error(`zdr: ${parsed.error}`);
    return { code: 2 };
  }
  try {
    const statuses = await deps.providerAuthStatuses(parsed.provider ? [parsed.provider] : undefined);
    console.log(JSON.stringify({ schema_version: 1, providers: statuses }, null, 2));
    return { code: 0 };
  } catch (error) {
    console.error(`zdr: ${error instanceof Error ? error.message : String(error)}`);
    return { code: 1 };
  }
}

async function promptForOAuthInput(message: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) {
    throw new Error("OAuth login completed");
  }
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    if (signal) {
      return await rl.question(`zdr: ${message} `, { signal });
    }
    return await rl.question(`zdr: ${message} `);
  } finally {
    rl.close();
  }
}

function openBrowser(url: string): void {
  if (process.env.ZDR_NO_OPEN_BROWSER === "1") {
    return;
  }
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    Bun.spawn([command, ...args], {
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    // The printed URL is the fallback.
  }
}

function detectedShell(): string {
  const shell = process.env.SHELL;
  if (!shell) {
    return "unknown";
  }
  return shell.split("/").at(-1) || shell;
}
