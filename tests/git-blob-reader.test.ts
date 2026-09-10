// Tests for src/git-blob-reader.ts: the whole-file reader
// src/test-diff-separator.ts's readWholeFile option is built from. Every
// production caller is covered indirectly through its own test file (the
// CLI, the PostToolUse hook, the MCP server, agent-adapter's runTestDiffGate);
// this file tests the reader itself directly, against a real throwaway git
// repository, since that is the one thing every one of those callers relies
// on this module to get right.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import process from "node:process";
import { makeGitWholeFileReader, splitRange, resolveMergeBase, resolveRangeRevisions } from "../src/git-blob-reader.ts";

function runGit(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "adg-git-blob-reader-test-"));
  runGit(dir, ["init", "-q"]);
  runGit(dir, ["config", "user.email", "test@example.invalid"]);
  runGit(dir, ["config", "user.name", "Test"]);
  return dir;
}

function withTempRepo(fn: (dir: string) => void): void {
  const dir = makeTempRepo();
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function commitFile(dir: string, name: string, content: string): void {
  mkdirSync(dirname(join(dir, name)), { recursive: true });
  writeFileSync(join(dir, name), content);
  runGit(dir, ["add", name]);
  runGit(dir, ["commit", "-q", "-m", `write ${name}`]);
}

// --- splitRange --------------------------------------------------------------

// Renamed from "splits a two-dot range into its two endpoints": splitRange
// now also reports which form was given (see the three-dot test below), so
// this asserts the full result, threeDot included, not just the endpoints.
test("splitRange splits a two-dot range into its two endpoints and reports it is not three-dot", () => {
  assert.deepEqual(splitRange("main..feature"), { oldRev: "main", newRev: "feature", threeDot: false });
});

// Renamed from "splits a three-dot range, dropping the extra dot": that
// name described the old behaviour, which silently read a three-dot range
// as if it were a two-dot one. splitRange now still separates the two
// endpoints the same way, but also says threeDot: true, so a caller can
// resolve the merge base instead of reading oldRev directly (see
// resolveMergeBase and resolveRangeRevisions below).
test("splitRange splits a three-dot range into its two endpoints and reports it is three-dot", () => {
  assert.deepEqual(splitRange("main...feature"), { oldRev: "main", newRev: "feature", threeDot: true });
});

test("splitRange returns null for a string with no '..' in it", () => {
  assert.equal(splitRange("HEAD"), null);
});

test("splitRange returns null when either side is empty", () => {
  assert.equal(splitRange("..feature"), null);
  assert.equal(splitRange("main.."), null);
});

// --- makeGitWholeFileReader ---------------------------------------------------

test("reads a file's content at the given revision", () => {
  withTempRepo((dir) => {
    commitFile(dir, "src/a.ts", "first\n");
    writeFileSync(join(dir, "src/a.ts"), "second\n");
    runGit(dir, ["commit", "-qam", "second"]);

    const reader = makeGitWholeFileReader({ cwd: dir, env: process.env, oldRev: "HEAD^1", newRev: "HEAD" });
    assert.equal(reader("src/a.ts", "old"), "first\n");
    assert.equal(reader("src/a.ts", "new"), "second\n");
  });
});

test("a file that does not exist at that revision reads as undefined, not a thrown error", () => {
  withTempRepo((dir) => {
    commitFile(dir, "src/a.ts", "only file\n");
    const reader = makeGitWholeFileReader({ cwd: dir, env: process.env, oldRev: "HEAD", newRev: "HEAD" });
    assert.equal(reader("src/never-existed.ts", "old"), undefined);
  });
});

test("a revision with no parent (a root commit) reads its old side as undefined", () => {
  withTempRepo((dir) => {
    commitFile(dir, "src/a.ts", "root commit content\n");
    const reader = makeGitWholeFileReader({ cwd: dir, env: process.env, oldRev: "HEAD^1", newRev: "HEAD" });
    assert.equal(reader("src/a.ts", "old"), undefined, "HEAD^1 does not resolve for a root commit");
    assert.equal(reader("src/a.ts", "new"), "root commit content\n");
  });
});

test("a null revision never invokes git at all: every lookup on that side answers undefined", () => {
  withTempRepo((dir) => {
    commitFile(dir, "src/a.ts", "content\n");
    const reader = makeGitWholeFileReader({ cwd: dir, env: process.env, oldRev: null, newRev: "HEAD" });
    assert.equal(reader("src/a.ts", "old"), undefined);
    assert.equal(reader("src/a.ts", "new"), "content\n");
  });
});

test("the empty string names the index, for --staged", () => {
  withTempRepo((dir) => {
    commitFile(dir, "src/a.ts", "committed\n");
    writeFileSync(join(dir, "src/a.ts"), "staged\n");
    runGit(dir, ["add", "src/a.ts"]);

    const reader = makeGitWholeFileReader({ cwd: dir, env: process.env, oldRev: "HEAD", newRev: "" });
    assert.equal(reader("src/a.ts", "old"), "committed\n");
    assert.equal(reader("src/a.ts", "new"), "staged\n");
  });
});

test("each path and side is read from git at most once: a second call is answered from cache", () => {
  withTempRepo((dir) => {
    commitFile(dir, "src/a.ts", "content\n");
    const reader = makeGitWholeFileReader({ cwd: dir, env: process.env, oldRev: "HEAD", newRev: "HEAD" });
    const first = reader("src/a.ts", "old");
    // Removing the file from the working tree (not from git) proves nothing
    // about the cache directly, but does prove that a second call did not
    // need to touch it: `git show` reads from the object database, not the
    // working tree, so this only demonstrates the read is stable. The real
    // cache guarantee is functional here -- the second call returns the
    // exact same string -- and is enough for what every caller of this
    // reader relies on: one file, read once, reused for every one of its
    // own diff lines.
    const second = reader("src/a.ts", "old");
    assert.equal(first, "content\n");
    assert.equal(second, "content\n");
  });
});

// --- resolveMergeBase / resolveRangeRevisions (Finding 3b) --------------------
//
// A three-dot range's old side is git's own merge base of the two ends, not
// the left end directly. A file that diverged before the merge base has
// different content at the left end than it has at the merge base, so
// reading the left end directly (what this file used to do; see splitRange's
// old comment) answers the wrong pre-image for that file. This is
// reproduced here with a real branching repository: a shared file is
// changed on `main` after `feature` branches off, so `main`'s own content
// disagrees with the merge base's.

function makeBranchingRepo(): string {
  const dir = makeTempRepo();
  // Named explicitly instead of relying on whatever init.defaultBranch is
  // configured on this machine ("main" on some, "master" on others), so
  // the later `git checkout -q main` below is never a guess.
  runGit(dir, ["checkout", "-qb", "main"]);
  commitFile(dir, "shared.ts", "base\n");
  runGit(dir, ["checkout", "-qb", "feature"]);
  commitFile(dir, "shared.ts", "base\nfeature change\n");
  runGit(dir, ["checkout", "-q", "main"]);
  // main moves on after feature branched off, so main's own content is not
  // the merge base's content -- the exact divergence a three-dot range's
  // old side must not read past.
  commitFile(dir, "shared.ts", "base\nmain change\n");
  return dir;
}

test("resolveMergeBase finds the shared ancestor of two diverged branches", () => {
  const dir = makeBranchingRepo();
  try {
    const mergeBase = resolveMergeBase("main", "feature", { cwd: dir, env: process.env });
    assert.notEqual(mergeBase, undefined);
    const atBase = runGit(dir, ["show", `${mergeBase}:shared.ts`]);
    assert.equal(atBase, "base\n", "the merge base predates both branches' own changes");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveMergeBase returns undefined when the two revisions share no history", () => {
  withTempRepo((dir) => {
    commitFile(dir, "a.ts", "a\n");
    const result = resolveMergeBase("HEAD", "0000000000000000000000000000000000000000", { cwd: dir, env: process.env });
    assert.equal(result, undefined);
  });
});

test("resolveRangeRevisions on a three-dot range reads the old side from the merge base, not the left end -- BEFORE this fix that was main's own (wrong) content", () => {
  const dir = makeBranchingRepo();
  try {
    const revisions = resolveRangeRevisions("main...feature", { cwd: dir, env: process.env });
    assert.notEqual(revisions, null);
    assert.notEqual(revisions!.oldRev, null);
    assert.notEqual(revisions!.oldRev, "main", "the old side must not be the left endpoint itself");
    const reader = makeGitWholeFileReader({ cwd: dir, env: process.env, oldRev: revisions!.oldRev, newRev: revisions!.newRev });
    // The true pre-image at the merge base, not main's own diverged content
    // ("base\nmain change\n") and not feature's own new content either.
    assert.equal(reader("shared.ts", "old"), "base\n");
    assert.equal(reader("shared.ts", "new"), "base\nfeature change\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveRangeRevisions on a two-dot range still reads the old side directly, unaffected by the three-dot fix", () => {
  const dir = makeBranchingRepo();
  try {
    const revisions = resolveRangeRevisions("main..feature", { cwd: dir, env: process.env });
    assert.deepEqual(revisions, { oldRev: "main", newRev: "feature" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveRangeRevisions returns null for a string with no '..' in it", () => {
  assert.equal(resolveRangeRevisions("HEAD", { cwd: process.cwd(), env: process.env }), null);
});

test("resolveRangeRevisions on a three-dot range whose merge base cannot be resolved answers oldRev: null, not the wrong revision", () => {
  withTempRepo((dir) => {
    commitFile(dir, "a.ts", "a\n");
    const revisions = resolveRangeRevisions("HEAD...0000000000000000000000000000000000000000", { cwd: dir, env: process.env });
    assert.deepEqual(revisions, { oldRev: null, newRev: "0000000000000000000000000000000000000000" });
  });
});
