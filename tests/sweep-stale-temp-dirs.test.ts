// sweepStaleTempDirs runs at module load in several test files that run in
// parallel with each other. It must never remove a directory another file
// is using right now, and it must still remove one a past run left behind.
// No timing: ages are set with utimesSync, not waited for.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepStaleTempDirs, STALE_TEMP_DIR_MIN_AGE_MS } from "./lib/process-tree.ts";

function withRoot(body: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "adg-sweep-test-"));
  try {
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function makeDir(root: string, name: string, ageMs: number): string {
  const dir = join(root, name);
  mkdirSync(dir);
  writeFileSync(join(dir, "f.txt"), "x");
  const when = new Date(Date.now() - ageMs);
  utimesSync(dir, when, when);
  return dir;
}

test("a freshly created directory with a matching prefix survives the sweep", () => {
  withRoot((root) => {
    const dir = makeDir(root, "adg-owned-fresh", 0);
    sweepStaleTempDirs(["adg-owned-"], root);
    assert.ok(existsSync(dir), "a directory in use right now must not be removed");
  });
});

test("a directory just under the age floor survives", () => {
  withRoot((root) => {
    const dir = makeDir(root, "adg-owned-nearly", STALE_TEMP_DIR_MIN_AGE_MS - 60_000);
    sweepStaleTempDirs(["adg-owned-"], root);
    assert.ok(existsSync(dir));
  });
});

test("an old directory with a matching prefix is removed", () => {
  withRoot((root) => {
    const dir = makeDir(root, "adg-owned-old", STALE_TEMP_DIR_MIN_AGE_MS + 60_000);
    sweepStaleTempDirs(["adg-owned-"], root);
    assert.equal(existsSync(dir), false, "a stale directory must still be cleared");
  });
});

test("an old directory whose name does not start with an owned prefix is left alone", () => {
  withRoot((root) => {
    const dir = makeDir(root, "adg-sibling-old", STALE_TEMP_DIR_MIN_AGE_MS + 60_000);
    sweepStaleTempDirs(["adg-owned-"], root);
    assert.ok(existsSync(dir));
  });
});

test("every prefix in the list is swept, and a missing root does not throw", () => {
  withRoot((root) => {
    const a = makeDir(root, "adg-a-old", STALE_TEMP_DIR_MIN_AGE_MS * 2);
    const b = makeDir(root, "adg-b-old", STALE_TEMP_DIR_MIN_AGE_MS * 2);
    sweepStaleTempDirs(["adg-a-", "adg-b-"], root);
    assert.equal(existsSync(a), false);
    assert.equal(existsSync(b), false);
    sweepStaleTempDirs(["adg-a-"], join(root, "does-not-exist"));
  });
});
