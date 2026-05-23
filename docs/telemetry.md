# Telemetry and Diagnostics

Telemetry is local-only and opt-in. It is written as JSONL under:

```text
$XDG_STATE_HOME/zdr/events.jsonl
```

When `XDG_STATE_HOME` is unset, the fallback is:

```text
~/.local/state/zdr/events.jsonl
```

## Enable Telemetry

Use config:

```json
{
  "telemetry": {
    "enabled": true,
    "max_events": 1000
  }
}
```

Or use the environment override:

```bash
ZDR_TELEMETRY=1
```

`ZDR_TELEMETRY=0` disables event writes even when config enables telemetry.

## Inspect and Prune Events

```bash
zdr debug-events
zdr debug-events --limit 20
zdr prune-events
zdr prune-events --max-events 1000
```

`debug-events` prints the local JSONL telemetry log as a JSON array. It skips malformed JSONL records instead of failing the whole read.

`prune-events` rewrites the local log to keep only the newest valid events and reports how many valid and invalid records were removed.

## Timing Diagnostics

```bash
zdr debug-timing
zdr debug-timing ascan
zdr debug-timing ascan --budget-ms 150
zdr debug-provider-timing ascan
zdr benchmark-provider ascan --repeat 5
zdr benchmark-provider ascan --repeat 5 --provider openai-codex --model gpt-5.3-codex-spark
zdr benchmark-suite ascan
zdr benchmark-suite ascan --jsonl
```

`debug-timing` prints JSON for local paths such as version metadata, correction-cache reads, exact-query cache lookup when a query is supplied, and no-arg recovery context gathering before any provider call. `--budget-ms` adds budget metadata to the JSON without changing the command's exit status.

`debug-provider-timing` is an opt-in live provider diagnostic. It separates local candidate setup from the provider selection call and includes provider usage fields when Pi returns them.

`benchmark-provider` is the repeated live-provider version. It builds the same candidate context once, runs provider selection repeatedly, and prints p50/p95/max summaries, selected-path counts, token totals, and cost totals. `--provider` and `--model` override the configured provider only for that benchmark run. The command is intentionally capped at `--repeat 20` to avoid accidental spend.

`benchmark-suite` runs that same benchmark across provider/model pairs. With no explicit providers, it uses only the configured provider so optional providers do not make the default diagnostic fail. Passing one or more `--provider provider:model` flags replaces the default suite.

`--jsonl` streams benchmark output as line-delimited JSON. It emits a context event first, iteration events as provider calls finish, and summary events at the end.

When telemetry is enabled, direct-query and no-arg recovery modes record JSONL events for cache hits, model selections, picker outcomes, no-selections, and errors. Provider-backed model events include Pi usage data plus flattened token, prompt-cache, and cost fields when Pi exposes them.
