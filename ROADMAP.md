# Zoxide Doctor Roadmap

## Current Status

Status: v0.3 implementation in progress.

The project currently has the v0.1 core recovery loop plus v0.2 direct-query correction memory in place. The core decisions are locked:

- Primary workflow: `z <query>` first, then no-arg `zdr` if zoxide lands in the wrong directory.
- Repeated no-arg `zdr` calls are the rejection/escalation signal.
- `zdr <query>` is allowed as an experimental direct lookup, but it is not the default zoxide replacement path.
- Recovery context comes from recorded shell state, not shell history scraping.
- Correction memory is zdr-owned state, not zoxide frecency boosting.
- Runtime target: TypeScript on Bun, distributed as a Bun-compiled executable.
- Provider layer: Pi provider/model SDK (`@earendil-works/pi-ai`), with OpenRouter as the v0.1 default provider.
- Scope boundary: use Pi's completion/model APIs only; do not use Pi's agent loop, coding-agent harness, TUI, tool execution, or session machinery.

Current implementation status: no-arg recovery records rejected `zdr` suggestions for repeat attempts, third-attempt recovery opens an `fzf` picker over zoxide candidates, and `zdr <query>` uses local correction-cache hits before falling back to model selection and caching high-confidence direct-query results.

## Release Plan

### v0.1 — Core Recovery Loop

Goal: ship the smallest useful version of Zoxide Doctor.

Status: implemented.

Features:

- Bun TypeScript CLI.
- zsh integration.
- Shell wrapper records `z` attempts to `last_z.json`.
- no-arg `zdr` repairs the last bad `z` jump.
- Candidate builder from zoxide DB plus cheap lexical scoring.
- Bounded prompt with candidate IDs and redacted display paths.
- OpenRouter default through Pi.
- Strict JSON model response containing `candidate_id`.
- Shell wrapper changes directory to the selected path.
- No shell history parsing.
- No correction memory.
- No provider fallback chain.

Exit criteria:

- `z ascan` followed by `zdr` can recover to the intended candidate in a local test fixture.
- Normal `z` behavior and exit status are preserved by the wrapper.
- No-arg `zdr` fails safely when there is no recorded `z` attempt.
- Local-only commands avoid provider imports.
- Bun compiled executable works on the primary dev machine.

### v0.2 — Direct Lookup and Correction Memory

Goal: add the experimental shortcut path without changing the main product loop.

Status: implemented.

Features:

- `zdr <query>` direct lookup.
- `corrections.json` for exact personal mappings, such as `ascan -> ~/dev/agentscan`.
- Cache hit returns immediately without an LLM call.
- Stale paths are evicted.
- Successful direct lookups can be stored.
- No zoxide frecency boosting.

Exit criteria:

- `zdr ascan` can resolve from correction memory without a network call.
- Direct lookup does not preserve or advance no-arg `zdr` escalation state.
- Correction memory remains separate from the zoxide database.

### v0.3 — Escalation and Picker Fallback

Goal: make bad repairs recoverable without leaving the flow.

Status: in progress. Repeat-attempt routing and zoxide-candidate `fzf` picker fallback are implemented; `fd` directory scan augmentation is still pending.

Features:

- Second no-arg `zdr` treats the previous repair as rejected.
- Rejected paths are included in the next prompt.
- Optional stronger reasoning on second attempt when the model/provider supports it.
- Third no-arg `zdr` falls back to interactive `fd` + `fzf`.
- Picker result is returned as the target.

Exit criteria:

- Repeating `zdr` records and excludes prior wrong suggestions.
- Any non-no-arg-`zdr` command clears escalation state.
- Third attempt opens a useful picker seeded with the original query.

### v0.4 — Telemetry and Cost Control

Goal: make prompt and candidate tuning data-driven.

Features:

- Local latency logging.
- Token, usage, and cost accounting from Pi/provider responses.
- Prompt-cache telemetry where exposed by the provider.
- Local success/failure JSONL log.
- Measurements for cold start, context gathering, provider latency, and cache hits.

Exit criteria:

- A local log can answer: what query was attempted, what candidate was chosen, how long it took, whether cache was used, and what it cost.
- Telemetry is local-only and can be disabled.
- Prompt-cache assumptions can be validated from actual usage data.

### v1.0 — Installable Tool

Goal: make Zoxide Doctor reliable enough for regular use.

Features:

- Finalized config file.
- Multi-shell support beyond zsh, likely bash then fish.
- Expanded privacy settings.
- Install docs.
- Homebrew tap and/or install script.
- Bun standalone packaging settled.
- Provider/model configuration documented.

Exit criteria:

- New users can install, initialize shell integration, configure an API key, and use `zdr` from docs alone.
- zsh, bash, and fish behavior is documented and tested.
- Privacy defaults and opt-outs are clear.

## Near-Term Implementation Tasks

1. Document install and shell initialization flow.
2. Add manual correction-cache inspection/removal commands.
3. Measure cold start for local-only, cache-hit, context-gathering, and network paths.
4. Decide whether v0.3 picker fallback needs `fd`/`fzf` dependency checks or bundled alternatives.
