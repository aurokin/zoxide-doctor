import { spawn } from "node:child_process";

export type ZoxideEntry = {
  path: string;
  score: number;
  rank: number;
};

export async function loadZoxideEntries(): Promise<ZoxideEntry[]> {
  const output = await runZoxide(["query", "--list", "--score"]);
  return parseZoxideList(output);
}

export function parseZoxideList(output: string): ZoxideEntry[] {
  const entries: ZoxideEntry[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }
    const match = line.match(/^\s*([0-9]+(?:\.[0-9]+)?)\s+(.+)$/);
    if (!match) {
      continue;
    }
    const scoreText = match[1];
    const path = match[2];
    if (!scoreText || !path) {
      continue;
    }
    const score = Number.parseFloat(scoreText);
    if (!Number.isFinite(score)) {
      continue;
    }
    entries.push({
      path,
      score,
      rank: entries.length + 1,
    });
  }
  return entries;
}

function runZoxide(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("zoxide", args, {
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
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr.trim() || `zoxide exited with status ${code ?? "unknown"}`));
    });
  });
}
