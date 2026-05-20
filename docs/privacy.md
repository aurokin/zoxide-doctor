# Privacy

Zoxide Doctor sends only model-selection context to the configured provider. Shell navigation state, correction memory, and telemetry are stored locally.

## Provider Prompts

Before provider calls, prompt construction applies the configured privacy redaction settings:

- Home paths are redacted to `~` by default.
- Email addresses are redacted by default.
- Common secret-prefixed values are redacted by default.
- Long token-like strings are redacted by default.

These settings live in the v1 config:

```json
{
  "privacy": {
    "redact_home": true,
    "redact_emails": true,
    "redact_secrets": true,
    "redact_tokens": true
  }
}
```

See [Configuration](config.md) for the full config shape.

## Local State

Privacy settings only affect provider prompts. Local state and correction-cache files may still contain raw queries and real paths because shell navigation and cache hits need them.

Common local paths:

```text
$XDG_STATE_HOME/zdr/
$XDG_CACHE_HOME/zdr/
```

Fallbacks:

```text
~/.local/state/zdr/
~/.cache/zdr/
```

Local telemetry is disabled by default. If enabled, telemetry records may contain raw queries and real paths.
