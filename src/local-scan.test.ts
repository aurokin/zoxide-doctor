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

  test("filters scan results inside excluded roots", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];

    expect(
      await scanLocalDirectories(
        {
          query: "agent",
          roots: ["/repo"],
          excludeRoots: ["/repo/private"],
        },
        {
          isCommandAvailable: async () => true,
          runCommand: async (input) => {
            calls.push(input);
            return {
              code: 0,
              stdout: "/repo/agentscan\n/repo/private/agent-secret\n",
              stderr: "",
            };
          },
        },
      ),
    ).toEqual(["/repo/agentscan"]);
    expect(calls[0]?.args).toContain("--exclude");
    expect(calls[0]?.args).toContain("/private");
  });

  test("scopes fd exclude args to each scan root", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];

    expect(
      await scanLocalDirectories(
        {
          query: "agent",
          roots: ["/home", "/extra"],
          excludeRoots: ["/extra/private"],
        },
        {
          isCommandAvailable: async () => true,
          runCommand: async (input) => {
            calls.push(input);
            return input.args.includes("/home")
              ? { code: 0, stdout: "/home/private/agent-project\n", stderr: "" }
              : { code: 0, stdout: "/extra/private/agent-secret\n", stderr: "" };
          },
        },
      ),
    ).toEqual(["/home/private/agent-project"]);

    expect(calls[0]?.args).not.toContain("--exclude");
    expect(calls[0]?.args).toContain("/home");
    expect(calls[1]?.args).toEqual(expect.arrayContaining(["--exclude", "/private", "/extra"]));
  });

  test("does not let the first scan root consume every result slot", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];

    expect(
      await scanLocalDirectories(
        {
          query: "agent",
          roots: ["/home", "/extra"],
          maxResults: 2,
        },
        {
          isCommandAvailable: async () => true,
          runCommand: async (input) => {
            calls.push(input);
            return input.args.includes("/home")
              ? { code: 0, stdout: "/home/agent-one\n/home/agent-two\n", stderr: "" }
              : { code: 0, stdout: "/extra/agent-work\n", stderr: "" };
          },
        },
      ),
    ).toEqual(["/home/agent-one", "/extra/agent-work"]);

    expect(calls[0]?.args).toEqual(expect.arrayContaining(["--max-results", "1", "/home"]));
    expect(calls[1]?.args).toEqual(expect.arrayContaining(["--max-results", "1", "/extra"]));
  });
});
