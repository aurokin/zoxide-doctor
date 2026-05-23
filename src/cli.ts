#!/usr/bin/env bun

import packageJson from "../package.json" with { type: "json" };
import { directQueryCommand } from "./direct-query.js";
import { recoverCommand } from "./recovery.js";
import {
  benchmarkProviderCommand,
  benchmarkSuiteCommand,
  debugProviderTimingCommand,
  debugTimingCommand,
} from "./diagnostics.js";
import {
  debugCandidatesCommand,
  debugConfigCommand,
  debugCorrectionsCommand,
  debugEventsCommand,
  debugSelectCommand,
  debugStateCommand,
  forgetCommand,
  pruneEventsCommand,
} from "./local-commands.js";
import {
  configProviderCommand,
  doctorCommand,
  providerAuthStatusCommand,
  providerListCommand,
  providerLoginCommand,
  providerLogoutCommand,
  providerSmokeCommand,
} from "./provider/commands.js";
import {
  clearRecoveryRetryCommand,
  finishZCommand,
  initCommand,
  recordZCommand,
} from "./shell-commands.js";
import { defaultDeps, type CliDeps } from "./runtime-deps.js";

type CommandResult = {
  code: number;
};

const VERSION = packageJson.version;

export async function main(argv: string[], deps: CliDeps = defaultDeps): Promise<CommandResult> {
  const [command, ...args] = argv;

  if (command === "--help" || command === "-h") {
    printHelp();
    return { code: 0 };
  }

  if (!command) {
    return recoverCommand(deps);
  }

  if (command === "--version" || command === "-V") {
    console.log(VERSION);
    return { code: 0 };
  }

  switch (command) {
    case "init":
      return initCommand(args);
    case "record-z":
      return recordZCommand(args);
    case "finish-z":
      return finishZCommand(args);
    case "clear-recovery-retry":
      return clearRecoveryRetryCommand();
    case "debug-state":
      return debugStateCommand();
    case "debug-candidates":
      return debugCandidatesCommand(args, deps);
    case "debug-select":
      return debugSelectCommand(args, deps);
    case "debug-corrections":
      return debugCorrectionsCommand();
    case "debug-config":
      return debugConfigCommand(deps);
    case "debug-events":
      return debugEventsCommand(args, deps);
    case "debug-timing":
      return debugTimingCommand(args, deps, VERSION);
    case "debug-provider-timing":
      return debugProviderTimingCommand(args, deps);
    case "benchmark-provider":
      return benchmarkProviderCommand(args, deps);
    case "benchmark-suite":
      return benchmarkSuiteCommand(args, deps);
    case "doctor":
      return doctorCommand(args, deps);
    case "config-provider":
      return configProviderCommand(args, deps);
    case "prune-events":
      return pruneEventsCommand(args, deps);
    case "forget":
      return forgetCommand(args);
    case "provider-smoke":
      return providerSmokeCommand(args, deps);
    case "provider-list":
      return providerListCommand(args);
    case "provider-login":
      return providerLoginCommand(args, deps);
    case "provider-logout":
      return providerLogoutCommand(args, deps);
    case "provider-auth-status":
      return providerAuthStatusCommand(args, deps);
    default:
      if (command.startsWith("-")) {
        console.error(`zdr: unknown option: ${command}`);
        return { code: 2 };
      }
      return directQueryCommand([command, ...args], deps);
  }
}

function printHelp(): void {
  console.log(`zdr ${VERSION}

Usage:
  zdr                 Repair the last bad zoxide jump
  zdr <query>         Direct lookup from correction cache or model selection
  zdr init zsh        Print zsh integration (placeholder)
  zdr record-z        Internal shell-state command
  zdr finish-z        Internal shell-state command
  zdr clear-recovery-retry
                      Internal shell-state command
  zdr debug-state     Print recorded z state
  zdr debug-candidates
                      Print candidate list for the recorded z state
  zdr debug-select   Ask the model to select from recorded candidates
  zdr debug-corrections
                      Print direct-query correction cache
  zdr debug-config   Print merged config
  zdr debug-events [--limit <count>]
                      Print local telemetry events as JSON
  zdr debug-timing [query]
                      Measure local timing paths as JSON
  zdr debug-timing [query] --budget-ms <ms>
                      Include local timing budget status in JSON
  zdr debug-provider-timing [query]
                      Measure live provider selection timing as JSON
  zdr benchmark-provider [query] [--repeat <count>]
                      Repeat live provider selection and summarize latency
  zdr benchmark-provider [query] --provider <provider> --model <model>
                      Benchmark a provider/model without changing config
  zdr benchmark-provider [query] --jsonl
                      Stream benchmark context, iterations, and summary as JSONL
  zdr benchmark-suite [query] [--repeat <count>]
                      Benchmark the same candidate context across providers
  zdr benchmark-suite [query] --jsonl
                      Stream suite context, iterations, and summaries as JSONL
  zdr doctor         Print setup diagnostics as JSON
  zdr config-provider <provider> <model>
                      Set provider.name and provider.model in config
  zdr prune-events [--max-events <count>]
                      Keep only the newest local telemetry events
  zdr forget <query> Remove one exact direct-query correction
  zdr provider-smoke  Verify Pi provider/model lookup
  zdr provider-smoke --live
                      Make a tiny live provider completion
  zdr provider-list [provider]
                      List Pi providers, OAuth support, and provider models
  zdr provider-login <provider>
                      Log in to an OAuth provider
  zdr provider-logout <provider>
                      Remove stored OAuth credentials
  zdr provider-auth-status [provider]
                      Print OAuth provider auth status
  zdr --version       Print version
`);
}

if (import.meta.main) {
  const result = await main(Bun.argv.slice(2));
  process.exit(result.code);
}
