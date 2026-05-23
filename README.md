# Zoxide Doctor

Zoxide Doctor (`zdr`) is a small LLM-powered doctor for bad [zoxide](https://github.com/ajeetdsouza/zoxide) jumps.

The intended workflow is:

1. Run `z <query>` as usual.
2. If zoxide lands in the wrong directory, run `zdr`.
3. If the repair is wrong, run `zdr` again to escalate.
4. If the second repair is wrong, run `zdr` again to open the picker fallback.

Direct lookup with `zdr <query>` is available as an experimental shortcut, but the primary product is no-arg `zdr` after a bad `z` jump.

## Status

This repository is in pre-release implementation.

Implemented:

- zsh, bash, and fish shell integration.
- no-arg recovery for the last bad `z` jump.
- repeated no-arg recovery that excludes prior bad `zdr` suggestions.
- third-attempt `fzf` picker fallback over zoxide candidates plus optional `fd` scan results.
- direct lookup with `zdr <query>`.
- local correction cache for direct-query hits.
- local opt-in telemetry and provider usage accounting.
- OAuth login for Pi OAuth providers such as `openai-codex`.
- strict v1 config with provider, privacy, and telemetry settings.

Not implemented yet:

- install channels such as Homebrew or a curl-based installer.

## Install

Prerequisites:

- [Bun](https://bun.sh/)
- [zoxide](https://github.com/ajeetdsouza/zoxide)
- zsh, bash, or fish
- `OPENROUTER_API_KEY` for the default model-backed recovery path, or OAuth login for an OAuth provider

Build the standalone executable:

```bash
bun install
bun run build
```

Install a dev build into `~/.local/bin`:

```bash
bun run install:dev
```

The executable alone only prints the target path. The shell integration is what turns that path into `cd`, so source `zdr init <shell>` after zoxide init.

Set the provider API key. The default OpenRouter provider uses `OPENROUTER_API_KEY`:

```bash
export OPENROUTER_API_KEY=...
```

Optional ChatGPT Pro/Codex Spark path:

```bash
zdr provider-login openai-codex
zdr config-provider openai-codex gpt-5.3-codex-spark
```

This writes `provider.name` and `provider.model` in `~/.config/zdr/config.json`.

Verify local setup:

```bash
zdr --version
zdr doctor
zdr provider-smoke
zdr benchmark-provider ascan --repeat 5
zdr benchmark-provider ascan --repeat 5 --provider openai-codex --model gpt-5.3-codex-spark
zdr benchmark-suite ascan
zdr benchmark-suite ascan --jsonl
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

First no-arg recovery requests minimal reasoning effort through Pi when the configured model/provider supports reasoning controls. If the first repair is also wrong, run `zdr` again. The second no-arg recovery excludes the previous `zdr` suggestion and requests high reasoning effort. Unsupported models ignore those options through Pi.

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

## Limits

- zsh, bash, and fish are supported.
- Third-attempt picker fallback requires `fzf`; `fd` is optional and adds bounded local directory scan results when available.
- Provider-backed paths require either the provider's API key environment variable or `zdr provider-login` for OAuth providers.
- Correction memory is separate from zoxide and does not change zoxide frecency scores.

## More Documentation

- [Docs index](docs/README.md)
- [Configuration](docs/config.md)
- [Privacy](docs/privacy.md)
- [Telemetry and diagnostics](docs/telemetry.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Development](docs/development.md)
- [Release process](docs/release.md)

Project planning docs:

- [Spec](SPEC.md)
- [Roadmap](ROADMAP.md)
- [Changelog](CHANGELOG.md)
