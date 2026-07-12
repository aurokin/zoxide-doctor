<p align="center">
  <img src="assets/logo.png" alt="Zoxide Doctor" width="220" />
</p>

# Zoxide Doctor

Zoxide Doctor (`zdr`) is a small LLM-powered doctor for bad [zoxide](https://github.com/ajeetdsouza/zoxide) jumps.

The intended workflow is:

1. Run `z <query>` as usual.
2. If zoxide lands in the wrong directory, run `zdr`.
3. If the repair is wrong, run `zdr` again to escalate.
4. If the second repair is wrong, run `zdr` again to open the picker fallback.

Direct lookup with `zdr <query>` is available as an experimental shortcut, but the primary product is no-arg `zdr` after a bad `z` jump.

## Install

Prerequisites:

- [zoxide](https://github.com/ajeetdsouza/zoxide)
- zsh, bash, or fish
- A ChatGPT Plus/Pro login for the default provider (`zdr provider-login openai-codex`), or an API key such as `OPENROUTER_API_KEY` for an env-key provider

Install the latest release into `~/.local/bin`:

```bash
curl -fsSL https://raw.githubusercontent.com/aurokin/zoxide-doctor/main/scripts/install.sh | sh
```

Install a specific release or directory:

```bash
curl -fsSL https://raw.githubusercontent.com/aurokin/zoxide-doctor/main/scripts/install.sh | sh -s -- --version 0.2.0 --dir "$HOME/bin"
```

A Homebrew tap is planned but not available yet.

Or build from source (requires [Bun](https://bun.sh/)):

```bash
bun install
bun run build        # standalone executable in dist/
bun run install:dev  # install a dev build into ~/.local/bin
```

The executable alone only prints the target path. The shell integration is what turns that path into `cd`, so source `zdr init <shell>` after zoxide init.

Log in to the default provider. Zoxide Doctor ships with `openai-codex` / `gpt-5.6-terra` (minimal reasoning effort), which uses a ChatGPT Plus/Pro subscription login rather than an API key:

```bash
zdr provider-login openai-codex
```

The default already targets `gpt-5.6-terra`; use `zdr config-provider openai-codex <model>` to pin a different Codex model.

Alternative: an env-key provider such as OpenRouter:

```bash
export OPENROUTER_API_KEY=...
zdr config-provider openrouter google/gemini-2.5-flash-lite
```

`config-provider` writes `provider.name` and `provider.model` in `~/.config/zdr/config.json`.
Use `zdr provider-list` to list Pi providers and OAuth support. Use `zdr provider-list <provider>` to print that provider's known model IDs.

Recommended: point the escalation tier (second `zdr` attempt) at your Claude Pro/Max subscription (see [Subscriptions](#subscriptions)):

```bash
zdr config-escalation claude sonnet
```

Verify local setup:

```bash
zdr --version
zdr doctor
zdr provider-discover
zdr provider-smoke
```

See [Configuration](docs/config.md) for provider, privacy, and context tuning. See [Provider recommendations](docs/provider-recommendations.md) for dated benchmark notes before changing provider/model defaults.

## Subscriptions

Run recovery on subscriptions you already pay for instead of API keys.

- **Claude escalation tier.** Repairs escalate to "thinking harder" on the second attempt. Point that tier at your Claude Pro/Max subscription through the local `claude` login (never an API key):

  ```bash
  zdr config-escalation claude sonnet
  ```

  This uses the Claude Agent SDK against the `claude` executable on your PATH. It runs only on the escalation tier because subscription calls are slower than the fast first-attempt path. Install Claude Code and run `claude` once to log in. Remove the tier with `zdr config-escalation --clear`.

- **Pi shared auth import.** If you already logged in to an OAuth provider (such as `openai-codex`) with the Pi CLI, ZDR imports that credential read-only from `~/.pi/agent/auth.json` on first use, copies it into its own store, and refreshes it normally. It never writes to the Pi CLI's file. Override the Pi directory with `PI_CODING_AGENT_DIR`.

- **Discover what's available.** `zdr provider-discover` reports, read-only and without model spend, which fast and escalation tiers are satisfied by your current logins and environment:

  ```bash
  zdr provider-discover
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

First no-arg recovery runs the fast tier: the configured provider at minimal reasoning effort (models without reasoning controls ignore it). If the first repair is wrong, run `zdr` again. The second recovery excludes the previous `zdr` suggestion and runs the escalation tier if one is configured (`zdr config-escalation claude sonnet`); otherwise it reuses the fast provider with high reasoning effort.

If the second repair is wrong too, run `zdr` a third time. The third recovery opens an `fzf` picker seeded with the original query, zoxide-ranked candidates, and optional `fd` scan results from the configured context roots.

Recovery reuses the correction cache as alias memory. Once you resolve a query — by picking in the `fzf` picker or accepting a high-confidence repair — the target is remembered and injected as the top candidate on later recoveries of the same query, even when it has no lexical overlap and is absent from zoxide. A remembered target you reject during recovery is forgotten so it stops resurfacing.

Experimental direct lookup:

```bash
zdr ascan
```

`zdr <query>` checks the local correction cache first. On a cache miss or stale path, it falls back to zoxide candidates, bounded local directory scan results from the configured context roots, and model selection. High-confidence model selections are stored for future exact-query cache hits.

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
