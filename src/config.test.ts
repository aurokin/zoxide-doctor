import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG, getConfigPaths, loadConfig } from "./config.js";

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
});

async function writeConfig(value: unknown): Promise<void> {
  const path = getConfigPaths().config;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
