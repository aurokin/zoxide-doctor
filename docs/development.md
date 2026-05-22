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

Run a live provider smoke test:

```bash
OPENROUTER_API_KEY=... bun run src/cli.ts provider-smoke --live
```

Run a live OAuth provider smoke test:

```bash
bun run src/cli.ts provider-login openai-codex
bun run src/cli.ts config-provider openai-codex gpt-5.3-codex-spark
bun run src/cli.ts provider-smoke --live
```

## Timing

Collect local executable timing:

```bash
bun run timing
bun run timing -- ascan
bun run timing -- --repeat 25 --budget-ms 150 ascan
```

`bun run timing` builds `dist/zdr`, runs `zdr debug-timing` repeatedly, and prints JSON with wall-clock p50/p95/max timings. Wall-clock timing includes executable startup; `command_total_ms` is the in-process diagnostic total.

Use `zdr debug-provider-timing <query>` for one live provider selection trace. Use `zdr benchmark-provider <query> --repeat 5` to repeat the live provider selection against one candidate context and summarize selection latency, provider-complete latency when Pi reports it, token usage, cost, and selected-path consistency.

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

Run a live model selection against those candidates:

```bash
OPENROUTER_API_KEY=... XDG_STATE_HOME="$tmp" bun run src/cli.ts debug-select --limit 10
```

Run no-arg recovery. stdout is path-only so the shell wrapper can `cd` safely:

```bash
OPENROUTER_API_KEY=... XDG_STATE_HOME="$tmp" bun run src/cli.ts
```
