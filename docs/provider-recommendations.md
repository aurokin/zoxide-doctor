# Provider Recommendations

Provider latency, routing, model catalogs, and pricing change frequently. Treat this page as a dated log, not a permanent ranking. Re-run the live eval (see Method below) before changing defaults or writing release notes that depend on provider performance.

## 2026-07-12 (current)

50-case adversarial eval. `pi:openai-codex:gpt-5.6-terra` at minimal reasoning effort (wire-level Codex `low`, shown as "(low)" below) is the shipped fast-tier default; `claude:sonnet` (subscription) is the recommended escalation tier.

Set the recommended escalation with:

```bash
zdr config-escalation claude sonnet
```

| Backend | Accuracy | Errors | p50 / p95 | Notes |
|---|---|---|---|---|
| pi:openai-codex:gpt-5.6-terra (low) | 96% | 0 | 1.44s / 3.45s | SHIPPED DEFAULT (fast tier); 100% case stability over 3 repeats |
| pi:openai-codex:gpt-5.6-luna (low) | 88%* | 0 | 1.75s / 4.5s | needs codex client identity (see codex-identity.ts) |
| pi:openai-codex:gpt-5.6-sol (low) | 88%* | 1 timeout | 1.77s / 5.4s | |
| pi:cerebras:gpt-oss-120b | 88%* | 1 | 287ms / 712ms | fastest tested; API key required |
| claude:sonnet (subscription) | 88%* | 0 | 3.2s / 7.7s | RECOMMENDED ESCALATION; best abbreviation (80%) |
| claude:haiku (subscription) | 88%* | 0 | 6.3s / 17.2s | dominated by sonnet |
| pi:openai-codex:gpt-5.3-codex-spark | 84%* | 0 | 1.36s / 4.3s | previous best subscription option; 20% abbreviation |
| pi:groq:llama-3.3-70b-versatile | 48%* | 23 | 325ms / 464ms | free-tier TPM 429s mid-run; accuracy-on-success much higher |
| pi:groq:llama-3.1-8b-instant | 10%* | 43 | 408ms | ignores JSON-only instruction; unusable |

Method: 50-case adversarial corpus (`src/eval/`, 10 categories), run via `ZDR_EVAL_LIVE=1 bun scripts/run-evals.ts --live --backend <spec>`. See `docs/evals.md` for corpus and scoring. The terra row is the authoritative run: 150 calls (`--repeat 3`), scored with the esc-api/esc-auth accepted-set labels; its only misses are `abbr-papermario` (candidate-recall gap) and `esc-web`, both stable across all repeats. Rows marked `*` are earlier single-pass runs scored before the accepted-set relabel — every tested model picks an accepted sibling on those two cases, so add ~4 points when comparing against terra. Shared weakness: abbreviation ceiling ~60% on fast-tier models; sonnet reaches 80%, which is the escalation rationale.

### Prompt caching (investigated 2026-07-12)

Every eval run reports `usage.cacheRead=0` on the `openai-codex` backend. This is **not** a reporting gap and **not** a win we are leaving on the table at our prompt sizes.

Findings (empirical, live Codex OAuth probes, `pi:openai-codex:gpt-5.6-terra`, minimal reasoning):

| Prompt | Candidates | input tokens | sessionId set? | Repeat-call cacheRead |
|---|---|---:|---|---:|
| small | 8 | 356 | no | 0 |
| realistic default | 50 | 812 | **yes** | **0** |
| padded (synthetic) | 140 | 1821 | no | 0 |
| padded (synthetic) | 140 | 1821 | **yes** | **1280** (input dropped 1821→541) |

Two independent facts explain the zeros:

1. **No `prompt_cache_key` is sent.** pi-ai's Codex transport derives it from `sessionId` (`prompt_cache_key: clampOpenAIPromptCacheKey(options.sessionId)` in `dist/api/openai-codex-responses.js`), and `select.ts` does not pass `sessionId`, so the key is omitted and the backend does not attach responses to a cache. cacheRead is otherwise fully plumbed — `openai-responses-shared.js` reads `response.usage.input_tokens_details.cached_tokens` into `usage.cacheRead`. So a nonzero value *would* surface if the backend returned one.
2. **Our prompts are below the OpenAI ~1024-token prefix-caching threshold.** The realistic default (50 candidates) is ~620–812 tokens. Even with a stable `sessionId`, the 50-candidate repeat still reported `cacheRead=0`. Caching only activated in the synthetic 140-candidate / 1821-token case.

Latency: in the one case where caching did activate (1821 tokens), the cached repeat was not faster (1193ms → 1361ms, within noise). Cost is moot — Codex OAuth reports `$0`.

**Decision: no product-code change.** Setting `sessionId` in `select.ts` would not help, because realistic selection prompts (~600–800 tokens) sit below the backend's caching threshold; caching only engages at prompt sizes we never send. If the candidate cap or prompt grows past ~1024 tokens in the future, revisit by threading a stable `sessionId` (e.g. a per-machine constant) through `selectionCompletionOptions` → `completeSimple`.

## 2026-05-23 (superseded)

Single-query `ascan` latency benchmark (`zdr benchmark-suite ascan`, 50 candidates), predating the eval corpus — it measured speed and JSON compliance on one easy query, not accuracy under adversarial cases. Headline results: `cerebras:llama3.1-8b` fastest correct hot path (p50 161ms; the model no longer exists in the Pi catalog), `cerebras:gpt-oss-120b` best quality/speed (p50 215ms), `vercel-ai-gateway:google/gemini-2.5-flash-lite` the gateway fallback, `openai-codex:gpt-5.3-codex-spark` the best subscription route. Superseded by the 2026-07-12 eval above.
