import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  clearRecoveryRetry,
  readRecoveryRetryForAttempt,
  readRecoveryRetryState,
  writeRecoveryRetry,
  type FinishedZState,
} from "./shell-state.js";

let previousXdgStateHome: string | undefined;
let tempDir: string;

const state: FinishedZState = {
  schema_version: 1,
  status: "finished",
  attempt_id: "attempt-1",
  query_argv: ["ascan"],
  before_pwd: "/Users/auro/code",
  after_pwd: "/Users/auro/code/wrong",
  exit_status: 0,
  shell: "zsh",
  started_at: "2026-05-15T00:00:00.000Z",
  finished_at: "2026-05-15T00:00:01.000Z",
};

beforeEach(async () => {
  previousXdgStateHome = process.env.XDG_STATE_HOME;
  tempDir = await mkdtemp(join(tmpdir(), "zdr-shell-state-"));
  process.env.XDG_STATE_HOME = tempDir;
});

afterEach(async () => {
  if (previousXdgStateHome === undefined) {
    delete process.env.XDG_STATE_HOME;
  } else {
    process.env.XDG_STATE_HOME = previousXdgStateHome;
  }
  await rm(tempDir, { recursive: true, force: true });
});

describe("recovery retry state", () => {
  test("stores and appends rejected recovery paths for a z attempt", async () => {
    const first = await writeRecoveryRetry({
      state,
      rejectedPath: "/Users/auro/code/first",
    });
    const second = await writeRecoveryRetry({
      state,
      rejectedPath: "/Users/auro/code/second",
      existing: first,
    });

    expect(second).toMatchObject({
      status: "recovery_retry",
      z_attempt_id: "attempt-1",
      query_argv: ["ascan"],
      wrong_landing_path: "/Users/auro/code/wrong",
      rejected_paths: ["/Users/auro/code/first", "/Users/auro/code/second"],
    });
    expect(await readRecoveryRetryForAttempt(state)).toMatchObject({
      rejected_paths: ["/Users/auro/code/first", "/Users/auro/code/second"],
    });
  });

  test("ignores retry state for a different z attempt", async () => {
    await writeRecoveryRetry({
      state,
      rejectedPath: "/Users/auro/code/first",
    });

    expect(
      await readRecoveryRetryForAttempt({
        ...state,
        attempt_id: "attempt-2",
      }),
    ).toBeNull();
  });

  test("clears retry state", async () => {
    await writeRecoveryRetry({
      state,
      rejectedPath: "/Users/auro/code/first",
    });
    await clearRecoveryRetry();

    expect(await readRecoveryRetryState()).toBeNull();
  });
});
