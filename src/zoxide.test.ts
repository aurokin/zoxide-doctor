import { describe, expect, test } from "bun:test";
import { parseZoxideList } from "./zoxide.js";

describe("parseZoxideList", () => {
  test("parses score-first zoxide output and assigns ranks", () => {
    expect(
      parseZoxideList(`
  68.0 /Users/auro/code
   4.5 /Users/auro/code/agentchat
   2 /tmp/with spaces/project
`),
    ).toEqual([
      { path: "/Users/auro/code", score: 68, rank: 1 },
      { path: "/Users/auro/code/agentchat", score: 4.5, rank: 2 },
      { path: "/tmp/with spaces/project", score: 2, rank: 3 },
    ]);
  });

  test("skips malformed lines without affecting valid rank order", () => {
    expect(
      parseZoxideList(`
not zoxide output
  10.0 /valid/one
NaN /bad
   3.0 /valid/two
`),
    ).toEqual([
      { path: "/valid/one", score: 10, rank: 1 },
      { path: "/valid/two", score: 3, rank: 2 },
    ]);
  });
});
