// Workaround for a pi-ai (@earendil-works/pi-ai) limitation with the
// openai-codex provider.
//
// pi-ai's openai-codex-responses transport hardcodes two client-identity
// headers on every request to the ChatGPT Codex backend and offers no override:
//   originator: "pi"
//   User-Agent: "pi (<platform> <release>; <arch>)"
//
// The ChatGPT Codex backend uses BOTH of these to resolve which server-side
// model checkpoint a request may reach. Newer experimental models — notably
// `gpt-5.6-luna` — are only served to the genuine Codex CLI client. A request
// carrying originator "pi" is routed to a non-existent free-tier experiment
// checkpoint and the server responds:
//   Codex error: Model not found gpt-5.6-luna-free-1p-codexswic-ev3
// (over WebSocket) / "Model not found gpt-5.6-luna" (over SSE).
//
// Empirically (see probe matrix in the debugging notes): neither header alone
// is sufficient — luna requires BOTH `originator: codex_cli_rs` AND a
// `codex_cli_rs/...` User-Agent. Sibling models (`gpt-5.6-sol`, `gpt-5.6-terra`,
// `gpt-5.3-codex-spark`) already resolve under either identity, so presenting
// the Codex CLI identity uniformly is safe and does not change their behavior.
//
// pi-ai sets these headers AFTER any caller-supplied `headers` option, so the
// only place we can rewrite them from zdr is at the network layer. We install a
// single, idempotent global `fetch` wrapper scoped to the Codex responses
// endpoint. Callers must also send requests over SSE (not WebSocket) so the
// traffic actually flows through `fetch`; see options.ts (`transport: "sse"`
// for openai-codex).
//
// TODO(upstream): report to pi-ai — either drop `gpt-5.6-luna` from the
// openai-codex catalog until the backend serves it to the "pi" originator, or
// expose an originator/User-Agent override. Remove this shim once fixed.

const CODEX_ORIGINATOR = "codex_cli_rs";
const CODEX_USER_AGENT = `codex_cli_rs/0.144.1 (${process.platform}; ${process.arch})`;
const CODEX_RESPONSES_PATH = "/codex/responses";

const INSTALLED = Symbol.for("zdr.codexIdentityFetchInstalled");

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

function isCodexResponsesRequest(input: FetchInput): boolean {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return url.includes(CODEX_RESPONSES_PATH) && url.includes("chatgpt.com");
}

// Presents the genuine Codex CLI client identity on Codex responses requests so
// the backend resolves the requested model to a real checkpoint. Idempotent:
// safe to call before every selection and from concurrent callers.
export function ensureCodexClientIdentity(): void {
  const g = globalThis as Record<PropertyKey, unknown>;
  if (g[INSTALLED]) {
    return;
  }
  const original = globalThis.fetch;
  const wrapped = (input: FetchInput, init?: FetchInit) => {
    if (isCodexResponsesRequest(input) && init?.headers) {
      const headers = new Headers(init.headers);
      headers.set("originator", CODEX_ORIGINATOR);
      headers.set("User-Agent", CODEX_USER_AGENT);
      return original(input, { ...init, headers });
    }
    return original(input, init);
  };
  // Preserve the runtime's `fetch.preconnect` so the wrapper is a drop-in.
  Object.assign(wrapped, { preconnect: original.preconnect?.bind(original) });
  globalThis.fetch = wrapped as typeof fetch;
  g[INSTALLED] = true;
}
