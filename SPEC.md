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
- Keep enough structure in the prompt to support provider-side prompt caching later.
- Use a provider framework so zdr does not grow custom provider plumbing.
- Use OpenRouter as the default provider target for v0.1.

**Non-goals**
- Replacing zoxide as the normal jump command. The default path remains `z <query>` first, `zdr` only when that goes wrong.
- A coding agent, an assistant, or anything conversational. zdr returns a path or nothing.
- Persistent server, daemon, or background process. Every invocation is a one-shot.
- Frecency manipulation as a learning strategy. zdr should not repeatedly call `zoxide add` to boost directories.

## 3. Architecture

- **Language/runtime**: TypeScript on Bun. Bun is the runtime and distribution target because cold start matters in shell flow and `bun build --compile` can ship a standalone executable. Local-only paths should avoid unnecessary provider imports where possible.
- **Model layer**: Use Pi's provider/model SDK (`@earendil-works/pi-ai`) for LLM calls, model metadata, reasoning controls, usage/cost accounting, and provider-specific request details. Use the provider layer only; zdr is not an autonomous Pi coding agent.
- **Shell integration**: Mirrors zoxide's install pattern. A small init script defines the `zdr` shell function and records `z` attempts at execution time so recovery mode never has to reconstruct intent from shell history.

### 3.1 Cold-start requirement

Cold start is part of the product, not an implementation detail.

- Ship as a Bun-compiled executable if Pi compatibility holds.
- Measure `zdr --version`, `zdr record-z`, cache-hit `zdr <query>`, and no-arg `zdr` context-gathering before any network call.
- Keep shell-state commands lightweight and free of provider imports.
- Treat provider/framework import time as acceptable only on paths that are about to make a network call.
- If Pi or Bun compatibility creates unacceptable startup cost, optimize the module boundary before changing product behavior.

## 4. Command Surface

The public commands are deliberately separated:

- `z <query>` remains the normal zoxide jump command.
- `zdr` with no args means "repair the last `z` jump."
- `zdr <query>` means "try a direct LLM/correction-memory jump" and is experimental.

The no-arg path is the product's center of gravity. Argument-bearing `zdr <query>` is allowed for convenience, but docs and examples should teach `z <query>` first and `zdr` as the recovery command.

### 4.1 Recovery mode — `zdr` (no args)

Triggered when the user has just jumped somewhere wrong via `z`. zdr reads the previous `z` attempt from its own shell-recorded state, not from `$HISTFILE`.

Recovery mode is the primary workflow and must be deterministic. `zdr init <shell>` installs a small zoxide-aware shell integration that records:

- the raw `z` argv/query
- `PWD` before the `z` call
- `PWD` after the `z` call
- the zoxide exit status
- timestamp and shell name

The state file lives at `$XDG_STATE_HOME/zdr/last_z.json` (default `~/.local/state/zdr/last_z.json`). `zdr` with no args uses that file as the source of truth. The wrapper should preserve the real zoxide exit code and should not change normal `z` behavior.

### 4.2 Direct-query mode — `zdr <query>` experimental

Direct LLM resolution, skipping zoxide's normal query path.

```bash
zdr ascan
```

Cost-aware: direct-query mode could hit the LLM on every attempted jump, so it is gated by a local correction cache (§10). First `zdr ascan` is a network call; every subsequent `zdr ascan` can be an instant cache hit.

## 5. Escalation Ladder

A behavioral signal — *"was the previous shell command also zdr?"* — drives escalation. Not a time-based TTL.

| Call # | User action | Reasoning | Behavior |
|--------|-------------|-----------|----------|
| 1st    | `zdr` after bad `z` jump | off | Snappy. LLM picks from zoxide DB + recorded jump context. |
| 2nd    | `zdr` again after bad zdr correction | `high` | Retry state present → previous suggestion was rejected. Inject rejected paths into prompt as `Already tried (wrong): [...]`. Print `thinking harder...` to stderr so the user knows zdr heard them. |
| 3rd    | `zdr` again after another bad correction | n/a | Bail to `fd -t d --hidden . ~ \| fzf --query="<original>"`, merged with `zoxide query -l` for frecency ranking. Whatever the user picks is returned as the target. |

### 5.1 Recovery retry state

A file at `$XDG_STATE_HOME/zdr/recovery_retry.json` (default `~/.local/state/zdr/recovery_retry.json`) records the active recovery retry for the last recorded `z` attempt. It contains the original z attempt id/query, the original wrong landing path, and rejected `zdr` suggestion paths. Its presence for the current `last_z.json` means "the previous shell command was no-arg `zdr`." The shell preexec hook (§9) deletes it on any command that is not no-arg `zdr`.

## 6. Context Gathering

The prompt is small on purpose. Recovery mode does not send broad shell history by default; the recorded `z` attempt provides the important intent signal.

- **Zoxide candidates**: `zoxide query --list --score`, converted into a bounded ranked candidate list.
- **Original query**: the recorded `z` argv/query, or the explicit `<query>` arg.
- **Before/after pwd**: where the user was before zoxide and where zoxide landed.
- **Local directory candidates**: optional bounded directory scan when zoxide candidates are weak.
- **Git state** (if cheap): repo root and current branch for before/after pwd.
- **Rejected paths** (2nd+ call only): from recovery retry state.

### 6.1 Candidate selection

The LLM should choose from a candidate set, not browse an unbounded filesystem dump.

1. Load the zoxide DB. If small, include all paths; otherwise keep the top `zoxide_db_top_n`.
2. Compute cheap local lexical scores against every zoxide path using basename, path components, subsequence match, acronym/initialism match, and edit distance. Include the top lexical matches even if they are low in frecency.
3. Include the path zoxide actually chose and mark it as `wrong_landing_candidate` in recovery mode.
4. If the best zoxide candidates are weak, add a bounded local directory scan under configured roots such as `~/code`, `~/dev`, the previous pwd's parent, and the current repo root. Depth and count are capped.
5. Send candidates as stable IDs, redacted display paths, and lightweight metadata. Do not send a full tree unless a later fallback explicitly asks for it.

This keeps recovery useful for non-substring abbreviations while preserving a stable-ish prefix for prompt caching.

### 6.2 Privacy normalization

Before sending context to the model:

- Replace the user's home directory with `~`.
- Replace obvious username path prefixes such as `/Users/<name>` and `/home/<name>` with `~`.
- Do not send recent shell history by default.
- Redact environment-variable-looking secrets, email addresses, and long token-like strings if they appear in paths or command text.
- Keep original absolute paths locally and map the selected candidate ID back before printing stdout.

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

The order is intentional. The **stable prefix** (system prompt + candidate list) sits first so it can be cached across calls; the **volatile tail** (query, pwd, z attempt, rejected paths) sits last.

```
=== Stable prefix (cacheable across calls) ===

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

**Critical**: the candidate block uses stable IDs and ordinal rank (`c001.`, `c002.`, ...), not raw frecency scores. Including raw scores (e.g. `152.3`) would invalidate the cached prefix on every `z` invocation, since scores update on every visit. Rank order changes only when paths are added, removed, or significantly reordered — far less often.

### 7.3 Output handling

stdout receives **only** the path (or empty on null). stderr receives any human-readable status (`thinking harder...`). The shell wrapper does the `cd`:

```bash
zdr() {
  local target
  target=$(command zdr "$@") && [ -n "$target" ] && cd "$target"
}
```

### 7.4 Prompt caching

Users hit zoxide back-to-back. The escalation path is a guaranteed back-to-back. Caching is therefore a design requirement, not an optimization.

Provider-side prompt caching is not required for v0.1, but the prompt should be structured so it can benefit from caching later. The likely shape is input-heavy: a stable candidate prefix plus a small volatile tail.

Two design choices serve cache hit rate:

1. **Prefix stability** — message body is ordered stable-first, volatile-last (see §7.2). System prompt and candidate list land before any context that changes per-call.
2. **Rank, not raw scores** — the candidate block uses ordinal positions so the prefix doesn't churn every time a frecency score updates.

The 2nd-call escalation should preserve the same stable prefix where practical. Only the volatile tail should change: rejected paths, escalation count, and reasoning settings.

## 8. Provider Layer

zdr uses Pi's provider/model SDK (`@earendil-works/pi-ai`) instead of hand-rolled provider HTTP. The value of the framework is provider management: model registry, provider-specific payloads, reasoning option mapping, usage/cost accounting, cache metrics where available, env-key lookup, and future provider swaps.

Use only the thin completion/model APIs. Do not use Pi's agent loop, coding-agent harness, TUI, tool execution, or session machinery for v0.1.

v0.1 defaults to OpenRouter.

| Provider | Base URL | Default model | Notes |
|---|---|---|---|
| **OpenRouter via Pi** | `https://openrouter.ai/api/v1` | `google/gemini-2.5-flash-lite` | Initial default. Selected through Pi's model registry/provider layer. |
| **OpenAI Codex via Pi OAuth** | `https://chatgpt.com/backend-api` | `gpt-5.3-codex-spark` when configured | Optional ChatGPT Pro/Plus path through Pi's `openai-codex-responses` provider. |

Implementation shape:

- Resolve the configured provider/model through Pi, e.g. `getModel("openrouter", model)`.
- Call a single completion API, e.g. `completeSimple(...)`, with no tools.
- Resolve OAuth credentials from ZDR's local auth store before falling back to provider env-key behavior.
- Request strict JSON in the prompt and parse/validate locally.
- Pass reasoning level only when escalating and only through Pi's supported option shape.
- Omit provider-unsupported options such as `temperature` for OpenAI Codex.
- Capture Pi usage/cost/cache fields when present for local telemetry.
- Keep a direct OpenAI-compatible HTTP fallback as an escape hatch only if Pi packaging/startup proves too heavy.

### 8.1 OAuth providers

ZDR owns its OAuth credential store at `~/.config/zdr/auth.json`, written with `0600` permissions. `zdr provider-login <provider>` uses Pi's OAuth helpers and `zdr provider-auth-status` reports status without token material.

`zdr config-provider <provider> <model>` updates only `provider.name` and `provider.model` in `~/.config/zdr/config.json` after validating that Pi knows the provider/model pair.

### 8.2 Reasoning toggle

Use model-specific reasoning controls only where the chosen provider/model supports them. First calls should prefer low latency. Second-call escalation may enable stronger reasoning if supported.

### 8.3 Fallback strategy

No fallback chain in v0.1. On HTTP error or timeout (>5s default), fail cleanly and let the user stay where they are.

## 9. Shell Integration

Installed via `zdr init <shell>` (mirrors `zoxide init`). For zsh:

```bash
# zdr shell function
zdr() {
  local target
  target=$(command zdr "$@") && [ -n "$target" ] && cd "$target"
}

# zoxide recording wrapper (shape only; exact function depends on shell)
z() {
  local before="$PWD"
  command zdr record-z --before "$before" -- "$@"
  __zoxide_z "$@"
  local status=$?
  command zdr finish-z --status "$status" --after "$PWD"
  return "$status"
}

# Recovery retry hook
_zdr_preexec() {
  case "$1" in
    zdr) ;;                                        # keep retry state only for no-arg recovery retry
    *)
      local retry="${XDG_STATE_HOME:-$HOME/.local/state}/zdr/recovery_retry.json"
      [[ -e "$retry" ]] && rm -f "$retry"
      ;;
  esac
}
preexec_functions+=(_zdr_preexec)   # zsh syntax; bash uses DEBUG trap
```

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

This cache is not zoxide training and should not boost frecency scores. It is personal correction memory for exact direct-query aliases like `ascan -> ~/dev/agentscan`.

The implementation should treat correction memory as zdr-owned shell-side state, not as a mutation of zoxide's frecency database.

### 10.2 Recovery-mode alias suggestions

Recovery mode may notice that a failed `z` query repeatedly resolves to the same directory. For example, if `z ascan` fails and `zdr` consistently resolves it to `~/dev/agentscan`, zdr can optionally suggest adding a personal correction:

```text
remember ascan -> ~/dev/agentscan? [y/N]
```

This should be opt-in and out of scope for v0.1. The initial implementation only records high-confidence direct-query `zdr <query>` resolutions.

## 11. Configuration

File: `$XDG_CONFIG_HOME/zdr/config.toml`

```toml
[providers]
primary = "openrouter"

[providers.openrouter]
api_key_env = "OPENROUTER_API_KEY"
model = "google/gemini-2.5-flash-lite"

[model_framework]
name = "pi-ai"
package = "@earendil-works/pi-ai"

[runtime]
name = "bun"
compile = true
target = "standalone executable"

[behavior]
timeout_seconds = 5
zoxide_db_top_n = 50
local_scan_roots = ["~/code", "~/dev"]
local_scan_depth = 3
local_scan_max_dirs = 200
last_z_state = "~/.local/state/zdr/last_z.json"
recovery_retry_state = "~/.local/state/zdr/recovery_retry.json"
correction_cache = "~/.cache/zdr/corrections.json"

[reasoning]
first_call = "off"
second_call = "high"
```

## 12. File Layout

```
zdr/
├── cli            # entry, arg/mode dispatch
├── provider       # Pi provider/model SDK setup
├── context        # zoxide DB, candidate scoring, local scans, git state
├── prompt         # template + JSON output parsing
├── shell_state    # last z attempt read/write
├── retry          # recovery retry state, rejected-path tracking
├── cache          # correction memory for direct-query mode
├── fzf            # 3rd-strike picker
├── init           # zdr init <shell> command
└── config         # TOML config loader
```

## 13. Open Questions / Future Work

- **Shell integration mechanics**: zsh first. Decide whether `zdr init zsh` wraps an existing zoxide function or initializes zoxide under the hood with a private command name.
- **Multi-shell support**: zsh first, then bash, then fish.
- **Privacy mode**: expand the default home/user redaction with optional denylist regexes.
- **Telemetry**: opt-in success/failure logging to `$XDG_DATA_HOME/zdr/log.jsonl` would make it possible to evaluate prompt changes against a real workload. Strictly local.
- **Embedding-based offline fallback**: long-term, a small local embedding model could handle the easy cases (`ascan` → `agentscan`) without a network call at all. Out of scope for v1.
- **Pi dependency freshness**: local upstream checkout is currently `~/code/upstream/pi-mono`; the current repository is `https://github.com/earendil-works/pi`. Before implementation, update/repoint local references and verify the published package/API shape under Bun.
- **Distribution**: Homebrew tap + install script for a Bun-compiled standalone executable.

## 14. Versioning

v0.1 — Bun TypeScript CLI + zsh recovery mode + recorded `z` attempts + Pi provider SDK + OpenRouter default + bounded candidate prompt.
v0.2 — direct-query mode (`zdr <query>`) + correction cache.
v0.3 — fzf 3rd-strike fallback + 2nd-call reasoning escalation.
v0.4 — prompt-cache telemetry + cost/latency logging.
v1.0 — config file, multi-shell init, docs.
