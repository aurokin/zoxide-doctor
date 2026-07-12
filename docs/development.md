# Development

Install dependencies:

```bash
bun install
```

Run checks:

```bash
bun run verify
bun run smoke
bun run src/cli.ts doctor
bun run src/cli.ts provider-smoke
```

`bun run verify` runs the typecheck, `bun test`, and the executable build.

Build the standalone executable:

```bash
bun run build
./dist/zdr --version
```

Install a dev build into `~/.local/bin/zdr`:

```bash
bun run install:dev
```

The install script rebuilds `dist/zdr`, replaces an existing `~/.local/bin/zdr` file or symlink, verifies `zdr --version`, and warns when `~/.local/bin` is not on `PATH`.

The installed executable only prints the target path. The shell integration is what turns that path into `cd`, so source `zdr init <shell>` after zoxide init in any shell where you want navigation.

To test a local provider or context-scope change end to end, run `bun run install:dev`, open a fresh shell, and verify that `command -v zdr` resolves to `~/.local/bin/zdr`.

Run a live smoke test against the default OAuth provider:

```bash
bun run src/cli.ts provider-login openai-codex
bun run src/cli.ts config-provider openai-codex gpt-5.6-terra
bun run src/cli.ts provider-smoke --live
```

Env-key providers work the same way once config points at them:

```bash
bun run src/cli.ts config-provider openrouter google/gemini-2.5-flash-lite
OPENROUTER_API_KEY=... bun run src/cli.ts provider-smoke --live
```

## Evals

The offline eval suite is part of the quality gate. It replays the curated cases in `src/eval/` against the local recall path and makes no provider calls:

```bash
bun scripts/run-evals.ts
```

Live eval runs make real provider calls and are spend-gated behind `ZDR_EVAL_LIVE=1`:

```bash
ZDR_EVAL_LIVE=1 bun scripts/run-evals.ts --live --backend pi:openai-codex:gpt-5.6-terra
ZDR_EVAL_LIVE=1 bun scripts/run-evals.ts --live --backend claude:sonnet
```

`bun scripts/telemetry-to-cases.ts` mines opt-in local telemetry into case skeletons for curation into `src/eval/cases.ts`.

## Timing

Collect local executable timing:

```bash
bun run timing
bun run timing -- ascan
bun run timing -- --repeat 25 --budget-ms 150 ascan
```

`bun run timing` builds `dist/zdr`, runs `zdr debug-timing` repeatedly, and prints JSON with wall-clock p50/p95/max timings and budget failures against the 150ms default local budget. Wall-clock timing includes executable startup; `command_total_ms` is the in-process diagnostic total.

Use `zdr debug-provider-timing <query>` for one live provider selection trace. Use `zdr benchmark-provider <query> --repeat 5` to repeat the live provider selection against one candidate context and summarize selection latency, provider-complete latency when Pi reports it, token usage, cost, and selected-path consistency.

Provider benchmarks can override the configured provider for a single run:

```bash
zdr benchmark-provider ascan --repeat 5 --provider openai-codex --model gpt-5.6-terra
```

Use `benchmark-suite` to compare several providers against one candidate context:

```bash
zdr benchmark-suite ascan
zdr benchmark-suite ascan --repeat 3 \
  --provider openai-codex:gpt-5.6-terra \
  --provider openrouter:google/gemini-2.5-flash-lite
```

Add `--jsonl` to either benchmark command to stream context, per-iteration results, and summaries as line-delimited JSON while the benchmark is still running.

## Shell-State Smoke Test

```bash
tmp=$(mktemp -d)
XDG_STATE_HOME="$tmp" bun run src/cli.ts record-z --attempt smoke-1 --before /tmp/before --shell zsh -- ascan
XDG_STATE_HOME="$tmp" bun run src/cli.ts finish-z --attempt smoke-1 --after /tmp/after --status 0
XDG_STATE_HOME="$tmp" bun run src/cli.ts debug-state
```

## Candidate Smoke Test

This requires `zoxide` to be installed and populated.

```bash
tmp=$(mktemp -d)
XDG_STATE_HOME="$tmp" bun run src/cli.ts record-z --attempt smoke-1 --before "$PWD" --shell zsh -- ascan
XDG_STATE_HOME="$tmp" bun run src/cli.ts finish-z --attempt smoke-1 --after "$PWD" --status 0
XDG_STATE_HOME="$tmp" bun run src/cli.ts debug-candidates --limit 10
```

Run a live model selection against those candidates. This uses the configured provider; export the provider's API key first if it is env-key authenticated:

```bash
XDG_STATE_HOME="$tmp" bun run src/cli.ts debug-select --limit 10
```

Run no-arg recovery. stdout is path-only so the shell wrapper can `cd` safely:

```bash
XDG_STATE_HOME="$tmp" bun run src/cli.ts
```
