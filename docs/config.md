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

Inspect the merged config:

```bash
zdr debug-config
```

`debug-config` reports whether values came from defaults or a file.

## Supported Knobs

- `provider.name`: Pi provider name. The default is `openrouter`.
- `provider.model`: Pi model ID for the configured provider.
- `privacy.redact_home`: redact the home directory to `~` in provider prompts.
- `privacy.redact_emails`: redact email addresses in provider prompts.
- `privacy.redact_secrets`: redact common secret-prefixed values in provider prompts.
- `privacy.redact_tokens`: redact long token-like strings in provider prompts.
- `telemetry.enabled`: enable local JSONL telemetry. Default is `false`.
- `telemetry.max_events`: default retention for `zdr prune-events`; must be an integer from `0` through `100000`.

The v1 config is strict: unsupported keys at the top level or inside `provider`, `privacy`, or `telemetry` fail config loading instead of being ignored. This keeps misspelled settings from looking active.

## Provider and Model

Provider-backed selection, `provider-smoke`, and provider timing diagnostics use `provider.name` and `provider.model`.

- The default provider is `openrouter`.
- The default model is `deepseek/deepseek-v4-flash`.
- `provider.name` must be a provider known to Pi (`@earendil-works/pi-ai`).
- `provider.model` must be one of Pi's known model IDs for that provider.
- `zdr provider-smoke` checks provider/model lookup without making a network call.
- `zdr provider-smoke --live` makes a tiny completion request and requires the provider's API key.

The default OpenRouter provider uses:

```bash
export OPENROUTER_API_KEY=...
```
