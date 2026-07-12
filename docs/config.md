# Configuration

Zoxide Doctor works without a config file. Create one when you want to override provider, privacy, context, or telemetry defaults.

Config path:

```text
~/.config/zdr/config.json
```

When `XDG_CONFIG_HOME` is set, the path is:

```text
$XDG_CONFIG_HOME/zdr/config.json
```

## Example

```bash
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/zdr"
mkdir -p "$config_dir"
cat > "$config_dir/config.json" <<'JSON'
{
  "schema_version": 1,
  "provider": {
    "name": "openai-codex",
    "model": "gpt-5.6-terra"
  },
  "privacy": {
    "redact_home": true,
    "redact_emails": true,
    "redact_secrets": true,
    "redact_tokens": true
  },
  "context": {
    "default_dir": "~",
    "include_dirs": [],
    "exclude_dirs": []
  },
  "telemetry": {
    "enabled": false,
    "max_events": 1000
  }
}
JSON
```

Inspect the merged config:

```bash
zdr debug-config
zdr doctor
```

`debug-config` reports whether values came from defaults or a file. `doctor` reports the same path plus provider/model and auth readiness.

Set only the provider/model pair:

```bash
zdr config-provider openai-codex gpt-5.6-terra
```

## Supported Knobs

- `provider.name`: Pi provider name. The default is `openai-codex`.
- `provider.model`: Pi model ID for the configured provider.
- `privacy.redact_home`: redact the home directory to `~` in provider prompts.
- `privacy.redact_emails`: redact email addresses in provider prompts.
- `privacy.redact_secrets`: redact common secret-prefixed values in provider prompts.
- `privacy.redact_tokens`: redact long token-like strings in provider prompts.
- `context.default_dir`: default local scan root. The default is `~`.
- `context.include_dirs`: extra local scan roots to include after `context.default_dir`.
- `context.exclude_dirs`: local scan roots to exclude after default and include roots are applied.
- `telemetry.enabled`: enable local JSONL telemetry. Default is `false`.
- `telemetry.max_events`: default retention for `zdr prune-events`; must be an integer from `0` through `100000`.

The v1 config is strict: unsupported keys at the top level or inside `provider`, `privacy`, `context`, or `telemetry` fail config loading instead of being ignored. This keeps misspelled settings from looking active.

## Candidate Context

On a correction-cache miss, ZDR builds provider candidates from zoxide entries plus bounded `fd` directory scan results when `fd` is available. The scan scope is applied in this order:

1. Start from `context.default_dir`.
2. Add every path in `context.include_dirs`.
3. Remove every path under `context.exclude_dirs`.

The provider still receives only the bounded candidate list, not a full filesystem dump. Local scan results are bounded per scan root before ZDR applies the final global cap, so explicit `include_dirs` still get represented when `context.default_dir` is broad.

Example:

```json
{
  "schema_version": 1,
  "context": {
    "default_dir": "~",
    "include_dirs": ["/Volumes/work"],
    "exclude_dirs": ["~/Library", "~/.cache", "~/code/private"]
  }
}
```

Paths may be absolute or use `~`. Relative paths are resolved from the current working directory.

## Provider and Model

Provider-backed selection, `provider-smoke`, and provider timing diagnostics use `provider.name` and `provider.model`.

- The default provider is `openai-codex` (ChatGPT Plus/Pro via `zdr provider-login openai-codex`).
- The default model is `gpt-5.6-terra`, sent at low reasoning effort on the fast path.
- `provider.name` must be a provider known to Pi (`@earendil-works/pi-ai`).
- `provider.model` must be one of Pi's known model IDs for that provider.
- `zdr provider-list` lists Pi providers, model counts, and OAuth support.
- `zdr provider-list <provider>` lists the known model IDs for one provider.
- `zdr provider-smoke` checks provider/model lookup without making a network call.
- `zdr provider-smoke --live` makes a tiny completion request and requires the provider's API key or OAuth login.

The default `openai-codex` provider uses a ChatGPT Plus/Pro login (`zdr provider-login openai-codex`) rather than an API key. Env-key providers such as OpenRouter are the alternative:

```bash
export OPENROUTER_API_KEY=...
zdr config-provider openrouter google/gemini-2.5-flash-lite
```

## OAuth Providers

ZDR stores OAuth credentials in:

```text
~/.config/zdr/auth.json
```

The auth file is written with mode `0600`. Tokens are never printed by status commands.

Log in to an OAuth provider:

```bash
zdr provider-login openai-codex
zdr provider-auth-status
```

Log out:

```bash
zdr provider-logout openai-codex
```

OpenAI Codex via ChatGPT Pro or Plus is the default provider and can be configured with:

```bash
zdr provider-login openai-codex
zdr config-provider openai-codex gpt-5.6-terra
```

Equivalent JSON:

```json
{
  "schema_version": 1,
  "provider": {
    "name": "openai-codex",
    "model": "gpt-5.6-terra"
  }
}
```

For `openai-codex`, ZDR passes Pi's Codex Responses options, omits unsupported `temperature`, and requests minimal reasoning for first-attempt selection unless a retry asks for stronger reasoning. For gpt-5.6 models (terra/luna/sol), Pi's catalog maps `minimal` to server reasoning effort `low`, so the fast path runs terra at low effort.

## Escalation Tier

Recovery has three attempts: a fast first attempt (minimal reasoning), a "thinking harder" second attempt (high reasoning), and an `fzf` picker on the third. The optional top-level `escalation` block routes the second attempt to a different backend so you can spend a slower, stronger model only when the first repair was rejected.

When `escalation` is absent, the second attempt keeps today's behavior: the same provider as the fast tier with high reasoning.

Set it with a command:

```bash
# Escalate to your Claude subscription (via the local `claude` login):
zdr config-escalation claude sonnet

# Escalate to a specific Pi provider/model:
zdr config-escalation pi gpt-5.3-codex-spark --provider openai-codex

# Remove the escalation block:
zdr config-escalation --clear
```

Equivalent JSON:

```jsonc
{
  "escalation": { "backend": "claude", "model": "sonnet" }
  // or: { "backend": "pi", "name": "openai-codex", "model": "gpt-5.3-codex-spark" }
}
```

Rules:

- `backend` is optional and defaults to `pi`; it must be `pi` or `claude`.
- `model` is required and non-empty. For `claude` it is a model alias or id (`haiku`, `sonnet`, ...); for `pi` it is a Pi model id.
- `name` is the Pi provider name. It is required when `backend` is `pi` (defaulting to the fast-tier `provider.name`) and is rejected when `backend` is `claude`.

### Claude Subscription Backend

`backend: "claude"` calls the Claude Agent SDK against the `claude` executable on your PATH, using your Claude Pro/Max subscription login rather than an API key. ZDR strips `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the environment it hands the SDK so the call always uses the local subscription login. Because subscription calls are slower, Claude is only ever an escalation-tier backend, never the fast first attempt. Install Claude Code and run `claude` once to log in.

## Discovering Backends

`zdr provider-discover` is a read-only report (no model spend) of which fast and escalation tiers are satisfied on this machine:

- **claude** (escalation tier): whether `claude` is on PATH and logged in.
- **codex** (`openai-codex`, fast + escalation): whether a login exists in ZDR's store, the Pi shared store, or `~/.codex/auth.json`.
- **pi shared store**: providers present in `~/.pi/agent/auth.json` (names only, never token material).
- **env-key providers**: which environment variable the fast-tier provider (and `openrouter`) would use, and whether it is set.

## Pi Shared Auth Import

When ZDR's own store (`~/.config/zdr/auth.json`) has no credential for an OAuth provider, it attempts a read-only import from the Pi CLI store at `~/.pi/agent/auth.json`, validates the shape, copies it into ZDR's store, and then refreshes it through the normal OAuth path. ZDR never writes to the Pi CLI's file. Set `PI_CODING_AGENT_DIR` to override the Pi agent directory.
