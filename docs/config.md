# Configuration

Zoxide Doctor works without a config file. Create one when you want to override provider, privacy, or telemetry defaults.

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
    "name": "openrouter",
    "model": "google/gemini-2.5-flash-lite"
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
zdr config-provider openrouter google/gemini-2.5-flash-lite
```

## Supported Knobs

- `provider.name`: Pi provider name. The default is `openrouter`.
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

The provider still receives only the bounded candidate list, not a full filesystem dump.

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

- The default provider is `openrouter`.
- The default model is `google/gemini-2.5-flash-lite`.
- `provider.name` must be a provider known to Pi (`@earendil-works/pi-ai`).
- `provider.model` must be one of Pi's known model IDs for that provider.
- `zdr provider-list` lists Pi providers, model counts, and OAuth support.
- `zdr provider-list <provider>` lists the known model IDs for one provider.
- `zdr provider-smoke` checks provider/model lookup without making a network call.
- `zdr provider-smoke --live` makes a tiny completion request and requires the provider's API key or OAuth login.

The default OpenRouter provider uses:

```bash
export OPENROUTER_API_KEY=...
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

OpenAI Codex via ChatGPT Pro or Plus can be configured with:

```bash
zdr provider-login openai-codex
zdr config-provider openai-codex gpt-5.3-codex-spark
```

Equivalent JSON:

```json
{
  "schema_version": 1,
  "provider": {
    "name": "openai-codex",
    "model": "gpt-5.3-codex-spark"
  }
}
```

For `openai-codex`, ZDR passes Pi's Codex Responses options, omits unsupported `temperature`, and uses minimal reasoning for first-attempt selection unless a retry asks for stronger reasoning.
