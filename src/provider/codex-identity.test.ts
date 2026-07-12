import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ensureCodexClientIdentity } from "./codex-identity.js";

const INSTALLED = Symbol.for("zdr.codexIdentityFetchInstalled");
const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  // Reset the idempotency guard so each test installs onto a fresh spy.
  (globalThis as Record<PropertyKey, unknown>)[INSTALLED] = false;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  (globalThis as Record<PropertyKey, unknown>)[INSTALLED] = false;
});

function lastHeaders(spy: ReturnType<typeof mock>): Headers {
  const call = spy.mock.calls.at(-1) as [unknown, RequestInit] | undefined;
  return new Headers(call?.[1]?.headers);
}

describe("ensureCodexClientIdentity", () => {
  test("presents the Codex CLI identity on Codex responses requests", async () => {
    const spy = mock(async () => new Response("ok"));
    globalThis.fetch = spy as unknown as typeof fetch;
    ensureCodexClientIdentity();

    await globalThis.fetch(CODEX_URL, {
      method: "POST",
      headers: { originator: "pi", "User-Agent": "pi (linux 6; x64)" },
    });

    const headers = lastHeaders(spy);
    expect(headers.get("originator")).toBe("codex_cli_rs");
    expect(headers.get("User-Agent")).toMatch(/^codex_cli_rs\//);
  });

  test("leaves non-Codex requests untouched", async () => {
    const spy = mock(async () => new Response("ok"));
    globalThis.fetch = spy as unknown as typeof fetch;
    ensureCodexClientIdentity();

    await globalThis.fetch("https://openrouter.ai/api/v1/chat", {
      method: "POST",
      headers: { originator: "pi" },
    });

    const headers = lastHeaders(spy);
    expect(headers.get("originator")).toBe("pi");
  });

  test("is idempotent (does not double-wrap fetch)", () => {
    const spy = mock(async () => new Response("ok"));
    globalThis.fetch = spy as unknown as typeof fetch;
    ensureCodexClientIdentity();
    const afterFirst = globalThis.fetch;
    ensureCodexClientIdentity();
    expect(globalThis.fetch).toBe(afterFirst);
  });
});
