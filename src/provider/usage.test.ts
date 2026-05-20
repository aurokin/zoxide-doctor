import { describe, expect, test } from "bun:test";
import { summarizeProviderUsage } from "./usage.js";

describe("summarizeProviderUsage", () => {
  test("extracts Pi token, cache, and cost fields", () => {
    expect(
      summarizeProviderUsage({
        input: 100,
        output: 25,
        cacheRead: 40,
        cacheWrite: 10,
        totalTokens: 175,
        cost: {
          input: 0.001,
          output: 0.002,
          cacheRead: 0.0001,
          cacheWrite: 0.0005,
          total: 0.0036,
        },
      }),
    ).toEqual({
      input_tokens: 100,
      output_tokens: 25,
      cache_read_tokens: 40,
      cache_write_tokens: 10,
      total_tokens: 175,
      cost_input: 0.001,
      cost_output: 0.002,
      cost_cache_read: 0.0001,
      cost_cache_write: 0.0005,
      cost_total: 0.0036,
    });
  });

  test("ignores missing or non-finite fields", () => {
    expect(
      summarizeProviderUsage({
        input: 12,
        output: Number.NaN,
        totalTokens: Number.POSITIVE_INFINITY,
        cost: {
          total: 0.004,
        },
      }),
    ).toEqual({
      input_tokens: 12,
      cost_total: 0.004,
    });
  });

  test("returns null when usage has no numeric provider fields", () => {
    expect(summarizeProviderUsage(null)).toBeNull();
    expect(summarizeProviderUsage({ cost: {} })).toBeNull();
  });
});
