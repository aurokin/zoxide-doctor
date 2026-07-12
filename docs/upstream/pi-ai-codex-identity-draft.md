> **DRAFT — NOT YET FILED.** This is a ready-to-file GitHub issue for the pi-ai
> (pi-mono) upstream. It has not been submitted anywhere. Do not treat it as an
> open issue. Repo: https://github.com/badlogic/pi-mono

---

## Title

openai-codex: hardcoded `originator: "pi"` + pi User-Agent make newer OAuth models (e.g. `gpt-5.6-luna`) unreachable ("Model not found")

## Summary

The `openai-codex` backend advertises `gpt-5.6-luna` in its catalog for ChatGPT/Codex OAuth users, but requests for it fail with a server-side **"Model not found"**.

Root cause: the Codex responses transport hardcodes two client-identity headers on every request and offers no override:

- `dist/api/openai-codex-responses.js:1196` — `headers.set("originator", "pi")`
- `dist/api/openai-codex-responses.js:1197-1198` — `User-Agent: "pi (<platform> <release>; <arch>)"`

The ChatGPT Codex backend uses **both** of these headers to resolve which server-side model checkpoint a request may reach. With originator `"pi"`, a `gpt-5.6-luna` request is routed to a non-provisioned free-tier experiment checkpoint:

```
Codex error: Model not found gpt-5.6-luna-free-1p-codexswic-ev3
```

(over WebSocket; `"Model not found gpt-5.6-luna"` over SSE). The genuine Codex CLI presents `originator: codex_cli_rs` and a `codex_cli_rs/<version>` User-Agent, which the backend routes to a real checkpoint.

Observed with `@earendil-works/pi-ai@0.80.6`.

## Evidence — identity-swap experiment

Same request body, byte-identical except for the two identity headers. Only when **both** the originator and User-Agent are set to the genuine Codex CLI values does `gpt-5.6-luna` resolve:

| originator | User-Agent | `gpt-5.6-luna` result |
|---|---|---|
| `pi` (default) | `pi (...)` (default) | ❌ Model not found (`...-free-1p-codexswic-ev3`) |
| `codex_cli_rs` | `pi (...)` | ❌ Model not found |
| `pi` | `codex_cli_rs/...` | ❌ Model not found |
| `codex_cli_rs` | `codex_cli_rs/...` | ✅ succeeds |

Sibling models (`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.3-codex-spark`) resolve under **either** identity, so they are unaffected by this bug and presenting the Codex CLI identity uniformly does not change their behavior. Only the newer `luna` checkpoint is gated on the identity.

Note: pi-ai sets these headers *after* any caller-supplied `headers` option, so a downstream consumer cannot override them through the normal options path.

## Suggested fixes (any one resolves it)

1. **Expose an identity override** — let callers set `originator` / `User-Agent` for the `openai-codex` backend (and apply caller `headers` last, so they win).
2. **Send the genuine Codex identity for this backend** — since it is impersonating the Codex client anyway, use `originator: codex_cli_rs` + a `codex_cli_rs/<version>` User-Agent. This is safe for the sibling models (they resolve under either identity).
3. **Drop `gpt-5.6-luna` from the `openai-codex` catalog** until the backend serves it to the `"pi"` originator, so it is not advertised as usable when it is not.

## Downstream workaround

zoxide-doctor ships a fetch-layer workaround (`src/provider/codex-identity.ts`): a scoped, idempotent global `fetch` wrapper that rewrites `originator` and `User-Agent` to the Codex CLI values on requests to the Codex responses endpoint, and forces the SSE transport so traffic flows through `fetch`. This is a stopgap; a native override or corrected default in pi-ai would let us remove it.
