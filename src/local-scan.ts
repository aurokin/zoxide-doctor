import { spawn } from "node:child_process";
import { normalize as normalizePath } from "node:path";

export type LocalScanInput = {
  query: string;
  roots: string[];
  maxResults?: number;
  maxDepth?: number;
};

export type CommandOutput = {
  code: number;
  stdout: string;
  stderr: string;
};

export type LocalScanDeps = {
  isCommandAvailable?: (command: "fd") => Promise<boolean>;
  runCommand?: (input: { command: string; args: string[] }) => Promise<CommandOutput>;
};

const DEFAULT_MAX_RESULTS = 50;
const DEFAULT_MAX_DEPTH = 4;

export async function scanLocalDirectories(input: LocalScanInput, deps: LocalScanDeps = {}): Promise<string[]> {
  const roots = uniqueText(input.roots).filter((root) => root.length > 0);
  if (roots.length === 0) {
    return [];
  }

  const runCommand = deps.runCommand ?? runSystemCommand;
  const isCommandAvailable = deps.isCommandAvailable ?? ((command) => commandAvailable(command, runCommand));
  if (!(await isCommandAvailable("fd"))) {
    return [];
  }

  const maxResults = input.maxResults ?? DEFAULT_MAX_RESULTS;
  const maxDepth = input.maxDepth ?? DEFAULT_MAX_DEPTH;
  const paths: string[] = [];
  for (const pattern of scanPatterns(input.query)) {
    const remaining = maxResults - uniqueText(paths).length;
    if (remaining <= 0) {
      break;
    }
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
        "--max-results",
        String(remaining),
        pattern,
        ...roots,
      ],
    });
    if (output.code !== 0) {
      continue;
    }
    paths.push(...output.stdout.split(/\r?\n/).filter((path) => path.length > 0).map(normalizeDirectoryPath));
    if (uniqueText(paths).length >= maxResults) {
      break;
    }
  }

  return uniqueText(paths).slice(0, maxResults);
}

function scanPatterns(query: string): string[] {
  const normalized = query.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
  const patterns = [
    normalized,
    ...words,
    normalized.length >= 2 ? normalized.split("").join(".*") : "",
  ].filter((pattern) => pattern.length > 0);
  return uniqueText(patterns);
}

function normalizeDirectoryPath(path: string): string {
  const normalized = normalizePath(path);
  return normalized.length > 1 ? normalized.replace(/[\\/]+$/, "") : normalized;
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
  command: "fd",
  runCommand: NonNullable<LocalScanDeps["runCommand"]>,
): Promise<boolean> {
  const output = await runCommand({
    command: "sh",
    args: ["-c", `command -v ${command}`],
  });
  return output.code === 0;
}

function runSystemCommand(input: { command: string; args: string[] }): Promise<CommandOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      stdio: ["ignore", "pipe", "pipe"],
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
  });
}
