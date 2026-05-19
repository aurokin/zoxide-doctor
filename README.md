# Zoxide Doctor

Zoxide Doctor (`zdr`) is a small LLM-powered doctor for bad [zoxide](https://github.com/ajeetdsouza/zoxide) jumps.

The intended workflow is:

1. Run `z <query>` as usual.
2. If zoxide lands in the wrong directory, run `zdr`.
3. If the repair is wrong, run `zdr` again to escalate.

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
- direct lookup with `zdr <query>`.
- local correction cache for direct-query hits at `$XDG_CACHE_HOME/zdr/corrections.json`.

Not implemented yet:

- third-attempt picker fallback.
- manual correction-cache management commands.

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

## Direct Query Cache

`zdr <query>` first checks the local correction cache. If an exact query is cached and the path still exists, stdout is path-only and no provider call is made:

```bash
zdr ascan
```

On a cache miss or stale path, `zdr <query>` falls back to zoxide candidates plus model selection. High-confidence model selections are stored for future exact-query cache hits. The cache is separate from zoxide's database and does not boost frecency scores.

Default cache path:

```text
~/.cache/zdr/corrections.json
```
