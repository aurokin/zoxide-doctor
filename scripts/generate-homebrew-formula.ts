import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

type PackageJson = {
  version?: string;
};

export type FormulaInput = {
  version: string;
  checksums: Map<string, string>;
  repository?: string;
};

type FormulaTarget = {
  artifact: string;
  osBlock: "on_macos" | "on_linux";
  cpuBranch: "arm" | "intel";
};

const formulaTargets: FormulaTarget[] = [
  { artifact: "darwin-arm64", osBlock: "on_macos", cpuBranch: "arm" },
  { artifact: "darwin-x64", osBlock: "on_macos", cpuBranch: "intel" },
  { artifact: "linux-arm64", osBlock: "on_linux", cpuBranch: "arm" },
  { artifact: "linux-x64-baseline", osBlock: "on_linux", cpuBranch: "intel" },
];

export function parseSha256Sums(input: string): Map<string, string> {
  const checksums = new Map<string, string>();
  for (const line of input.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(trimmed);
    if (!match) {
      throw new Error(`invalid SHA256SUMS line: ${line}`);
    }
    const checksum = match[1];
    const filename = match[2];
    if (!checksum || !filename) {
      throw new Error(`invalid SHA256SUMS line: ${line}`);
    }
    checksums.set(filename, checksum.toLowerCase());
  }
  return checksums;
}

export function generateHomebrewFormula(input: FormulaInput): string {
  const repository = input.repository ?? "aurokin/zoxide-doctor";
  const version = normalizeVersion(input.version);
  const macosBlock = formulaOsBlock({ repository, version, osBlock: "on_macos", checksums: input.checksums });
  const linuxBlock = formulaOsBlock({ repository, version, osBlock: "on_linux", checksums: input.checksums });

  return `# typed: strict
# frozen_string_literal: true

# Homebrew formula for Zoxide Doctor.
class ZoxideDoctor < Formula
  desc "Small LLM-powered doctor for bad zoxide jumps"
  homepage "https://github.com/${repository}"
  version "${version}"

${macosBlock}

${linuxBlock}

  def install
    executable = if File.exist?("zdr")
      "zdr"
    else
      Dir["zdr-v#{version}-*/zdr"].first
    end
    bin.install executable => "zdr"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/zdr --version")
  end
end
`;
}

async function main(): Promise<void> {
  const version = await readPackageVersion();
  const checksums = parseSha256Sums(await readFile("release/SHA256SUMS", "utf8"));
  const formula = generateHomebrewFormula({ version, checksums });
  const outputPath = process.argv[2] ?? "Formula/zoxide-doctor.rb";
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, formula);
  console.log(`wrote ${outputPath}`);
}

async function readPackageVersion(): Promise<string> {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as PackageJson;
  if (!packageJson.version) {
    throw new Error("package.json is missing a version");
  }
  return packageJson.version;
}

function formulaOsBlock(input: {
  repository: string;
  version: string;
  osBlock: FormulaTarget["osBlock"];
  checksums: Map<string, string>;
}): string {
  const targets = formulaTargets.filter((target) => target.osBlock === input.osBlock);
  const [armTarget, intelTarget] = [
    targets.find((target) => target.cpuBranch === "arm"),
    targets.find((target) => target.cpuBranch === "intel"),
  ];
  if (!armTarget || !intelTarget) {
    throw new Error(`missing formula targets for ${input.osBlock}`);
  }

  const arm = formulaArchive(input.repository, input.version, armTarget, input.checksums);
  const intel = formulaArchive(input.repository, input.version, intelTarget, input.checksums);

  return `  ${input.osBlock} do
    if Hardware::CPU.arm?
      url "${arm.url}"
      sha256 "${arm.checksum}"
    elsif Hardware::CPU.intel?
      url "${intel.url}"
      sha256 "${intel.checksum}"
    end
  end`;
}

function formulaArchive(repository: string, version: string, target: FormulaTarget, checksums: Map<string, string>): { url: string; checksum: string } {
  const archive = `zdr-v${version}-${target.artifact}.tar.gz`;
  const checksum = checksums.get(archive);
  if (!checksum) {
    throw new Error(`missing checksum for ${archive}`);
  }
  return {
    url: `https://github.com/${repository}/releases/download/v${version}/${archive}`,
    checksum,
  };
}

function normalizeVersion(version: string): string {
  return version.startsWith("v") ? version.slice(1) : version;
}

if (import.meta.main) {
  await main();
}
