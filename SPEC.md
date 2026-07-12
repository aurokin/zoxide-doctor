# zdr — zoxide-dr Specification

> *"When zoxide takes you to the wrong place, call zdr to look at the recorded jump context and get you where you need to go."*

## 1. Overview

**zdr** is a small LLM-powered doctor for [zoxide](https://github.com/ajeetdsouza/zoxide). It is **not a replacement** for zoxide — it depends on zoxide's database and frecency scoring as its substrate. zdr exists for the moment after `z` takes the user to the wrong place.

The primary loop is:

1. User runs `z <query>`.
2. zoxide jumps to the wrong directory.
3. User runs `zdr`.
4. If zdr is wrong, user runs `zdr` again.
5. If zdr is still wrong, user runs `zdr` again and gets an interactive picker.

Direct-query mode (`zdr <query>`) is a secondary experiment, not the core product.

### Locked product decisions

- The primary product is recovery after a bad `z` jump.
- Repeated `zdr` invocations are an intentional rejection/escalation signal.
- `zdr <query>` is allowed as the direct-query path, but must not be positioned as the normal replacement for `z`.
- Learned behavior means zdr-owned correction memory, not zoxide frecency boosting.
- Recovery context comes from recorded shell state, not shell history scraping.

### Canonical motivating example

```
$ z ascan        # zoxide misses — "ascan" is not a substring of "agentscan"
                 # (the letters are there but split: agent + scan)
$ pwd
/home/me/wrong/place
$ zdr            # LLM sees the zoxide DB, spots the abbreviation, jumps to
                 # /home/me/dev/agentscan
```

The LLM's job is recognizing abbreviations, initialisms, and intent that pure substring matching cannot see.

## 2. Goals & Non-goals

**Goals**
- Fix wrong `z` jumps with one command: `zdr`.
- Escalate naturally when the user repeats `zdr` after a bad correction.
- Feel native alongside zoxide. Minimal shell friction and fast cold start for a tool that gates navigation.
- Offer direct-query mode (`zdr <query>`) as an experimental shortcut for novel aliases.
- Use a provider framework so zdr does not grow custom provider plumbing.
- Default to subscription auth (ChatGPT-plan OAuth); support env-key providers as the alternative.

**Non-goals**
- Replacing zoxide as the normal jump command. The default path remains `z <query>` first, `zdr` only when that goes wrong.
- A coding agent, an assistant, or anything conversational. zdr returns a path or nothing.
- Persistent server, daemon, or background process. Every invocation is a one-shot.
- Frecency manipulation as a learning strategy. zdr should not repeatedly call `zoxide add` to boost directories.

## 3. Architecture

- **Language/runtime**: TypeScript on Bun. Bun is the runtime and distribution target because cold start matters in shell flow and `bun build --compile` ships a standalone executable.
- **Model layer**: Pi's provider/model SDK (`@earendil-works/pi-ai` ^0.80, via the `/compat` entrypoint) for fast-tier LLM calls, model metadata, reasoning controls, and usage/cost accounting. The original spec excluded agent SDKs entirely; that boundary was deliberately relaxed for the escalation tier only, which may run through `@anthropic-ai/claude-agent-sdk` (§8.2). The fast path remains completion-only.
- **Shell integration**: Mirrors zoxide's install pattern. A small init script defines the `zdr` shell function and records `z` attempts at execution time so recovery mode never has to reconstruct intent from shell history.

### 3.1 Cold-start requirement

Cold start is part of the product, not an implementation detail.

- Local paths (`zdr --version`, `zdr record-z`, cache-hit `zdr <query>`, no-arg context gathering before any network call) run under a 150ms budget, checked by `bun scripts/timing-baseline.ts` (it reports budget failures in its JSON output; it does not fail the build).
- Provider SDK imports stay dynamic. Local-only paths never load them; import cost is acceptable only on paths about to make a network call.

## 4. Command Surface

The public commands are deliberately separated:

- `z <query>` remains the normal zoxide jump command.
- `zdr` with no args means "repair the last `z` jump."
- `zdr <query>` means "try a direct LLM/correction-memory jump" and is experimental.

The no-arg path is the product's center of gravity. Argument-bearing `zdr <query>` is allowed for convenience, but docs and examples should teach `z <query>` first and `zdr` as the recovery command. `zdr --help` lists the full surface, including debug, benchmark, and provider commands.

### 4.1 Recovery mode — `zdr` (no args)

Triggered when the user has just jumped somewhere wrong via `z`. zdr reads the previous `z` attempt from its own shell-recorded state, not from `$HISTFILE`.

Recovery mode is the primary workflow and must be deterministic. `zdr init <shell>` installs a zoxide-aware shell integration that records:

- the raw `z` argv/query
- `PWD` before the `z` call
- `PWD` after the `z` call
- the zoxide exit status
- timestamp and shell name

The state file lives at `$XDG_STATE_HOME/zdr/last_z.json` (default `~/.local/state/zdr/last_z.json`). `zdr` with no args uses that file as the source of truth. The wrapper preserves the real zoxide exit code and does not change normal `z` behavior.

### 4.2 Direct-query mode — `zdr <query>` experimental

Direct LLM resolution, skipping zoxide's normal query path.

```bash
zdr ascan
```

Cost-aware: direct-query mode could hit the LLM on every attempted jump, so it is gated by a local correction cache (§10). First `zdr ascan` is a network call; every subsequent `zdr ascan` can be an instant cache hit.

## 5. Escalation Ladder

A behavioral signal — *"was the previous shell command also zdr?"* — drives escalation. Not a time-based TTL.

| Call # | User action | Behavior |
|--------|-------------|----------|
| 1st    | `zdr` after bad `z` jump | Fast tier. Configured provider at minimal reasoning (maps to Codex `low` effort). Snappy: LLM picks from zoxide DB + recorded jump context. |
| 2nd    | `zdr` again after bad zdr correction | Escalation tier. Rejected paths injected into the prompt as `Already tried (wrong): [...]`. Uses the optional `escalation` config block if set (§8.2, recommended: `zdr config-escalation claude sonnet`); otherwise the same provider with `high` reasoning. Prints `thinking harder...` to stderr so the user knows zdr heard them. |
| 3rd    | `zdr` again after another bad correction | Bail to `fd -t d --hidden . ~ \| fzf --query="<original>"`, merged with `zoxide query -l` for frecency ranking. Whatever the user picks is returned as the target. |

### 5.1 Recovery retry state

A file at `$XDG_STATE_HOME/zdr/recovery_retry.json` (default `~/.local/state/zdr/recovery_retry.json`) records the active recovery retry for the last recorded `z` attempt. It contains the original z attempt id/query, the original wrong landing path, and rejected `zdr` suggestion paths. Its presence for the current `last_z.json` means "the previous shell command was no-arg `zdr`." The shell preexec hook (§9) deletes it on any command that is not no-arg `zdr`.

## 6. Context Gathering

The prompt is small on purpose. Recovery mode does not send broad shell history by default; the recorded `z` attempt provides the important intent signal.

- **Zoxide candidates**: `zoxide query --list --score`, converted into a bounded ranked candidate list.
- **Original query**: the recorded `z` argv/query, or the explicit `<query>` arg.
- **Before/after pwd**: where the user was before zoxide and where zoxide landed.
- **Local directory candidates**: bounded `fd` scan when zoxide candidates are weak.
- **Remembered correction** (recovery): a cached alias target for the same query is injected as the top candidate (§10.2).
- **Rejected paths** (2nd+ call only): from recovery retry state.

### 6.1 Candidate selection

The LLM chooses from a candidate set, not an unbounded filesystem dump.

1. Load the zoxide DB. If small, include all paths; otherwise keep the top 50.
2. Compute cheap local lexical scores against every zoxide path using basename, path components, subsequence match, acronym/initialism match, and edit distance. Include the top lexical matches even if they are low in frecency.
3. Include the path zoxide actually chose and mark it as `wrong_landing_candidate` in recovery mode.
4. If the best zoxide candidates are weak, add a bounded local directory scan. Scan scope comes from config: `context.default_dir` (default `~`), plus `context.include_dirs`, minus `context.exclude_dirs`. Depth and count are capped.
5. Send candidates as stable IDs, redacted display paths, and lightweight metadata.

### 6.2 Privacy normalization

Before sending context to the model:

- Replace the user's home directory with `~`.
- Replace obvious username path prefixes such as `/Users/<name>` and `/home/<name>` with `~`.
- Do not send recent shell history by default.
- Redact environment-variable-looking secrets, email addresses, and long token-like strings if they appear in paths or command text.
- Keep original absolute paths locally and map the selected candidate ID back before printing stdout.

Each redaction class is individually toggleable via the `privacy` config block (§11).

## 7. Prompt Contract

### 7.1 System prompt (sketch)

```
You are zdr, a directory disambiguation helper for the zoxide CLI tool.
Given a user's short query, recorded zoxide jump context, and candidate
directories, return the single best candidate ID the user most likely
intended to navigate to.

Recognize abbreviations, initialisms, and partial matches that simple
substring search would miss (e.g. "ascan" -> "agentscan").

Output strict JSON only. No prose, no markdown, no code fences.
Schema: {"candidate_id": "<id>", "confidence": <0.0-1.0>, "reason": "<one short sentence>"}

If no good candidate exists in the database, return:
{"candidate_id": null, "confidence": 0.0, "reason": "<why>"}
```

### 7.2 User message structure

The order is intentional: stable prefix (candidate list) first, volatile tail (query, pwd, z attempt, rejected paths) last.

```
=== Stable prefix ===

Candidates (ranked, top 50):
  c001. ~/dev/agentscan
  c002. ~/dev/scanner-tool
  c003. ~/old/projects/scan
  ...

=== Volatile tail (changes every call) ===

Current pwd: ~/wrong/place
Query: ascan
Z attempt:
  before_pwd: ~/dev
  landed_pwd: ~/wrong/place
  exit_status: 0
Already tried (wrong): []      # populated on 2nd+ call
```

The candidate block uses stable IDs and ordinal rank (`c001.`, `c002.`, ...), not raw frecency scores — scores update on every visit and would churn the prefix.

### 7.3 Output handling

stdout receives **only** the path (or empty on null). stderr receives any human-readable status (`thinking harder...`). The shell wrapper does the `cd`:

```bash
zdr() {
  local target
  target=$(command zdr "$@") && [ -n "$target" ] && cd "$target"
}
```

### 7.4 Prompt caching

Investigated and closed. pi-ai sends no `prompt_cache_key`, and selection prompts sit below the ~1024-token backend caching threshold, so provider-side caching never engages. No product change. The stable-prefix, rank-not-scores structure above stays — it costs nothing and becomes useful if the candidate cap ever grows past the threshold. Revisit then.

## 8. Provider Layer

zdr uses Pi's provider/model SDK instead of hand-rolled provider HTTP: model registry, provider-specific payloads, reasoning option mapping, usage/cost accounting, and env-key lookup. The fast path uses only the thin completion/model APIs — no agent loop, tool execution, or session machinery. The escalation tier may additionally use the Claude Agent SDK (§8.2).

| Tier | Backend | Default / recommended | Auth |
|---|---|---|---|
| Fast (1st call) | `openai-codex` via pi-ai | `gpt-5.6-terra` | ChatGPT-plan OAuth: `zdr provider-login openai-codex` |
| Fast (alternative) | any pi-ai env-key provider, e.g. `openrouter` | user's choice | env key, e.g. `OPENROUTER_API_KEY` |
| Escalation (2nd call, optional) | `claude` via Claude Agent SDK | `sonnet` | local `claude` CLI login (Pro/Max subscription) |

Eval basis (src/eval/, 50 cases across 10 categories): terra scores 96% accuracy with 100% stability across 3x50 repeats at p50 ~1.4s. Claude Sonnet is the strongest on abbreviations, which is the escalation rationale.

Implementation shape:

- Resolve the configured provider/model through pi-ai's compat entrypoint; call `completeSimple(...)` with no tools.
- Resolve OAuth credentials from zdr's local auth store before falling back to provider env-key behavior.
- Request strict JSON in the prompt and parse/validate locally.
- Reasoning models get 2048 max-token headroom (hidden reasoning spends output tokens); provider errors, including truncation, are surfaced.
- Omit `temperature` for OpenAI Codex; force SSE transport there so the Codex client-identity shim (`src/provider/codex-identity.ts`) applies. `gpt-5.6-luna` works only through that shim; the upstream patch is drafted in `docs/upstream/` and tracked in ROADMAP.md.
- Capture usage/cost fields for local telemetry.

### 8.1 OAuth and shared Pi auth

zdr owns its OAuth credential store at `~/.config/zdr/auth.json`, written with `0600` permissions. On first use it imports OAuth logins read-only from the Pi CLI store (`~/.pi/agent/auth.json`, override with `PI_CODING_AGENT_DIR`) into its own store, and re-imports if a stored credential stops working. It never writes the Pi file.

- `zdr provider-login <provider>` / `zdr provider-logout <provider>` — OAuth login/removal.
- `zdr provider-auth-status [provider]` — auth status without token material.
- `zdr provider-list [provider]` — pi-ai providers, OAuth support, and models.
- `zdr provider-discover` — token-free readiness report per backend, tier summary, and an escalation tip when Claude is ready but unconfigured.
- `zdr config-provider <provider> <model>` — sets `provider.name`/`provider.model` after validating the pair against pi-ai.
- `zdr config-escalation <backend> <model> [--provider <name>]` / `zdr config-escalation --clear` — sets or removes the escalation tier (backend: `pi` | `claude`).
- `zdr doctor` — read-only local setup report as JSON. Never makes a live provider call.
- `zdr benchmark-provider [query] [--repeat <count>] [--provider <p> --model <m>] [--jsonl]` — opt-in live benchmark; repeat count capped to avoid accidental spend.
- `zdr benchmark-suite [query] [--repeat <count>] [--jsonl]` — same context across provider/model pairs; defaults to the configured provider only.

### 8.2 Claude escalation backend

The `claude` escalation backend runs through `@anthropic-ai/claude-agent-sdk` on the user's Claude Pro/Max subscription. `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are stripped from the environment so the local `claude` login is used deliberately. Requires `claude` on PATH and logged in. Recommended setup: `zdr config-escalation claude sonnet`.

### 8.3 Fallback strategy

No fallback chain. On provider error or timeout (10s), fail cleanly and let the user stay where they are.

## 9. Shell Integration

Installed via `zdr init <shell>`, after `zoxide init`. Supported: zsh, bash, fish. The integration:

- saves the existing zoxide `z` function and wraps it: `zdr record-z` before the jump, `zdr finish-z` (with exit status and landing pwd) after, preserving `z` behavior and exit code;
- defines the `zdr` function that `cd`s to the printed target (internal/diagnostic subcommands pass through);
- installs a preexec hook that deletes `recovery_retry.json` on any command that is not no-arg `zdr` (§5.1).

## 10. Correction Memory

### 10.1 Direct-query correction cache

File: `$XDG_CACHE_HOME/zdr/corrections.json`

```json
{
  "ascan": {
    "path": "/home/me/dev/agentscan",
    "first_resolved": "2026-05-11T14:23:01Z",
    "hits": 7
  }
}
```

Lookup flow for `zdr <query>`:

1. Check cache. If hit and `path` still exists on disk → return immediately and increment `hits`.
2. If hit but `path` no longer exists → evict, fall through to LLM.
3. If miss → LLM call, return the selected path on success.
4. Store high-confidence direct-query model selections for future exact-query cache hits.

`zdr forget <query>` removes one entry. This cache is not zoxide training and never boosts frecency scores. It is personal correction memory for exact aliases like `ascan -> ~/dev/agentscan`.

### 10.2 Recovery alias memory

Implemented. Recovery mode stores successful repairs into the same `corrections.json`:

- Model selections with confidence >= 0.75 and all picker selections are remembered.
- On a later recovery of the same query, the remembered target is injected as the top candidate — even if it is absent from the zoxide DB and local scan.
- A rejected suggestion (user runs `zdr` again) evicts its entry.
- Correction-cache failures never break navigation; they warn on stderr and continue.

An interactive `remember ascan -> ~/dev/agentscan? [y/N]` prompt remains future work (§13).

## 11. Configuration

File: `$XDG_CONFIG_HOME/zdr/config.json` (default `~/.config/zdr/config.json`). JSON, strict schema — unknown keys are rejected. All fields except `escalation` have defaults; a missing file means defaults.

```json
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
  },
  "escalation": {
    "backend": "claude",
    "model": "sonnet"
  }
}
```

`escalation.backend` is `pi` or `claude`; the `pi` backend takes an optional `name` (provider name, defaults to `provider.name`), while `claude` forbids it. Edit via `zdr config-provider` and `zdr config-escalation` rather than by hand. Telemetry is opt-in and strictly local (`$XDG_STATE_HOME/zdr/events.jsonl`).

## 12. File Layout

```
src/
├── cli.ts, cli-args.ts       # entry, arg/mode dispatch
├── recovery.ts               # no-arg recovery flow + escalation ladder
├── direct-query.ts           # zdr <query> + correction cache gate
├── candidates.ts, local-scan.ts, zoxide.ts, selection-context.ts
├── prompt.ts                 # template + JSON output parsing
├── provider/                 # pi backend, claude backend, auth store, codex-identity shim
├── shell-state.ts, shell-init.ts, shell-commands.ts
├── corrections.ts            # correction memory
├── picker.ts                 # fzf 3rd-strike picker
├── config.ts, telemetry.ts, diagnostics.ts, benchmark.ts
└── eval/                     # 50-case selection eval suite (offline + live runners)
```

Eval runners: `bun scripts/run-evals.ts` (offline recall, free); live runs require `ZDR_EVAL_LIVE=1` plus `--live --backend pi:<provider>:<model>` or `claude:<model>`. `bun scripts/telemetry-to-cases.ts` mines opt-in telemetry into case skeletons.

## 13. Open Questions / Future Work

- **Privacy mode**: expand the default redaction with optional denylist regexes.
- **Interactive alias prompt**: the `remember ascan -> ...? [y/N]` flow from §10.2.
- **Embedding-based offline fallback**: a small local model could handle easy cases (`ascan` → `agentscan`) without a network call.
- **Homebrew tap**: `bun run release:prepare` generates `Formula/zoxide-doctor.rb`; copying it into a tap repo is pending.
- **Upstream pi-ai patch**: codex client-identity support (draft in `docs/upstream/`, tracked in ROADMAP.md).
- **Prompt caching**: closed for now (§7.4); revisit if the candidate cap grows.

## 14. Versioning

v0.2.0 is current, tagged, and published: release archives + SHA256SUMS built by GitHub Actions, installable via `scripts/install.sh`. Everything above describes shipped behavior except items in §13.
