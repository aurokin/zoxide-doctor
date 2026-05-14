# zdr — zoxide-dr Specification

> *"When zoxide takes you to the wrong place, call zdr to look at the history and context and get you where you need to go."*

## 1. Overview

**zdr** (alias: `zdr`) is a small, fast LLM-powered companion to [zoxide](https://github.com/ajeetdsouza/zoxide). It is **not a replacement** for zoxide — it depends on zoxide's database and frecency scoring as its substrate. zdr exists to fix the cases where zoxide's pure substring matching misses, and to optionally serve as a direct LLM-driven jumper for novel queries.

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
- Feel native alongside zoxide. Single static binary, near-zero cold start.
- Fix wrong jumps with one keystroke (`zdr`) using rich shell + zoxide context.
- Optionally replace `z` for novel queries via an opt-in alias (`zz`).
- Train zoxide itself over time so zdr becomes unnecessary for queries it has seen.
- Multi-provider with OpenRouter as the first-class citizen.

**Non-goals**
- Replacing zoxide. zdr will not function without zoxide present and populated.
- A coding agent, an assistant, or anything conversational. zdr returns a path or nothing.
- Persistent server, daemon, or background process. Every invocation is a one-shot.

## 3. Architecture

- **Language**: Go. Chosen for sub-10ms cold start, single static binary, and clean stdlib coverage of `net/http` + `encoding/json`. Python's interpreter startup (~200–400ms) is unacceptable for a tool that gates shell flow.
- **No SDK dependency**: All three providers are OpenAI-compatible. Go stdlib is sufficient. No LangChain, no `openai-go`, no AI framework.
- **Shell integration**: Mirrors zoxide's install pattern. A small init script defines the `zdr` (and optionally `zz`) shell functions plus a `preexec` hook that maintains the escalation marker.

## 4. Modes

zdr dispatches on argument presence.

### 4.1 Recovery mode — `zdr` (no args)

Triggered when the user has just jumped somewhere wrong via `z`. zdr reads the previous `z` query from shell history (or accepts it as `zdr <query>` — see input mode, which subsumes this).

### 4.2 Input mode — `zdr <query>` (or `zz <query>` alias)

Direct LLM resolution, skipping zoxide's frecency lookup entirely. Opt-in via a one-line alias:

```bash
alias zz='zdr'
```

Cost-aware: input mode would hit the LLM on every `cd`, so it is gated by a local query cache (§8) that turns the LLM into a one-shot teacher. First `zz ascan` is a network call; every subsequent `zz ascan` is an instant cache hit.

## 5. Escalation Ladder

A behavioral signal — *"was the previous shell command also zdr?"* — drives escalation. Not a time-based TTL.

| Call # | Reasoning | Behavior |
|--------|-----------|----------|
| 1st    | off       | Snappy. LLM picks from zoxide DB + context. |
| 2nd    | `high`    | Marker present → previous suggestion was rejected. Inject rejected paths into prompt as `Already tried (wrong): [...]`. Print `thinking harder...` to stderr so the user knows zdr heard them. |
| 3rd    | n/a       | Bail to `fd -t d --hidden . ~ \| fzf --query="<original>"`, merged with `zoxide query -l` for frecency ranking. Whatever the user picks gets `zoxide add`-ed. |

### 5.1 Escalation marker

A file at `$XDG_CACHE_HOME/zdr/escalate` (default `~/.cache/zdr/escalate`) containing the previous run's `{query, pwd, suggested_paths}`. Its **mere presence** means "the previous shell command was zdr-family." The shell preexec hook (§9) deletes it on any non-zdr command.

## 6. Context Gathering

The prompt is small on purpose. What goes in:

- **Zoxide DB**: `zoxide query --list --score` (top N entries by frecency; full DB if small).
- **Original query**: the `<query>` arg, or the last `z` invocation parsed from `$HISTFILE`.
- **Current pwd**: where zoxide landed (recovery mode) or `$PWD` (input mode).
- **Recent shell history**: last 10–20 commands from `$HISTFILE`. Filter out trivial commands (`ls`, `pwd`, `clear`).
- **Git state** (if in a repo): `git rev-parse --show-toplevel` + current branch.
- **Rejected paths** (2nd+ call only): from the escalation marker.

## 7. Prompt Contract

### 7.1 System prompt (sketch)

```
You are zdr, a directory disambiguation helper for the zoxide CLI tool.
Given a user's short query and their zoxide frecency database, return the
single best directory path the user most likely intended to navigate to.

Recognize abbreviations, initialisms, and partial matches that simple
substring search would miss (e.g. "ascan" -> "agentscan").

Output strict JSON only. No prose, no markdown, no code fences.
Schema: {"path": "<absolute path>", "confidence": <0.0-1.0>, "reason": "<one short sentence>"}

If no good candidate exists in the database, return:
{"path": null, "confidence": 0.0, "reason": "<why>"}
```

### 7.2 User message structure

The order is intentional. The **stable prefix** (system prompt + zoxide DB) sits first so it can be cached across calls; the **volatile tail** (query, pwd, history, rejected paths) sits last.

```
=== Stable prefix (cacheable across calls) ===

Zoxide database (ranked by frecency, top 50):
  1. /home/me/dev/agentscan
  2. /home/me/dev/scanner-tool
  3. /home/me/old/projects/scan
  ...

=== Volatile tail (changes every call) ===

Current pwd: /home/me/wrong/place
Recent shell history:
  git status
  cd ~/dev/agentscan
  npm test
  z ascan
Query: ascan
Already tried (wrong): []      # populated on 2nd+ call
```

**Critical**: the zoxide DB block uses **ordinal rank** (`1.`, `2.`, ...), not raw frecency scores. Including raw scores (e.g. `152.3`) would invalidate the cached prefix on every `z` invocation, since scores update on every visit. Rank order changes only when paths are added, removed, or significantly reordered — far less often.

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

All four supported providers do automatic prefix caching on shared input. Hit pricing is ~10% of miss pricing, which compounds because zdr's prompt is heavily input-weighted (~1,200 in / ~60 out per typical call).

Two design choices serve cache hit rate:

1. **Prefix stability** — message body is ordered stable-first, volatile-last (see §7.2). System prompt and zoxide DB land before any context that changes per-call.
2. **Rank, not raw scores** — the zoxide DB block uses ordinal positions so the prefix doesn't churn every time a frecency score updates.

Cache behavior by provider:

| Provider | Caching mechanism | Hit rate (input) |
|---|---|---|
| DeepSeek API | Automatic, no code changes. Cache TTL "a few hours to a few days." 64-token minimum to be cached. | $0.014/M (90% off) |
| OpenRouter | Passes DeepSeek's automatic caching through. Uses provider sticky routing to keep the same backend warm across calls. | $0.014/M (90% off) |
| OpenCode Zen | Explicit cached-read pricing in the published table. | Model-dependent (e.g. Qwen3.5 Plus drops $0.20 → $0.02 per 1M) |
| OpenCode Go | Inherits underlying provider behavior; subscription model masks per-token cost. | n/a (flat sub) |

The 2nd-call escalation is the textbook cache scenario: >95% of the prompt is identical to the 1st call (only `Already tried` and reasoning settings change). That means reasoning-on retries pay near-zero input cost on the cached prefix and only the fresh tail + output tokens are billed at full rate.

## 8. Provider Layer

All four providers expose OpenAI-compatible `/chat/completions`. A single HTTP client, four configs.

| Provider | Base URL | Default model | Notes |
|---|---|---|---|
| **OpenRouter** (first-class) | `https://openrouter.ai/api/v1` | `deepseek/deepseek-v4-flash` | $0.14/$0.28 per 1M. Passes DeepSeek's automatic caching through. Provider sticky routing keeps cache warm across calls. |
| **DeepSeek API** (direct) | `https://api.deepseek.com/v1` | `deepseek-chat` (V4 Flash) | $0.14/$0.28 per 1M cache miss, **$0.014/M cache hit** (90% off input). Cache TTL "hours to days." No middleman, fewest hops. |
| **OpenCode Zen** | `https://opencode.ai/zen/v1` | (see notes) | Paid V4 Flash is **not currently sold**; only a data-retentive free promo tier. Closest paid options: GPT 5 Nano ($0.05/$0.40, cached read $0.005), Qwen3.5 Plus ($0.20/$1.20, cached read $0.02). |
| **OpenCode Go** | `https://opencode.ai/go/v1` | `opencode-go/kimi-k2.6` | Subscription ($5 first month, then $10/mo). Lineup is Kimi/GLM/Qwen/MiniMax — **no V4 Flash**. Use as backup when V4 Flash is unavailable elsewhere. |

### 8.1 Reasoning toggle

DeepSeek V4 Flash supports `reasoning_effort: "high" | "xhigh"`. Default off for snappy first calls. Flip to `high` on the 2nd-call escalation. `xhigh` is reserved (probably never needed — we fall to fzf instead).

### 8.2 Fallback strategy

Single provider per call. On HTTP error or timeout (>5s default), fall through to the next configured provider. Do not race them in parallel — wastes tokens, complicates accounting, and **breaks the cache warmth** that sticky routing buys us.

Recommended order for new users: DeepSeek direct → OpenRouter → Zen (on a paid alt model). DeepSeek direct is cheapest at scale and gives the fullest cache visibility (`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` in the response usage block). OpenRouter is the natural backup since it speaks the same model and inherits the same cache benefits.

## 9. Shell Integration

Installed via `zdr init <shell>` (mirrors `zoxide init`). For zsh:

```bash
# zdr shell function
zdr() {
  local target
  target=$(command zdr "$@") && [ -n "$target" ] && cd "$target"
}

# Optional input-mode alias
alias zz='zdr'

# Escalation marker hook
_zdr_preexec() {
  case "$1" in
    zdr*|zz\ *) ;;                                  # keep marker
    *) rm -f "${XDG_CACHE_HOME:-$HOME/.cache}/zdr/escalate" ;;
  esac
}
preexec_functions+=(_zdr_preexec)   # zsh syntax; bash uses DEBUG trap
```

## 10. Caching & Training

### 10.1 Input-mode alias cache

File: `$XDG_CACHE_HOME/zdr/aliases.json`

```json
{
  "ascan": {
    "path": "/home/me/dev/agentscan",
    "first_resolved": "2026-05-11T14:23:01Z",
    "hits": 7
  }
}
```

Lookup flow for `zz <query>`:

1. Check cache. If hit and `path` still exists on disk → return immediately, increment `hits`, **also call `zoxide add <path>`** to train zoxide.
2. If hit but `path` no longer exists → evict, fall through to LLM.
3. If miss → LLM call, store result on success, also call `zoxide add`.

### 10.2 zoxide training loop

Every successful zdr resolution (recovery mode *or* input mode, first-time *or* cache hit) calls `zoxide add <path>` a small number of times (config: `zoxide_boost`, default 3) to bump frecency. Over time, queries that zdr has resolved will start matching directly via `z`, and zdr fades into the background until the next novel abbreviation.

This is the stretch-goal "personal aliases" feature, implemented as a side effect of normal use.

## 11. Configuration

File: `$XDG_CONFIG_HOME/zdr/config.toml`

```toml
[providers]
primary = "deepseek"             # deepseek | openrouter | opencode-zen | opencode-go
fallback = ["openrouter"]        # ordered list

[providers.deepseek]
api_key_env = "DEEPSEEK_API_KEY"
model = "deepseek-chat"

[providers.openrouter]
api_key_env = "OPENROUTER_API_KEY"
model = "deepseek/deepseek-v4-flash"

[providers.opencode-zen]
api_key_env = "OPENCODE_ZEN_API_KEY"
model = "opencode/gpt-5-nano"    # paid alt; no paid V4 Flash currently sold

[behavior]
timeout_seconds = 5
history_lines = 15
zoxide_db_top_n = 50
zoxide_boost = 3                 # how many zoxide add calls per success
escalate_marker = "~/.cache/zdr/escalate"

[reasoning]
first_call = "off"
second_call = "high"
```

## 12. File Layout (Go)

```
zdr/
├── main.go         # entry, arg/mode dispatch
├── provider.go     # OpenAI-compatible HTTP client, three configs
├── context.go      # zoxide DB + shell history + git state collection
├── prompt.go       # template + JSON output parsing
├── escalate.go     # marker read/write, reasoning level selection
├── cache.go        # alias cache for input mode
├── fzf.go          # 3rd-strike picker
├── init.go         # zdr init <shell> command
└── config.go       # TOML config loader
```

## 13. Open Questions / Future Work

- **Shell history parsing**: `$HISTFILE` format varies (zsh's `: <ts>:<dur>;<cmd>` vs bash). Probably need shell-specific parsers in `context.go`.
- **Multi-shell support**: zsh first (matches zoxide's primary audience), then bash, then fish.
- **Privacy mode**: option to redact path components before sending to the LLM, for sensitive paths. Probably ships with a denylist regex in config.
- **Telemetry**: opt-in success/failure logging to `$XDG_DATA_HOME/zdr/log.jsonl` would make it possible to evaluate prompt changes against a real workload. Strictly local.
- **Embedding-based offline fallback**: long-term, a small local embedding model could handle the easy cases (`ascan` → `agentscan`) without a network call at all. Out of scope for v1.
- **Distribution**: Homebrew tap + Cargo-style install script. The binary is small enough to ship via GitHub releases for v1.

## 14. Versioning

v0.1 — recovery mode + DeepSeek direct only + cache-friendly prompt structure. No alias cache yet.
v0.2 — input mode + alias cache + zoxide training loop.
v0.3 — OpenRouter + Zen fallback chain.
v0.4 — fzf 3rd-strike fallback + 2nd-call reasoning escalation + cache-hit telemetry.
v1.0 — config file, multi-shell init, docs.
