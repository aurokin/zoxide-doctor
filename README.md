# Zoxide Doctor

Zoxide Doctor (`zdr`) is a small LLM-powered doctor for bad [zoxide](https://github.com/ajeetdsouza/zoxide) jumps.

The intended workflow is:

1. Run `z <query>` as usual.
2. If zoxide lands in the wrong directory, run `zdr`.
3. If the repair is wrong, run `zdr` again to escalate.
4. If the second repair is wrong, run `zdr` again to open the picker fallback.

Direct lookup with `zdr <query>` is available as an experimental shortcut, but the primary product is no-arg `zdr` after a bad `z` jump.

## Current Status

This repository is in early implementation.

Implemented:

- Bun TypeScript CLI scaffold.
- Pi provider SDK dependency (`@earendil-works/pi-ai`).
- OpenRouter/Pi smoke command.
- zsh init script generation.
- Shell-state capture commands:
  - `zdr record-z`
  - `zdr finish-z`
  - `zdr debug-state`
- zoxide DB loading and local candidate scoring with `zdr debug-candidates`.
- model-backed candidate selection with `zdr debug-select`.
- no-arg recovery mode that prints the selected path to stdout.
- repeated no-arg recovery that excludes prior bad `zdr` suggestions.
- third-attempt picker fallback over zoxide candidates plus optional `fd` scan results.
- direct lookup with `zdr <query>`.
- local correction cache for direct-query hits at `$XDG_CACHE_HOME/zdr/corrections.json`.
- manual correction-cache commands:
  - `zdr debug-corrections`
  - `zdr forget <query>`

Not implemented yet:

- shell support beyond zsh.

## Install

Prerequisites:

- [Bun](https://bun.sh/)
- [zoxide](https://github.com/ajeetdsouza/zoxide)
- zsh
- `OPENROUTER_API_KEY` for model-backed recovery and direct-query cache misses

Build the standalone executable:

```bash
bun install
bun run build
```

Put `dist/zdr` somewhere on `PATH`. For local development, one simple option is:

```bash
mkdir -p ~/.local/bin
ln -sf "$PWD/dist/zdr" ~/.local/bin/zdr
```

Verify:

```bash
zdr --version
zdr provider-smoke
```

## Shell Setup

Initialize zoxide first, then source Zoxide Doctor's zsh integration:

```zsh
eval "$(zoxide init zsh)"
eval "$(zdr init zsh)"
```

The generated integration wraps `z` to record the last zoxide attempt and defines a `zdr` shell function that changes directory when the executable prints a path.

## Usage

Primary recovery flow:

```bash
z ascan
# zoxide lands in the wrong directory
zdr
```

If the first repair is also wrong, run `zdr` again. The second no-arg recovery excludes the previous `zdr` suggestion.

If the second repair is wrong too, run `zdr` a third time. The third recovery opens an `fzf` picker seeded with the original query, zoxide-ranked candidates, and optional `fd` scan results from the current recovery context.

Experimental direct lookup:

```bash
zdr ascan
```

`zdr <query>` checks the local correction cache first. On a cache miss or stale path, it falls back to zoxide candidates plus model selection. High-confidence model selections are stored for future exact-query cache hits.

Correction-cache commands:

```bash
zdr debug-corrections
zdr forget ascan
```

Local timing diagnostics:

```bash
zdr debug-timing
zdr debug-timing ascan
zdr debug-timing ascan --budget-ms 150
```

`debug-timing` prints JSON for local paths such as version metadata, correction-cache reads, exact-query cache lookup when a query is supplied, and no-arg recovery context gathering before any provider call. `--budget-ms` adds budget metadata to the JSON without changing the command's exit status.

Local telemetry:

```text
~/.local/state/zdr/events.jsonl
```

Telemetry is local-only. Direct-query mode records JSONL events for cache hits, model selections, no-selections, and errors. Set `ZDR_TELEMETRY=0` to disable event writes.

## Limits

- zsh is the only supported shell integration right now.
- Third-attempt picker fallback requires `fzf`; `fd` is optional and adds bounded local directory scan results when available.
- Provider-backed paths require `OPENROUTER_API_KEY`.
- Correction memory is separate from zoxide and does not change zoxide frecency scores.

## Development

Install dependencies:

```bash
bun install
```

Run checks:

```bash
bun run verify
bun run smoke
bun run src/cli.ts provider-smoke
```

Collect local executable timing:

```bash
bun run timing
bun run timing -- ascan
bun run timing -- --repeat 25 --budget-ms 150 ascan
```

`bun run timing` builds `dist/zdr`, runs `zdr debug-timing` repeatedly, and prints JSON with wall-clock p50/p95/max timings. Wall-clock timing includes executable startup; `command_total_ms` is the in-process diagnostic total.

Build the standalone executable:

```bash
bun run build
./dist/zdr --version
```

Run a live provider smoke test:

```bash
OPENROUTER_API_KEY=... bun run src/cli.ts provider-smoke --live
```

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

## Cache Location

Default correction-cache path:

```text
~/.cache/zdr/corrections.json
```
