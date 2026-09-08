// Tests for src/mutate-runner.ts: the one mutation step, and above all its
// promise that the file goes back exactly as it was.
//
// An audit found that promise held by nothing. The reviewer replaced the
// try/finally in the runner with plain sequential code that restores only
// when nothing throws, and the whole suite stayed green: every existing
// test drives the tool through paths where nothing throws, and the CLI has
// an outer restore that hides the difference at the end of a run. So the
// throwing path is tested here, at the seam, against a real file on disk.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planFileMutations } from "../src/mutate.ts";
import { runOneMutation, type CommandRun } from "../src/mutate-runner.ts";

const ORIGINAL = "export function f(a, b) {\n  return a > b;\n}\n";

function withFile(fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "adg-mutate-runner-test-"));
  const path = join(dir, "f.mjs");
  writeFileSync(path, ORIGINAL);
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function firstMutation() {
  const [mutation] = planFileMutations("src/f.mjs", ORIGINAL);
  assert.equal(mutation.original, ">");
  return mutation;
}

function ok(status: number): CommandRun {
  return { status, timedOut: false, durationMs: 5 };
}

const writeToDisk = (path: string, text: string): void => writeFileSync(path, text);

test("the file is restored when the command runner throws", () => {
  withFile((path) => {
    let mutatedOnDisk = "";
    assert.throws(
      () =>
        runOneMutation(firstMutation(), ORIGINAL, path, {
          writeFile: writeToDisk,
          runCommand: () => {
            // Read the file from inside the command, the way the real
            // command would see it, then fail the way a broken runner does.
            mutatedOnDisk = readFileSync(path, "utf8");
            throw new Error("the runner blew up");
          },
        }),
      /the runner blew up/,
    );
    assert.equal(mutatedOnDisk, "export function f(a, b) {\n  return a >= b;\n}\n", "the break did reach the disk");
    assert.equal(readFileSync(path, "utf8"), ORIGINAL, "the original is back on disk after the throw");
  });
});

test("the restore is attempted even when writing the break throws", () => {
  withFile((path) => {
    const written: string[] = [];
    assert.throws(
      () =>
        runOneMutation(firstMutation(), ORIGINAL, path, {
          writeFile: (target, text) => {
            written.push(text);
            if (written.length === 1) throw new Error("disk full");
            writeToDisk(target, text);
          },
          runCommand: () => ok(1),
        }),
      /disk full/,
    );
    assert.equal(written.length, 2, "the restore ran after the failed write");
    assert.equal(written[1], ORIGINAL);
    assert.equal(readFileSync(path, "utf8"), ORIGINAL);
  });
});

test("the file is restored after an ordinary run, whatever the command said", () => {
  for (const [status, verdict] of [
    [0, "survived"],
    [1, "killed"],
  ] as const) {
    withFile((path) => {
      const result = runOneMutation(firstMutation(), ORIGINAL, path, {
        writeFile: writeToDisk,
        runCommand: () => ok(status),
      });
      assert.equal(result.verdict, verdict);
      assert.equal(result.exitCode, status);
      assert.equal(readFileSync(path, "utf8"), ORIGINAL);
    });
  }
});

test("a timed-out command is a timeout with no exit code, and the file still goes back", () => {
  withFile((path) => {
    const result = runOneMutation(firstMutation(), ORIGINAL, path, {
      writeFile: writeToDisk,
      runCommand: () => ({ status: null, timedOut: true, durationMs: 3000 }),
    });
    assert.equal(result.verdict, "timeout");
    assert.equal(result.exitCode, null);
    assert.equal(readFileSync(path, "utf8"), ORIGINAL);
  });
});

test("a mutation that changes nothing is skipped without writing at all", () => {
  withFile((path) => {
    const mutation = firstMutation();
    // A mutation whose after text is its before text cannot break anything,
    // so nothing is written and no command runs.
    const result = runOneMutation({ ...mutation, after: mutation.before }, ORIGINAL, path, {
      writeFile: () => assert.fail("nothing should be written for a skipped mutation"),
      runCommand: () => assert.fail("no command should run for a skipped mutation"),
    });
    assert.equal(result.verdict, "skipped");
    assert.equal(readFileSync(path, "utf8"), ORIGINAL);
  });
});
