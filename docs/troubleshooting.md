# Troubleshooting

## Verify Setup

```bash
zdr --version
zdr doctor
zdr provider-smoke
zdr debug-config
```

`zdr doctor` is a local JSON setup report. It checks config loading, provider/model lookup, provider auth readiness, `zoxide`, optional picker tools, and the paths ZDR uses for config, auth, state, cache, and telemetry.

Run a live provider check:

```bash
zdr provider-smoke --live
```

For the default OpenRouter provider, live provider calls require:

```bash
export OPENROUTER_API_KEY=...
```

For OAuth providers, check auth status:

```bash
zdr provider-auth-status
zdr provider-login openai-codex
zdr config-provider openai-codex gpt-5.3-codex-spark
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

Run a live model selection against those candidates:

```bash
OPENROUTER_API_KEY=... zdr debug-select --limit 10
```

For an OAuth provider, omit the env var after login:

```bash
zdr debug-select --limit 10
```

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

## Picker Fallback

Third-attempt picker fallback requires `fzf`. `fd` is optional and adds bounded local directory scan results when available.

Picker `fd` scans are depth-limited and result-limited before results are sent to `fzf`; zoxide-ranked paths stay first.
