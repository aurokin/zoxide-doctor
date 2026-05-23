import { describe, expect, test } from "bun:test";
import { bashInitScript, fishInitScript, zshInitScript } from "./shell-init.js";

describe("shell init scripts", () => {
  test("zsh integration wraps z and bypasses non-navigation commands", () => {
    const script = zshInitScript();

    expect(script).toContain("zoxide-doctor zsh integration");
    expect(script).toContain("__zdr_original_z");
    expect(script).toContain("--shell zsh");
    expect(script).toContain("debug-provider-timing|benchmark-provider|benchmark-suite");
    expect(script).toContain('cd -- "$__zdr_target"');
    expect(script).toContain("_zdr_preexec");
  });

  test("bash integration wraps z and preserves prompt command handling", () => {
    const script = bashInitScript();

    expect(script).toContain("zoxide-doctor bash integration");
    expect(script).toContain("__zdr_original_z");
    expect(script).toContain("--shell bash");
    expect(script).toContain("debug-provider-timing|benchmark-provider|benchmark-suite");
    expect(script).toContain('PROMPT_COMMAND=(__zdr_prompt_command "${PROMPT_COMMAND[@]}")');
    expect(script).toContain('PROMPT_COMMAND="__zdr_prompt_command${PROMPT_COMMAND:+;$PROMPT_COMMAND}"');
  });

  test("fish integration wraps z and registers preexec handling", () => {
    const script = fishInitScript();

    expect(script).toContain("zoxide-doctor fish integration");
    expect(script).toContain("functions --copy z __zdr_original_z");
    expect(script).toContain("--shell fish");
    expect(script).toContain("debug-provider-timing benchmark-provider benchmark-suite");
    expect(script).toContain("function __zdr_preexec --on-event fish_preexec");
    expect(script).toContain("command zdr $argv");
  });
});
