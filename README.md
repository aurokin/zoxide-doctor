# Zoxide Doctor

Zoxide Doctor (`zdr`) is a small LLM-powered doctor for bad [zoxide](https://github.com/ajeetdsouza/zoxide) jumps.

The intended workflow is:

1. Run `z <query>` as usual.
2. If zoxide lands in the wrong directory, run `zdr`.
3. If the repair is wrong, run `zdr` again to escalate.
4. If the second repair is wrong, run `zdr` again to open the picker fallback.

Direct lookup with `zdr <query>` is available as an experimental shortcut, but the primary product is no-arg `zdr` after a bad `z` jump.

## Current Status

This repository is in pre-release implementation.

Implemented:

- Bun TypeScript CLI scaffold.
- Pi provider SDK dependency (`@earendil-works/pi-ai`).
- OpenRouter/Pi smoke command.
- zsh, bash, and fish init script generation.
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

- install channels such as Homebrew or a curl-based installer.

## Install

Prerequisites:

- [Bun](https://bun.sh/)
- [zoxide](https://github.com/ajeetdsouza/zoxide)
- zsh, bash, or fish
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

Create a config file when you want to override defaults:

```bash
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/zdr"
mkdir -p "$config_dir"
cat > "$config_dir/config.json" <<'JSON'
{
  "schema_version": 1,
  "provider": {
    "name": "openrouter",
    "model": "deepseek/deepseek-v4-flash"
  },
  "privacy": {
    "redact_home": true,
    "redact_emails": true,
    "redact_secrets": true,
    "redact_tokens": true
  },
  "telemetry": {
    "enabled": false,
    "max_events": 1000
  }
}
JSON
```

Set the provider API key. The default OpenRouter provider uses `OPENROUTER_API_KEY`:

```bash
export OPENROUTER_API_KEY=...
```

Verify local setup:

```bash
zdr --version
zdr provider-smoke
zdr debug-config
```

Release archives are built by GitHub Actions when a `vX.Y.Z` tag matching `package.json` is pushed. Each release includes Bun-compiled `zdr` archives for macOS arm64, macOS x64, Linux arm64, and Linux x64 baseline, plus `SHA256SUMS`.

Verify a live provider call:

```bash
zdr provider-smoke --live
```

## Shell Setup

Initialize zoxide first, then source Zoxide Doctor's shell integration.

zsh:

```zsh
eval "$(zoxide init zsh)"
eval "$(zdr init zsh)"
```

bash:

```bash
eval "$(zoxide init bash)"
eval "$(zdr init bash)"
```

fish:

```fish
zoxide init fish | source
zdr init fish | source
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

Config file:

```text
~/.config/zdr/config.json
```

Current v1 config shape:

```json
{
  "schema_version": 1,
  "provider": {
    "name": "openrouter",
    "model": "deepseek/deepseek-v4-flash"
  },
  "privacy": {
    "redact_home": true,
    "redact_emails": true,
    "redact_secrets": true,
    "redact_tokens": true
  },
  "telemetry": {
    "enabled": false,
    "max_events": 1000
  }
}
```

`zdr debug-config` prints the merged config and reports whether values came from defaults or a file. Provider-backed selection, `provider-smoke`, and provider timing diagnostics use `provider.name` and `provider.model`. Prompt construction uses the privacy redaction settings before sending context to the provider. Telemetry event writes honor `telemetry.enabled`, and `zdr prune-events` uses `telemetry.max_events` when no explicit limit is supplied.

Provider/model notes:

- The default provider is `openrouter` and the default model is `deepseek/deepseek-v4-flash`.
- `provider.name` must be a provider known to Pi (`@earendil-works/pi-ai`).
- `provider.model` must be one of Pi's known model IDs for that provider.
- `zdr provider-smoke` checks provider/model lookup without making a network call.
- `zdr provider-smoke --live` makes a tiny completion request and requires the provider's API key.

Privacy notes:

- Home paths are redacted to `~` by default before provider calls.
- Email addresses, common secret prefixes, and long token-like strings are redacted by default.
- Privacy settings only affect provider prompts. Local state and correction-cache files may still contain raw queries and real paths because shell navigation and cache hits need them. Local telemetry is disabled by default; if enabled, telemetry records may contain raw queries and real paths.

Telemetry notes:

- Telemetry is opt-in and written only to local JSONL under `$XDG_STATE_HOME/zdr/events.jsonl`, or `~/.local/state/zdr/events.jsonl` when `XDG_STATE_HOME` is unset.
- Set `"telemetry": { "enabled": true }` in config or `ZDR_TELEMETRY=1` in the environment to enable event writes. `ZDR_TELEMETRY=0` disables event writes.
- Use `zdr prune-events` to keep the newest `telemetry.max_events` records, or pass `--max-events` explicitly.

Local timing diagnostics:

```bash
zdr debug-timing
zdr debug-timing ascan
zdr debug-timing ascan --budget-ms 150
zdr debug-provider-timing ascan
```

`debug-timing` prints JSON for local paths such as version metadata, correction-cache reads, exact-query cache lookup when a query is supplied, and no-arg recovery context gathering before any provider call. `--budget-ms` adds budget metadata to the JSON without changing the command's exit status.
`debug-provider-timing` is an opt-in live provider diagnostic. It separates local candidate setup from the provider selection call and includes provider usage fields when Pi returns them.

Local telemetry:

```text
$XDG_STATE_HOME/zdr/events.jsonl
# fallback: ~/.local/state/zdr/events.jsonl
```

Telemetry is local-only and opt-in. When enabled, direct-query and no-arg recovery modes record JSONL events for cache hits, model selections, picker outcomes, no-selections, and errors. Provider-backed model events include Pi usage data plus flattened token, prompt-cache, and cost fields when Pi exposes them.

Inspect local telemetry:

```bash
zdr debug-events
zdr debug-events --limit 20
zdr prune-events
zdr prune-events --max-events 1000
```

`debug-events` prints the local JSONL telemetry log as a JSON array. It skips malformed JSONL records instead of failing the whole read.
`prune-events` rewrites the local log to keep only the newest valid events and reports how many valid and invalid records were removed.

## Limits

- zsh, bash, and fish are supported.
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

`bun run timing` builds `dist/zdr`, runs `zdr debug-timing` repeatedly, and prints JSON with wall-clock p50/p95/max timings. Wall-clock timing includes executable startup; `command_total_ms` is the in-process diagnostic total. Use `zdr debug-provider-timing <query>` separately for live provider latency.

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
