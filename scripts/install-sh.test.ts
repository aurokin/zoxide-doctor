import { describe, expect, test } from "bun:test";

const script = "scripts/install.sh";

describe("release install script", () => {
  test("maps macOS arm64 to the matching release archive", async () => {
    const result = await installPlan({
      ZDR_INSTALL_OS: "darwin",
      ZDR_INSTALL_ARCH: "arm64",
      ZDR_INSTALL_VERSION: "1.2.3",
      ZDR_INSTALL_DIR: "/tmp/zdr-bin",
    });

    expect(result.exitCode).toBe(0);
    expect(parsePlan(result.stdout)).toMatchObject({
      version: "1.2.3",
      tag: "v1.2.3",
      artifact: "darwin-arm64",
      archive: "zdr-v1.2.3-darwin-arm64.tar.gz",
      archive_url: "https://github.com/aurokin/zoxide-doctor/releases/download/v1.2.3/zdr-v1.2.3-darwin-arm64.tar.gz",
      checksums_url: "https://github.com/aurokin/zoxide-doctor/releases/download/v1.2.3/SHA256SUMS",
      install_dir: "/tmp/zdr-bin",
    });
  });

  test("maps Linux x64 to the baseline release archive", async () => {
    const result = await installPlan({
      ZDR_INSTALL_OS: "linux",
      ZDR_INSTALL_ARCH: "x86_64",
      ZDR_INSTALL_VERSION: "0.9.0",
    });

    expect(result.exitCode).toBe(0);
    expect(parsePlan(result.stdout)).toMatchObject({
      artifact: "linux-x64-baseline",
      archive: "zdr-v0.9.0-linux-x64-baseline.tar.gz",
    });
  });

  test("accepts versions with or without a leading v", async () => {
    const result = await installPlan({
      ZDR_INSTALL_OS: "linux",
      ZDR_INSTALL_ARCH: "arm64",
      ZDR_INSTALL_VERSION: "v1.2.3",
    });

    expect(result.exitCode).toBe(0);
    expect(parsePlan(result.stdout)).toMatchObject({
      version: "1.2.3",
      tag: "v1.2.3",
      archive: "zdr-v1.2.3-linux-arm64.tar.gz",
    });
  });

  test("rejects unsupported platforms before downloading", async () => {
    const result = await installPlan({
      ZDR_INSTALL_OS: "freebsd",
      ZDR_INSTALL_ARCH: "x86_64",
      ZDR_INSTALL_VERSION: "1.2.3",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unsupported platform: freebsd x86_64");
  });
});

async function installPlan(env: Record<string, string>): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: ["sh", script, "--print-plan"],
    env: {
      ...process.env,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout, stderr };
}

function parsePlan(stdout: string): Record<string, string> {
  return Object.fromEntries(
    stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}
