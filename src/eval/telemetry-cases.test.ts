import { describe, expect, test } from "bun:test";
import { mineTelemetryCases, withHomeTilde } from "../../scripts/telemetry-to-cases.js";

const HOME = "/home/dev";

// A small telemetry export in the shape src/telemetry.ts writes: recovery and
// direct-query events carry data.query and (sometimes) data.selected_path.
const FIXTURE_EVENTS = [
  { kind: "direct-query", outcome: "selected", data: { query: "ascan", selected_path: `${HOME}/code/agentscan` } },
  { kind: "direct-query", outcome: "cache-hit", data: { query: "ascan", selected_path: `${HOME}/code/agentscan`, cached: true } },
  { kind: "recovery", outcome: "model-selected", data: { query: "ascan", selected_path: `${HOME}/code/agentscan` } },
  { kind: "recovery", outcome: "no-selection", data: { query: "quux" } },
  { kind: "direct-query", outcome: "selected", data: { query: "api", selected_path: `${HOME}/code/api` } },
  { kind: "recovery", outcome: "model-selected", data: { query: "api", selected_path: `${HOME}/code/apiv2` } },
  // Noise / non-mined events that must be ignored.
  { kind: "cache", outcome: "hit", data: { query: "ascan" } },
  { kind: "recovery", outcome: "no-query", data: {} },
];

describe("withHomeTilde", () => {
  test("replaces a leading $HOME with ~ and leaves other paths alone", () => {
    expect(withHomeTilde("/home/dev/code/api", HOME)).toBe("~/code/api");
    expect(withHomeTilde("/home/dev", HOME)).toBe("~");
    expect(withHomeTilde("/opt/other", HOME)).toBe("/opt/other");
    expect(withHomeTilde("/home/developer/x", HOME)).toBe("/home/developer/x"); // not a boundary match
  });
});

describe("mineTelemetryCases", () => {
  test("groups by query with hit counts, outcome tallies, and tilde paths", () => {
    const skeletons = mineTelemetryCases(FIXTURE_EVENTS, HOME);
    const ascan = skeletons.find((s) => s.query === "ascan");
    expect(ascan).toBeDefined();
    if (!ascan) {
      return;
    }
    expect(ascan.hits).toBe(3);
    expect(ascan.kinds).toEqual(["direct-query", "recovery"]);
    expect(ascan.outcomes).toEqual({ "cache-hit": 1, "model-selected": 1, selected: 1 });
    expect(ascan.resolvedPaths).toEqual(["~/code/agentscan"]);
    expect(ascan.suggestedExpected).toBe("~/code/agentscan");
  });

  test("leaves suggestedExpected null when a query resolved multiple ways", () => {
    const api = mineTelemetryCases(FIXTURE_EVENTS, HOME).find((s) => s.query === "api");
    expect(api?.resolvedPaths).toEqual(["~/code/api", "~/code/apiv2"]);
    expect(api?.suggestedExpected).toBeNull();
  });

  test("ignores non-recovery/direct-query kinds and events without a query", () => {
    const skeletons = mineTelemetryCases(FIXTURE_EVENTS, HOME);
    // quux is a real recovery event with a query but no resolved path.
    const quux = skeletons.find((s) => s.query === "quux");
    expect(quux?.hits).toBe(1);
    expect(quux?.resolvedPaths).toEqual([]);
    expect(quux?.suggestedExpected).toBeNull();
    // The `cache` kind and the empty-data recovery event contribute nothing.
    expect(skeletons.map((s) => s.query).sort()).toEqual(["api", "ascan", "quux"]);
  });

  test("orders skeletons by hit count (most-observed first)", () => {
    const queries = mineTelemetryCases(FIXTURE_EVENTS, HOME).map((s) => s.query);
    expect(queries[0]).toBe("ascan"); // 3 hits, ahead of api (2) and quux (1)
  });
});
