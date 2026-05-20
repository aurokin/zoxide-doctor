import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { $ } from "bun";

type PackageJson = {
  version?: string;
};

type ReleaseTarget = {
  artifact: string;
  bunTarget: string;
};

const releaseTargets: ReleaseTarget[] = [
  { artifact: "darwin-arm64", bunTarget: "bun-darwin-arm64" },
  { artifact: "darwin-x64", bunTarget: "bun-darwin-x64" },
  { artifact: "linux-arm64", bunTarget: "bun-linux-arm64" },
  { artifact: "linux-x64-baseline", bunTarget: "bun-linux-x64-baseline" },
];

async function readPackageVersion(): Promise<string> {
  const packageJson = (await Bun.file("package.json").json()) as PackageJson;
  if (!packageJson.version) {
    throw new Error("package.json is missing a version");
  }
  return packageJson.version;
}

async function sha256(filePath: string): Promise<string> {
  const digest = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(filePath).arrayBuffer())
    .digest("hex");
  return digest.toString();
}

function releaseReadme(version: string, target: ReleaseTarget): string {
  return `# Zoxide Doctor ${version} (${target.artifact})

This archive contains the standalone \`zdr\` executable built with Bun target \`${target.bunTarget}\`.

Install it by placing \`zdr\` somewhere on your \`PATH\`, then run:

\`\`\`sh
zdr --version
zdr init zsh
\`\`\`

Use \`zdr init bash\` or \`zdr init fish\` if that is your shell.
`;
}

const version = await readPackageVersion();
const releaseDir = "release";

await rm(releaseDir, { recursive: true, force: true });
await mkdir(releaseDir, { recursive: true });

const checksums: string[] = [];

for (const target of releaseTargets) {
  const packageName = `zdr-v${version}-${target.artifact}`;
  const packageDir = join(releaseDir, packageName);
  const executablePath = join(packageDir, "zdr");
  const archivePath = join(releaseDir, `${packageName}.tar.gz`);

  await mkdir(packageDir, { recursive: true });

  await $`bun build src/cli.ts --compile --target=${target.bunTarget} --outfile=${executablePath}`;
  await $`chmod 755 ${executablePath}`;
  await writeFile(join(packageDir, "README.md"), releaseReadme(version, target));
  await $`tar -C ${releaseDir} -czf ${archivePath} ${packageName}`;

  const checksum = await sha256(archivePath);
  checksums.push(`${checksum}  ${basename(archivePath)}`);
  console.log(`built ${archivePath}`);
}

await writeFile(join(releaseDir, "SHA256SUMS"), `${checksums.join("\n")}\n`);
console.log(`wrote ${join(releaseDir, "SHA256SUMS")}`);
