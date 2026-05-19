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
        args: ["--query", "ascan"],
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
              return { code: 0, stdout: "/repo/agentchat\n/repo/agentscan\n", stderr: "" };
            }
            return { code: 0, stdout: "/repo/agentchat\n", stderr: "" };
          },
        },
      ),
    ).toEqual({ status: "selected", path: "/repo/agentchat" });

    expect(commands).toEqual([
      {
        command: "fd",
        args: ["--type", "d", "--hidden", "--color", "never", ".", "/repo"],
      },
      {
        command: "fzf",
        args: ["--query", "ascan"],
        stdin: "/repo/agentscan\n/repo/agentchat\n",
      },
    ]);
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
