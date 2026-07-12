# Privacy

Zoxide Doctor sends only model-selection context to the configured provider — and, when an escalation tier is configured, the same redacted context to that backend. Shell navigation state, correction memory, and telemetry are stored locally.

On a correction-cache miss, provider context can include zoxide-ranked candidate paths and bounded local directory scan results from the configured context roots. The default context root is `~`; use `context.include_dirs` and `context.exclude_dirs` when you need to broaden or narrow the scan scope.

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

## Credentials

Subscription OAuth tokens from `zdr provider-login` are stored in `$XDG_CONFIG_HOME/zdr/auth.json` (fallback `~/.config/zdr/auth.json`) with file mode 0600. When the Pi CLI already has a matching login, zdr imports it read-only from `~/.pi/agent/auth.json` (override with `PI_CODING_AGENT_DIR`). zdr never writes the Pi file.

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
