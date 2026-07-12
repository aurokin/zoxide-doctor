# Troubleshooting

## Verify Setup

```bash
zdr --version
zdr doctor
zdr provider-discover
zdr provider-smoke
zdr debug-config
```

`zdr doctor` is a local JSON setup report. It checks config loading, provider/model lookup, provider auth readiness, `zoxide`, optional picker tools, and the paths ZDR uses for config, auth, state, cache, and telemetry.

`zdr provider-discover` is the first diagnostic for auth problems. It makes no model calls and reports whether each backend is ready: `claude` on PATH and logged in, an `openai-codex` login in ZDR's store, the Pi shared store, or `~/.codex/auth.json`, and which env keys are set. It ends with a fast/escalation tier summary.

Run a live provider check:

```bash
zdr provider-smoke --live
```

The default `openai-codex` provider uses a ChatGPT Plus/Pro login, not an API key:

```bash
zdr provider-login openai-codex
zdr provider-auth-status
```

Env-key providers need their key exported first:

```bash
export OPENROUTER_API_KEY=...
```

`provider-smoke --live` reports when an OAuth provider is configured but credentials are missing.

## Check Recorded Shell State

```bash
zdr debug-state
```

If no recorded `z` attempt exists, confirm that shell setup sourced both zoxide and Zoxide Doctor:

```zsh
eval "$(zoxide init zsh)"
eval "$(zdr init zsh)"
```

For bash:

```bash
eval "$(zoxide init bash)"
eval "$(zdr init bash)"
```

For fish:

```fish
zoxide init fish | source
zdr init fish | source
```

## Inspect Candidates

This requires `zoxide` to be installed and populated:

```bash
zdr debug-candidates --limit 10
```

Run a live model selection against those candidates (needs provider auth, see above):

```bash
zdr debug-select --limit 10
```

## Provider Errors

Failed selections surface the provider response in the `zdr:` error message:

- `provider returned an error: ...` — the provider rejected the request. The message is a redacted, length-capped preview of the upstream error.
- `response was truncated before completing JSON (hit max tokens)` — the model spent its output budget (usually on hidden reasoning) before emitting the JSON answer. Retry; if it persists on a custom model, pick a different one.

## Claude Escalation

The escalation tier with `"backend": "claude"` needs Claude Code installed and logged in:

- `claude executable not found on PATH` — install Claude Code.
- `claude selection failed: ...` — run `claude` once and log in. ZDR strips `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the SDK call, so an exported API key does not substitute for the subscription login.

`zdr provider-discover` shows Claude readiness without spending tokens.

## Correction Cache

Default correction-cache path:

```text
~/.cache/zdr/corrections.json
```

Commands:

```bash
zdr debug-corrections
zdr forget ascan
```

Correction memory is separate from zoxide and does not change zoxide frecency scores.

Recovery alias memory shares this cache: picker selections and high-confidence repairs are remembered and injected as the top candidate on later recoveries of the same query. Rejecting a remembered target evicts it. Cache read/write failures are warnings only and never block navigation.

## Picker Fallback

Third-attempt picker fallback requires `fzf`. `fd` is optional and adds bounded local directory scan results when available.

Picker `fd` scans use the configured context roots from `context.default_dir`, `context.include_dirs`, and `context.exclude_dirs`. Scans are depth-limited and result-limited before results are sent to `fzf`; zoxide-ranked paths stay first.

If picker fallback or direct lookup feels slow, narrow the context scope in `~/.config/zdr/config.json`. Common exclusions include noisy or low-value trees such as `~/Library`, `~/.cache`, dependency caches, and private project directories that should not be scanned.
