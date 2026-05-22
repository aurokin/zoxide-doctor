import { lstat, mkdir, rm, symlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { $ } from "bun";

const home = process.env.HOME;
if (!home) {
  throw new Error("HOME is required to install into ~/.local/bin");
}

const installDir = resolve(home, ".local/bin");
const target = resolve(installDir, "zdr");
const source = resolve("dist/zdr");

await $`bun run build`;
await mkdir(dirname(target), { recursive: true });

try {
  const current = await lstat(target);
  if (current.isDirectory()) {
    throw new Error(`${target} is a directory; remove it before installing the dev build`);
  }
  await rm(target);
} catch (error) {
  if (!isNotFound(error)) {
    throw error;
  }
}

await symlink(source, target);
await $`${target} --version`;

console.log(`installed dev build: ${target} -> ${source}`);
console.log("source shell integration after zoxide init if zdr does not cd:");
console.log('  eval "$(zoxide init zsh)"');
console.log('  eval "$(zdr init zsh)"');
console.log("use bash or fish in those commands if that is your shell");

const pathEntries = (process.env.PATH ?? "").split(":");
if (!pathEntries.includes(installDir)) {
  console.warn(`warning: ${installDir} is not on PATH`);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
