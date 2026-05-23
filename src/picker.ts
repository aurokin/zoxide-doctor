import { spawn } from "node:child_process";
import { normalize as normalizePath } from "node:path";
import { fdExcludeArgs } from "./fd-excludes.js";
import type { ZoxideEntry } from "./zoxide.js";

export type PickerResult =
  | { status: "selected"; path: string }
  | { status: "cancelled" }
  | { status: "unavailable"; reason: string };

export type PickerInput = {
  query: string;
  zoxideEntries: ZoxideEntry[];
  rejectedPaths?: string[];
  scanRoots?: string[];
  excludeScanRoots?: string[];
  maxFdResults?: number;
  maxFdDepth?: number;
};

export type CommandOutput = {
  code: number;
  stdout: string;
  stderr: string;
};

export type PickerDeps = {
  isCommandAvailable?: (command: "fd" | "fzf") => Promise<boolean>;
  runCommand?: (input: { command: string; args: string[]; stdin?: string }) => Promise<CommandOutput>;
};

const DEFAULT_MAX_FD_RESULTS = 200;
const DEFAULT_MAX_FD_DEPTH = 4;

export async function runPicker(input: PickerInput, deps: PickerDeps = {}): Promise<PickerResult> {
  const runCommand = deps.runCommand ?? runSystemCommand;
  const isCommandAvailable = deps.isCommandAvailable ?? ((command) => commandAvailable(command, runCommand));

  if (!(await isCommandAvailable("fzf"))) {
    return { status: "unavailable", reason: "fzf is required for interactive picker fallback" };
  }

  const fdPaths =
    input.scanRoots && input.scanRoots.length > 0 && (await isCommandAvailable("fd"))
      ? await loadFdPaths(
          input.scanRoots,
          input.excludeScanRoots ?? [],
          input.maxFdResults ?? DEFAULT_MAX_FD_RESULTS,
          runCommand,
          input.maxFdDepth ?? DEFAULT_MAX_FD_DEPTH,
        )
      : [];
  const paths = buildPickerPaths({
    zoxideEntries: input.zoxideEntries,
    fdPaths,
    rejectedPaths: input.rejectedPaths ?? [],
  });
  if (paths.length === 0) {
    return { status: "cancelled" };
  }

  const output = await runCommand({
    command: "fzf",
    args: [
      "--query",
      input.query,
      "--prompt",
      "zdr> ",
      "--header",
      "Select a directory for Zoxide Doctor recovery",
      "--height",
      "40%",
      "--layout",
      "reverse",
    ],
    stdin: `${paths.join("\n")}\n`,
  });
  const selected = output.stdout.split(/\r?\n/).find((line) => line.length > 0);
  if (output.code !== 0 || !selected) {
    return { status: "cancelled" };
  }
  if (!paths.includes(selected)) {
    return { status: "cancelled" };
  }
  return { status: "selected", path: selected };
}

export function buildPickerPaths(input: {
  zoxideEntries: ZoxideEntry[];
  fdPaths?: string[];
  rejectedPaths?: string[];
}): string[] {
  const rejected = new Set(input.rejectedPaths ?? []);
  const paths: string[] = [];
  const seen = new Set<string>();

  for (const path of [...input.zoxideEntries.map((entry) => entry.path), ...(input.fdPaths ?? [])]) {
    if (rejected.has(path) || seen.has(path)) {
      continue;
    }
    seen.add(path);
    paths.push(path);
  }

  return paths;
}

async function loadFdPaths(
  scanRoots: string[],
  excludeScanRoots: string[],
  maxResults: number,
  runCommand: NonNullable<PickerDeps["runCommand"]>,
  maxDepth = DEFAULT_MAX_FD_DEPTH,
): Promise<string[]> {
  if (maxResults <= 0) {
    return [];
  }
  const perRootMaxResults = Math.max(1, Math.ceil(maxResults / scanRoots.length));
  const paths: string[] = [];
  for (const root of scanRoots) {
    const remaining = maxResults - uniqueText(paths).length;
    if (remaining <= 0) {
      break;
    }
    const commandMaxResults = Math.min(remaining, perRootMaxResults);
    const output = await runCommand({
      command: "fd",
      args: [
        "--type",
        "d",
        "--hidden",
        "--color",
        "never",
        "--max-depth",
        String(maxDepth),
        ...fdExcludeArgs({ roots: [root], excludeRoots: excludeScanRoots }),
        "--max-results",
        String(commandMaxResults),
        ".",
        root,
      ],
    });
    if (output.code !== 0) {
      continue;
    }
    paths.push(
      ...output.stdout
        .split(/\r?\n/)
        .filter((path) => path.length > 0)
        .map(normalizeDirectoryPath)
        .filter((path) => !isPathInsideAny(path, excludeScanRoots))
        .slice(0, commandMaxResults),
    );
  }
  return uniqueText(paths).slice(0, maxResults);
}

function normalizeDirectoryPath(path: string): string {
  const normalized = normalizePath(path);
  return normalized.length > 1 ? normalized.replace(/[\\/]+$/, "") : normalized;
}

function isPathInsideAny(path: string, roots: string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

function uniqueText(values: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

async function commandAvailable(
  command: "fd" | "fzf",
  runCommand: NonNullable<PickerDeps["runCommand"]>,
): Promise<boolean> {
  const output = await runCommand({
    command: "sh",
    args: ["-c", `command -v ${command}`],
  });
  return output.code === 0;
}

function runSystemCommand(input: { command: string; args: string[]; stdin?: string }): Promise<CommandOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
      });
    });

    if (input.stdin) {
      child.stdin.end(input.stdin);
    } else {
      child.stdin.end();
    }
  });
}
