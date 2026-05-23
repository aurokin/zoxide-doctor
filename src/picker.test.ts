import { describe, expect, test } from "bun:test";
import { buildPickerPaths, runPicker, type CommandOutput } from "./picker.js";

describe("buildPickerPaths", () => {
  test("dedupes zoxide and fd paths while preserving zoxide priority", () => {
    expect(
      buildPickerPaths({
        zoxideEntries: [
          { path: "/repo/agentscan", score: 10, rank: 1 },
          { path: "/repo/agentchat", score: 9, rank: 2 },
        ],
        fdPaths: ["/repo/agentchat", "/repo/other"],
      }),
    ).toEqual(["/repo/agentscan", "/repo/agentchat", "/repo/other"]);
  });

  test("excludes rejected paths", () => {
    expect(
      buildPickerPaths({
        zoxideEntries: [
          { path: "/repo/wrong", score: 10, rank: 1 },
          { path: "/repo/right", score: 9, rank: 2 },
        ],
        fdPaths: ["/repo/also-wrong", "/repo/backup"],
        rejectedPaths: ["/repo/wrong", "/repo/also-wrong"],
      }),
    ).toEqual(["/repo/right", "/repo/backup"]);
  });
});

describe("runPicker", () => {
  test("reports missing fzf as unavailable", async () => {
    expect(
      await runPicker(
        {
          query: "ascan",
          zoxideEntries: [{ path: "/repo/agentscan", score: 10, rank: 1 }],
        },
        {
          isCommandAvailable: async (command) => command !== "fzf",
          runCommand: async () => {
            throw new Error("unexpected command");
          },
        },
      ),
    ).toEqual({
      status: "unavailable",
      reason: "fzf is required for interactive picker fallback",
    });
  });

  test("returns cancelled when fzf exits without a selection", async () => {
    expect(
      await runPicker(
        {
          query: "ascan",
          zoxideEntries: [{ path: "/repo/agentscan", score: 10, rank: 1 }],
        },
        {
          isCommandAvailable: async () => true,
          runCommand: async () => ({ code: 130, stdout: "", stderr: "" }),
        },
      ),
    ).toEqual({ status: "cancelled" });
  });

  test("returns selected path and sends query plus candidate input to fzf", async () => {
    const commands: Array<{ command: string; args: string[]; stdin?: string }> = [];

    expect(
      await runPicker(
        {
          query: "ascan",
          zoxideEntries: [
            { path: "/repo/agentscan", score: 10, rank: 1 },
            { path: "/repo/agentchat", score: 9, rank: 2 },
          ],
        },
        {
          isCommandAvailable: async () => true,
          runCommand: async (input) => {
            commands.push(input);
            return { code: 0, stdout: "/repo/agentscan\n", stderr: "" };
          },
        },
      ),
    ).toEqual({ status: "selected", path: "/repo/agentscan" });

    expect(commands).toEqual([
      {
        command: "fzf",
        args: [
          "--query",
          "ascan",
          "--prompt",
          "zdr> ",
          "--header",
          "Select a directory for Zoxide Doctor recovery",
          "--height",
          "40%",
          "--layout",
          "reverse",
        ],
        stdin: "/repo/agentscan\n/repo/agentchat\n",
      },
    ]);
  });

  test("adds fd paths when fd is available and scan roots are provided", async () => {
    const commands: Array<{ command: string; args: string[]; stdin?: string }> = [];

    expect(
      await runPicker(
        {
          query: "ascan",
          zoxideEntries: [{ path: "/repo/agentscan", score: 10, rank: 1 }],
          scanRoots: ["/repo"],
        },
        {
          isCommandAvailable: async () => true,
          runCommand: async (input): Promise<CommandOutput> => {
            commands.push(input);
            if (input.command === "fd") {
              return { code: 0, stdout: "/repo/agentchat/\n/repo/agentscan/\n", stderr: "" };
            }
            return { code: 0, stdout: "/repo/agentchat\n", stderr: "" };
          },
        },
      ),
    ).toEqual({ status: "selected", path: "/repo/agentchat" });

    expect(commands).toEqual([
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
          "200",
          ".",
          "/repo",
        ],
      },
      {
        command: "fzf",
        args: [
          "--query",
          "ascan",
          "--prompt",
          "zdr> ",
          "--header",
          "Select a directory for Zoxide Doctor recovery",
          "--height",
          "40%",
          "--layout",
          "reverse",
        ],
        stdin: "/repo/agentscan\n/repo/agentchat\n",
      },
    ]);
  });

  test("passes excluded scan roots to fd", async () => {
    const commands: Array<{ command: string; args: string[]; stdin?: string }> = [];

    expect(
      await runPicker(
        {
          query: "ascan",
          zoxideEntries: [{ path: "/repo/agentscan", score: 10, rank: 1 }],
          scanRoots: ["/repo"],
          excludeScanRoots: ["/repo/private"],
        },
        {
          isCommandAvailable: async () => true,
          runCommand: async (input): Promise<CommandOutput> => {
            commands.push(input);
            if (input.command === "fd") {
              return { code: 0, stdout: "/repo/agentchat/\n/repo/private/agent-secret/\n", stderr: "" };
            }
            return { code: 0, stdout: "/repo/agentchat\n", stderr: "" };
          },
        },
      ),
    ).toEqual({ status: "selected", path: "/repo/agentchat" });

    expect(commands[0]).toMatchObject({
      command: "fd",
      args: expect.arrayContaining(["--exclude", "/private"]),
    });
    expect(commands[1]?.stdin).toBe("/repo/agentscan\n/repo/agentchat\n");
  });

  test("scopes fd exclude args to each picker scan root", async () => {
    const commands: Array<{ command: string; args: string[]; stdin?: string }> = [];

    expect(
      await runPicker(
        {
          query: "agent",
          zoxideEntries: [{ path: "/repo/agentscan", score: 10, rank: 1 }],
          scanRoots: ["/home", "/extra"],
          excludeScanRoots: ["/extra/private"],
        },
        {
          isCommandAvailable: async () => true,
          runCommand: async (input): Promise<CommandOutput> => {
            commands.push(input);
            if (input.command === "fd" && input.args.includes("/home")) {
              return { code: 0, stdout: "/home/private/agent-project\n", stderr: "" };
            }
            if (input.command === "fd") {
              return { code: 0, stdout: "/extra/private/agent-secret\n", stderr: "" };
            }
            return { code: 0, stdout: "/home/private/agent-project\n", stderr: "" };
          },
        },
      ),
    ).toEqual({ status: "selected", path: "/home/private/agent-project" });

    expect(commands[0]?.args).not.toContain("--exclude");
    expect(commands[0]?.args).toContain("/home");
    expect(commands[1]?.args).toEqual(expect.arrayContaining(["--exclude", "/private", "/extra"]));
    expect(commands[2]?.stdin).toBe("/repo/agentscan\n/home/private/agent-project\n");
  });

  test("does not let the first picker scan root consume every fd result slot", async () => {
    const commands: Array<{ command: string; args: string[]; stdin?: string }> = [];

    expect(
      await runPicker(
        {
          query: "agent",
          zoxideEntries: [],
          scanRoots: ["/home", "/extra"],
          maxFdResults: 2,
        },
        {
          isCommandAvailable: async () => true,
          runCommand: async (input): Promise<CommandOutput> => {
            commands.push(input);
            if (input.command === "fd" && input.args.includes("/home")) {
              return { code: 0, stdout: "/home/agent-one\n/home/agent-two\n", stderr: "" };
            }
            if (input.command === "fd") {
              return { code: 0, stdout: "/extra/agent-work\n", stderr: "" };
            }
            return { code: 0, stdout: "/extra/agent-work\n", stderr: "" };
          },
        },
      ),
    ).toEqual({ status: "selected", path: "/extra/agent-work" });

    expect(commands[0]?.args).toEqual(expect.arrayContaining(["--max-results", "1", "/home"]));
    expect(commands[1]?.args).toEqual(expect.arrayContaining(["--max-results", "1", "/extra"]));
    expect(commands[2]?.stdin).toBe("/home/agent-one\n/extra/agent-work\n");
  });

  test("skips fd scan when fd is unavailable", async () => {
    const commands: Array<{ command: string; args: string[]; stdin?: string }> = [];

    expect(
      await runPicker(
        {
          query: "ascan",
          zoxideEntries: [{ path: "/repo/agentscan", score: 10, rank: 1 }],
          scanRoots: ["/repo"],
        },
        {
          isCommandAvailable: async (command) => command === "fzf",
          runCommand: async (input) => {
            commands.push(input);
            return { code: 0, stdout: "/repo/agentscan\n", stderr: "" };
          },
        },
      ),
    ).toEqual({ status: "selected", path: "/repo/agentscan" });

    expect(commands.map((command) => command.command)).toEqual(["fzf"]);
  });
});
