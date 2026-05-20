import { describe, expect, test } from "bun:test";
import { scanLocalDirectories } from "./local-scan.js";

describe("scanLocalDirectories", () => {
  test("uses fd when available and bounds unique directory results", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];

    const result = await scanLocalDirectories(
      {
        query: "ascan",
        roots: ["/repo", "/repo"],
        maxResults: 2,
      },
      {
        isCommandAvailable: async () => true,
        runCommand: async (input) => {
          calls.push(input);
          return input.args.includes("ascan")
            ? { code: 0, stdout: "/repo/agentscan/\n/repo/agentscan/\n", stderr: "" }
            : { code: 0, stdout: "/repo/agentchat/\n", stderr: "" };
        },
      },
    );

    expect(result).toEqual(["/repo/agentscan", "/repo/agentchat"]);
    expect(calls).toEqual([
      {
        command: "fd",
        args: [
          "--type",
          "d",
          "--hidden",
          "--color",
          "never",
          "--max-depth",
          "4",
          "--max-results",
          "2",
          "ascan",
          "/repo",
        ],
      },
      {
        command: "fd",
        args: [
          "--type",
          "d",
          "--hidden",
          "--color",
          "never",
          "--max-depth",
          "4",
          "--max-results",
          "1",
          "a.*s.*c.*a.*n",
          "/repo",
        ],
      },
    ]);
  });

  test("returns no scan results when fd is unavailable", async () => {
    expect(
      await scanLocalDirectories(
        { query: "ascan", roots: ["/repo"] },
        {
          isCommandAvailable: async () => false,
          runCommand: async () => {
            throw new Error("fd should not run");
          },
        },
      ),
    ).toEqual([]);
  });
});
