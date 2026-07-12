import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  clearEscalationConfig,
  DEFAULT_CONFIG,
  getConfigPaths,
  loadConfig,
  setEscalationConfig,
  setProviderConfig,
} from "./config.js";

let previousXdgConfigHome: string | undefined;
let tempDir: string;

beforeEach(async () => {
  previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  tempDir = await mkdtemp(join(tmpdir(), "zdr-config-"));
  process.env.XDG_CONFIG_HOME = tempDir;
});

afterEach(async () => {
  if (previousXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
  }
  await rm(tempDir, { recursive: true, force: true });
});

describe("config", () => {
  test("loads defaults when config file is missing", async () => {
    expect(await loadConfig()).toEqual({
      path: getConfigPaths().config,
      source: "default",
      config: DEFAULT_CONFIG,
    });
  });

  test("merges a partial config file with defaults", async () => {
    await writeConfig({
      schema_version: 1,
      provider: {
        model: "anthropic/claude-sonnet-4.5",
      },
      telemetry: {
        enabled: true,
        max_events: 25,
      },
    });

    expect(await loadConfig()).toEqual({
      path: getConfigPaths().config,
      source: "file",
      config: {
        ...DEFAULT_CONFIG,
        provider: {
          ...DEFAULT_CONFIG.provider,
          model: "anthropic/claude-sonnet-4.5",
        },
        context: {
          default_dir: "~",
          include_dirs: [],
          exclude_dirs: [],
        },
        telemetry: {
          enabled: true,
          max_events: 25,
        },
      },
    });
  });

  test("rejects unknown schema versions", async () => {
    await writeConfig({ schema_version: 2 });

    await expect(loadConfig()).rejects.toThrow("config schema_version must be 1");
  });

  test("rejects invalid config fields", async () => {
    await writeConfig({
      provider: {
        name: "",
      },
    });

    await expect(loadConfig()).rejects.toThrow("config provider.name must be a non-empty string");
  });

  test("rejects invalid telemetry retention", async () => {
    await writeConfig({
      telemetry: {
        max_events: -1,
      },
    });

    await expect(loadConfig()).rejects.toThrow("config telemetry.max_events must be an integer between 0 and 100000");
  });

  test("rejects oversized telemetry retention", async () => {
    await writeConfig({
      telemetry: {
        max_events: 100_001,
      },
    });

    await expect(loadConfig()).rejects.toThrow("config telemetry.max_events must be an integer between 0 and 100000");
  });

  test("rejects unsupported config keys", async () => {
    await writeConfig({
      provider: {
        model: "google/gemini-2.5-flash-lite",
        timeout_ms: 1000,
      },
    });

    await expect(loadConfig()).rejects.toThrow("config provider contains unsupported key: timeout_ms");
  });

  test("loads context scan scope settings", async () => {
    await writeConfig({
      context: {
        default_dir: "~/code",
        include_dirs: ["/Volumes/work"],
        exclude_dirs: ["~/code/private"],
      },
    });

    await expect(loadConfig()).resolves.toMatchObject({
      config: {
        context: {
          default_dir: "~/code",
          include_dirs: ["/Volumes/work"],
          exclude_dirs: ["~/code/private"],
        },
      },
    });
  });

  test("rejects invalid context arrays", async () => {
    await writeConfig({
      context: {
        include_dirs: ["/repo", ""],
      },
    });

    await expect(loadConfig()).rejects.toThrow("config context.include_dirs[1] must be a non-empty string");
  });

  test("sets provider config while preserving other settings", async () => {
    await writeConfig({
      schema_version: 1,
      telemetry: {
        enabled: true,
        max_events: 25,
      },
    });

    await expect(
      setProviderConfig({
        name: "openai-codex",
        model: "gpt-5.3-codex-spark",
      }),
    ).resolves.toMatchObject({
      source: "file",
      config: {
        provider: {
          name: "openai-codex",
          model: "gpt-5.3-codex-spark",
        },
        telemetry: {
          enabled: true,
          max_events: 25,
        },
      },
    });

    await expect(loadConfig()).resolves.toMatchObject({
      source: "file",
      config: {
        provider: {
          name: "openai-codex",
          model: "gpt-5.3-codex-spark",
        },
        telemetry: {
          enabled: true,
          max_events: 25,
        },
      },
    });
  });
  test("loads a claude escalation block", async () => {
    await writeConfig({
      schema_version: 1,
      escalation: { backend: "claude", model: "sonnet" },
    });

    await expect(loadConfig()).resolves.toMatchObject({
      config: { escalation: { backend: "claude", model: "sonnet" } },
    });
  });

  test("defaults escalation backend to pi and name to the fast-tier provider", async () => {
    await writeConfig({
      schema_version: 1,
      provider: { name: "openai-codex", model: "gpt-5.3-codex-spark" },
      escalation: { model: "gpt-5.3-codex" },
    });

    await expect(loadConfig()).resolves.toMatchObject({
      config: { escalation: { backend: "pi", name: "openai-codex", model: "gpt-5.3-codex" } },
    });
  });

  test("keeps escalation absent when not configured", async () => {
    await writeConfig({ schema_version: 1 });

    const loaded = await loadConfig();
    expect(loaded.config.escalation).toBeUndefined();
  });

  test("rejects escalation name when backend is claude", async () => {
    await writeConfig({
      schema_version: 1,
      escalation: { backend: "claude", name: "openrouter", model: "sonnet" },
    });

    await expect(loadConfig()).rejects.toThrow("config escalation.name is not allowed when backend is claude");
  });

  test("rejects escalation without a model", async () => {
    await writeConfig({
      schema_version: 1,
      escalation: { backend: "claude" },
    });

    await expect(loadConfig()).rejects.toThrow("config escalation.model must be a non-empty string");
  });

  test("rejects unsupported escalation backend", async () => {
    await writeConfig({
      schema_version: 1,
      escalation: { backend: "gemini", model: "x" },
    });

    await expect(loadConfig()).rejects.toThrow("config escalation.backend must be one of pi, claude");
  });

  test("sets and clears the escalation block while preserving other settings", async () => {
    await writeConfig({
      schema_version: 1,
      telemetry: { enabled: true, max_events: 25 },
    });

    await expect(setEscalationConfig({ backend: "claude", model: "sonnet" })).resolves.toMatchObject({
      config: {
        escalation: { backend: "claude", model: "sonnet" },
        telemetry: { enabled: true, max_events: 25 },
      },
    });
    await expect(loadConfig()).resolves.toMatchObject({
      config: { escalation: { backend: "claude", model: "sonnet" } },
    });

    const cleared = await clearEscalationConfig();
    expect(cleared.config.escalation).toBeUndefined();
    expect((await loadConfig()).config.escalation).toBeUndefined();
  });
});

async function writeConfig(value: unknown): Promise<void> {
  const path = getConfigPaths().config;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
