import { describe, expect, test } from "bun:test";
import { generateHomebrewFormula, parseSha256Sums } from "./generate-homebrew-formula.js";

const checksumsText = `
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  zdr-v1.2.3-darwin-arm64.tar.gz
bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  zdr-v1.2.3-darwin-x64.tar.gz
cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc  zdr-v1.2.3-linux-arm64.tar.gz
dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd  zdr-v1.2.3-linux-x64-baseline.tar.gz
`;

describe("Homebrew formula generation", () => {
  test("parses release checksums", () => {
    const checksums = parseSha256Sums(checksumsText);

    expect(checksums.get("zdr-v1.2.3-darwin-arm64.tar.gz")).toBe("a".repeat(64));
    expect(checksums.get("zdr-v1.2.3-linux-x64-baseline.tar.gz")).toBe("d".repeat(64));
  });

  test("generates platform-specific release URLs and checksums", () => {
    const formula = generateHomebrewFormula({
      version: "v1.2.3",
      checksums: parseSha256Sums(checksumsText),
      repository: "owner/repo",
    });

    expect(formula).toContain("class ZoxideDoctor < Formula");
    expect(formula).toContain('homepage "https://github.com/owner/repo"');
    expect(formula).toContain('version "1.2.3"');
    expect(formula).toContain("on_macos do");
    expect(formula).toContain("on_linux do");
    expect(formula).toContain("if Hardware::CPU.arm?");
    expect(formula).toContain("if Hardware::CPU.intel?");
    expect(formula).toContain('url "https://github.com/owner/repo/releases/download/v1.2.3/zdr-v1.2.3-darwin-arm64.tar.gz"');
    expect(formula).toContain(`sha256 "${"a".repeat(64)}"`);
    expect(formula).toContain('url "https://github.com/owner/repo/releases/download/v1.2.3/zdr-v1.2.3-linux-x64-baseline.tar.gz"');
    expect(formula).toContain(`sha256 "${"d".repeat(64)}"`);
    expect(formula).toContain('bin.install executable => "zdr"');
  });

  test("fails when a required checksum is missing", () => {
    const checksums = parseSha256Sums(checksumsText);
    checksums.delete("zdr-v1.2.3-darwin-x64.tar.gz");

    expect(() => generateHomebrewFormula({ version: "1.2.3", checksums })).toThrow("missing checksum for zdr-v1.2.3-darwin-x64.tar.gz");
  });

  test("rejects malformed checksum lines", () => {
    expect(() => parseSha256Sums("not-a-checksum  zdr-v1.2.3-darwin-arm64.tar.gz")).toThrow("invalid SHA256SUMS line");
  });
});
