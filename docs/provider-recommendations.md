# Provider Recommendations

As of 2026-05-23.

Provider latency, routing, model catalogs, and pricing change frequently. Treat this page as a dated snapshot, not a permanent ranking. Re-run the benchmark commands below before changing defaults or making release notes that depend on provider performance.

Benchmarks on this page used the `ascan` direct-query task with 50 candidates and selected `/Users/auro/code/agentscan` as the expected path.

## Summary

Recommended hot-path provider:

```bash
zdr config-provider cerebras llama3.1-8b
```

Recommended higher-quality fast alternative:

```bash
zdr config-provider cerebras gpt-oss-120b
```

Recommended gateway fallback:

```bash
zdr config-provider vercel-ai-gateway google/gemini-2.5-flash-lite
```

Recommended ChatGPT/Codex subscription route:

```bash
zdr provider-login openai-codex
zdr config-provider openai-codex gpt-5.3-codex-spark
```

## Provider Recommendation

For the shell hot path, prioritize low p50, low p95, consistent JSON compliance, and correct path selection over raw tokens per second. On this benchmark, Cerebras was the best provider for responsive use.

| Provider | Model | Success | Avg | P50 | P95 | Cost/run | Recommendation |
|---|---|---:|---:|---:|---:|---:|---|
| Cerebras | `llama3.1-8b` | 10/10 | 196 ms | 161 ms | 365 ms | $0.0000185 | Default hot path |
| Cerebras | `gpt-oss-120b` | 10/10 | 224 ms | 215 ms | 283 ms | $0.0001273 | Higher-quality fast path |
| Groq | `llama-3.3-70b-versatile` | 10/10 | 255 ms | 239 ms | 365 ms | $0.0004284 | Fast fallback |
| Fireworks | `gpt-oss-120b` | 10/10 | 625 ms | 502 ms | 932 ms | $0.0000724 | Viable fallback |
| Vercel AI Gateway | `google/gemini-2.5-flash-lite` | 10/10 | 848 ms | 809 ms | 1234 ms | $0.0000943 | Gateway fallback |

## gpt-oss-120b

Use this group to compare providers with the same model family where Pi exposes it.

```bash
zdr benchmark-suite ascan --repeat 5 \
  --provider cerebras:gpt-oss-120b \
  --provider groq:openai/gpt-oss-120b \
  --provider fireworks:accounts/fireworks/models/gpt-oss-120b \
  --provider cloudflare-workers-ai:@cf/openai/gpt-oss-120b \
  --provider openrouter:openai/gpt-oss-120b
```

Results from 2026-05-23:

| Provider | Model | Success | Avg | P50 | P95 | Cost/run | Notes |
|---|---|---:|---:|---:|---:|---:|---|
| Cerebras | `gpt-oss-120b` | 5/5 | 321 ms | 343 ms | 349 ms | $0.0001965 | Best same-model provider |
| Fireworks | `accounts/fireworks/models/gpt-oss-120b` | 5/5 | 582 ms | 624 ms | 701 ms | $0.0000754 | Cheaper than Cerebras/Groq in this run |
| Groq | `openai/gpt-oss-120b` | 5/5 | 604 ms | 586 ms | 676 ms | $0.0002185 | Viable fallback |
| Cloudflare Workers AI | `@cf/openai/gpt-oss-120b` | 5/5 | 1491 ms | 1517 ms | 1659 ms | $0.0003737 | Correct but too slow for default |
| OpenRouter | `openai/gpt-oss-120b` | 0/5 | n/a | n/a | n/a | n/a | Returned zero text in this run |

Recommendation: use `cerebras:gpt-oss-120b` when standardizing on `gpt-oss-120b`.

## Gemini 2.5 Flash Lite

Use this group to compare the same Gemini model through available providers.

```bash
zdr benchmark-suite ascan --repeat 5 \
  --provider openrouter:google/gemini-2.5-flash-lite \
  --provider vercel-ai-gateway:google/gemini-2.5-flash-lite
```

Results from 2026-05-23:

| Provider | Model | Success | Avg | P50 | P95 | Cost/run | Notes |
|---|---|---:|---:|---:|---:|---:|---|
| OpenRouter | `google/gemini-2.5-flash-lite` | 5/5 | 657 ms | 475 ms | 1314 ms | $0.0000941 | Faster p50, wider tail |
| Vercel AI Gateway | `google/gemini-2.5-flash-lite` | 5/5 | 870 ms | 823 ms | 1007 ms | $0.0000943 | Slower p50, tighter tail |

Google direct was not measured in this run because `GEMINI_API_KEY` was not available in the benchmark environment.

Recommendation: for this model, use OpenRouter when p50 responsiveness matters most; use Vercel AI Gateway when gateway ergonomics and steadier tail latency matter more.

## Codex Subscription Models

These are useful for users with a ChatGPT/Codex subscription who prefer OAuth instead of provider API keys.

```bash
zdr benchmark-suite ascan --repeat 5 \
  --provider openai-codex:gpt-5.3-codex-spark \
  --provider openai-codex:gpt-5.4-mini \
  --provider vercel-ai-gateway:openai/gpt-5.4-mini
```

Results from 2026-05-23:

| Provider | Model | Success | Avg | P50 | P95 | Cost/run | Notes |
|---|---|---:|---:|---:|---:|---:|---|
| Vercel AI Gateway | `openai/gpt-5.4-mini` | 5/5 | 1097 ms | 1082 ms | 1459 ms | $0.0006930 | Fastest GPT-5.4 Mini route measured |
| OpenAI Codex OAuth | `gpt-5.3-codex-spark` | 5/5 | 1359 ms | 1247 ms | 2157 ms | $0.0000000 reported | Best Codex-sub route measured |
| OpenAI Codex OAuth | `gpt-5.4-mini` | 5/5 | 2372 ms | 2393 ms | 3240 ms | $0.0007542 | Correct but slower |

`opencode:gpt-5.4-mini` and `opencode:gpt-5.3-codex` returned zero text in this benchmark and need separate adapter/provider investigation before they can be recommended.

Recommendation: for subscription/OAuth usage, prefer `openai-codex:gpt-5.3-codex-spark`. It is slower than the fastest direct API providers, but it avoids a separate API key for users who already have Codex access.

## Rebenchmarking

Before changing defaults, run:

```bash
zdr benchmark-suite ascan --repeat 10 \
  --provider cerebras:llama3.1-8b \
  --provider cerebras:gpt-oss-120b \
  --provider groq:llama-3.3-70b-versatile \
  --provider fireworks:accounts/fireworks/models/gpt-oss-120b \
  --provider vercel-ai-gateway:google/gemini-2.5-flash-lite
```

If the user has relevant keys, also run the `gpt-oss-120b`, Gemini, and Codex groups above.
