import { spawnSync } from "node:child_process";

const steps: Array<{ name: string; command: string[]; optional?: boolean }> = [
  { name: "verify", command: ["bun", "run", "verify"] },
  { name: "build release archives", command: ["bun", "run", "release:build"] },
  { name: "generate Homebrew formula", command: ["bun", "run", "release:formula"] },
  { name: "check Homebrew formula Ruby syntax", command: ["ruby", "-c", "Formula/zoxide-doctor.rb"] },
];

for (const step of steps) {
  runStep(step);
}

if (commandExists("brew")) {
  runStep({ name: "check Homebrew formula style", command: ["brew", "style", "Formula/zoxide-doctor.rb"] });
} else {
  console.log("skipping Homebrew style check: brew not found");
}

console.log("release preparation complete");

function runStep(step: { name: string; command: string[]; optional?: boolean }): void {
  console.log(`\n==> ${step.name}`);
  const [command, ...args] = step.command;
  if (!command) {
    throw new Error(`empty command for step: ${step.name}`);
  }
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status === 0) {
    return;
  }
  if (step.optional) {
    console.warn(`optional release step failed: ${step.name}`);
    return;
  }
  const suffix = result.status === null ? "" : ` with status ${result.status}`;
  throw new Error(`release step failed${suffix}: ${step.name}`);
}

function commandExists(command: string): boolean {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  return result.status === 0;
}
