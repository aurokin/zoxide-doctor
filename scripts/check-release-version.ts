import { readFileSync } from "node:fs";

type PackageJson = {
  version?: string;
};

function readPackageVersion(): string {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as PackageJson;
  if (!packageJson.version) {
    throw new Error("package.json is missing a version");
  }
  return packageJson.version;
}

function releaseTag(): string {
  const explicitTag = process.argv[2];
  if (explicitTag) {
    return explicitTag;
  }

  const githubRefName = process.env.GITHUB_REF_NAME;
  if (githubRefName) {
    return githubRefName;
  }

  throw new Error("pass a tag argument or set GITHUB_REF_NAME");
}

const version = readPackageVersion();
const tag = releaseTag();
const expectedTag = `v${version}`;

if (tag !== expectedTag) {
  console.error(`release tag ${tag} does not match package version ${expectedTag}`);
  process.exit(1);
}

console.log(`release tag ${tag} matches package version ${version}`);
