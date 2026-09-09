// Tests for the containment checks that compare a path against a root.
//
// Every one of these builds a real directory, a real symlink beside it, and
// runs the real command from the symlinked path. Nothing here fakes a
// resolver: the defect being pinned is that two halves of one comparison
// were written in different alphabets, one with symlinks resolved and one
// without, and only a real symlink on a real filesystem can tell the two
// apart. `git rev-parse --show-toplevel` hands back the root with its
// symlinks already resolved, so a caller who names a file through a link
// had a file inside the repository refused as outside it. On macOS that is
// every scratch repository, since /tmp and /var/folders are links into
// /private.
//
// The other half of the point is that resolving is not loosening. A symlink
// inside a root that points out of it resolves to a real path outside the
// real root and stays refused, and there are tests below for that in both
// the existing and the not-yet-created case.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { makeFileTextReader } from "../src/repo-file-reader.ts";
import { isInsideSystemTemp, resolveWithinRoot } from "../src/path-allowlist.ts";
import { runInit } from "../src/init.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, "..");
const MUTATE_CLI = join(PACKAGE_ROOT, "hooks", "mutate.ts");

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runMutate(cwd: string, args: string[]): RunResult {
  const result = spawnSync("node", [MUTATE_CLI, ...args], { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

const SOURCE = `export function pick(a, b) {
  if (a > b) return a;
  return b;
}
`;

/**
 * Builds a committed git repository and a symlink pointing at it, and
 * returns both names for the same tree plus a directory outside it.
 *
 * The temp directory is passed through realpathSync first, so the "real"
 * name here is really link-free even on a machine whose temp directory
 * is itself a symlink. Otherwise a test could pass on Linux for the wrong
 * reason and say nothing about the case it exists for.
 */
function buildSymlinkedRepo(): { real: string; linked: string; outside: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "adg-symlink-")));
  const real = join(base, "realrepo");
  const linked = join(base, "linkrepo");
  const outside = join(base, "outside");
  mkdirSync(join(real, "src"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(real, "src", "pick.mjs"), SOURCE);
  writeFileSync(join(outside, "loot.mjs"), SOURCE);
  git(real, ["init", "-q", "."]);
  git(real, ["config", "user.email", "t@example.invalid"]);
  git(real, ["config", "user.name", "Test"]);
  git(real, ["add", "-A"]);
  git(real, ["commit", "-qm", "base"]);
  symlinkSync(real, linked);
  return { real, linked, outside };
}

// --- mutate --paths ----------------------------------------------------------

test("mutate accepts a file named through a symlinked repository path", () => {
  const { real, linked } = buildSymlinkedRepo();
  // Proof the two halves really do disagree as strings: this is the exact
  // condition the defect needed, asserted and not assumed.
  const toplevel = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: linked, encoding: "utf8" });
  assert.equal(toplevel.stdout.trim(), real);

  const result = runMutate(linked, ["--paths", join(linked, "src", "pick.mjs"), "--command", "true"]);
  assert.doesNotMatch(result.stderr, /outside the repository/);
  // Every mutation survives against `true`, which exits 1. What matters is
  // that the file was read and mutated at all.
  assert.equal(result.status, 1);
  assert.match(result.stdout, /src\/pick\.mjs/);
});

test("mutate still refuses a symlink inside the repository that points outside it", () => {
  const { real, linked, outside } = buildSymlinkedRepo();
  symlinkSync(join(outside, "loot.mjs"), join(real, "src", "escape.mjs"));
  git(real, ["add", "-A"]);
  git(real, ["commit", "-qm", "add the link"]);

  const result = runMutate(linked, ["--paths", join(linked, "src", "escape.mjs"), "--command", "true"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /outside the repository/);
  // The file the link points at is untouched: the refusal happened before
  // anything was written, which is the only thing that makes it a refusal.
  assert.equal(readFileSync(join(outside, "loot.mjs"), "utf8"), SOURCE);
});

test("mutate still refuses a path outside the repository, existing and not", () => {
  const { linked, outside } = buildSymlinkedRepo();

  const existing = runMutate(linked, ["--paths", join(outside, "loot.mjs"), "--command", "true"]);
  assert.equal(existing.status, 2);
  assert.match(existing.stderr, /outside the repository/);

  const pending = runMutate(linked, ["--paths", join(outside, "not-yet.mjs"), "--command", "true"]);
  assert.equal(pending.status, 2);
  assert.match(pending.stderr, /outside the repository/);
});

// --- the repository file reader ----------------------------------------------

test("the file reader accepts a file inside a repository named through a link", () => {
  const { real, linked } = buildSymlinkedRepo();
  writeFileSync(join(real, "src", "marked.mjs"), "// marked\n");

  // The root as git reports it, the candidate as a caller reached it. This
  // is the pairing that broke.
  const readByLink = makeFileTextReader(real);
  assert.equal(readByLink(join(linked, "src", "marked.mjs")), "// marked\n");

  // And the other way round: hooks/test-diff-separator.ts falls back to
  // process.cwd() when git cannot answer, which carries whatever links the
  // caller arrived through, while the candidate may be link-free.
  const readByReal = makeFileTextReader(linked);
  assert.equal(readByReal(join(real, "src", "marked.mjs")), "// marked\n");
});

test("the file reader still refuses a link out of the repository and a path outside it", () => {
  const { real, linked, outside } = buildSymlinkedRepo();
  writeFileSync(join(outside, "secret.txt"), "not yours\n");
  symlinkSync(join(outside, "secret.txt"), join(real, "src", "escape.txt"));

  const read = makeFileTextReader(real);
  assert.equal(read(join(linked, "src", "escape.txt")), undefined);
  assert.equal(read(join(outside, "secret.txt")), undefined);
  assert.equal(read("../outside/secret.txt"), undefined);
});

// --- init --dir ---------------------------------------------------------------

test("init writes into a target directory named through a symlink", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "adg-symlink-init-")));
  const real = join(base, "project");
  const linked = join(base, "projectlink");
  mkdirSync(real, { recursive: true });
  symlinkSync(real, linked);

  const outcome = runInit({ targetDir: linked, packageRoot: PACKAGE_ROOT, dryRun: false, force: false });
  assert.equal(outcome.exitCode, 0);
  // The files a caller would look for, at the real location, not only a
  // clean exit code.
  assert.equal(existsSync(join(real, "AGENTS.md")), true);
  assert.equal(existsSync(join(real, ".githooks", "pre-commit")), true);
});

test("init still refuses to write through a directory that links out of the target", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "adg-symlink-init-deny-")));
  const target = join(base, "project");
  const elsewhere = join(base, "elsewhere");
  mkdirSync(target, { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
  // .githooks/pre-commit is one of the files init writes. Point .githooks
  // at a directory outside the target and the write must not follow it.
  symlinkSync(elsewhere, join(target, ".githooks"));

  assert.throws(
    () => runInit({ targetDir: target, packageRoot: PACKAGE_ROOT, dryRun: false, force: false }),
    /refusing to write outside the target directory/,
  );
  assert.equal(existsSync(join(elsewhere, "pre-commit")), false);
});

// --- the shared helper, on its own --------------------------------------------

test("a not-yet-created path inside the root is accepted, outside it is refused", () => {
  const { real, linked, outside } = buildSymlinkedRepo();

  const inside = resolveWithinRoot(real, join(linked, "src", "new-file.mjs"), realpathSync, real);
  assert.equal(inside.contained, true);
  assert.equal(inside.realPath, join(real, "src", "new-file.mjs"));

  const beyond = resolveWithinRoot(real, join(outside, "new-file.mjs"), realpathSync, real);
  assert.equal(beyond.contained, false);

  // A path that does not exist yet whose parent links out of the root: the
  // parent is what resolves, so the whole thing lands outside.
  symlinkSync(outside, join(real, "src", "away"));
  const throughLink = resolveWithinRoot(real, join(linked, "src", "away", "new-file.mjs"), realpathSync, real);
  assert.equal(throughLink.contained, false);
});

test("a sibling directory whose name starts with the root's name is not inside it", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "adg-symlink-sibling-")));
  const root = join(base, "repo");
  const sibling = join(base, "repo-evil");
  mkdirSync(root, { recursive: true });
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(sibling, "f.txt"), "x\n");

  const decision = resolveWithinRoot(root, join(sibling, "f.txt"), realpathSync, base);
  assert.equal(decision.contained, false);
});

// --- census's temporary worktree check ----------------------------------------

test("census's worktree check refuses anything outside the system temp directory", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "adg-symlink-temp-")));
  // The directory a run actually makes: inside the temp directory, accepted.
  assert.equal(isInsideSystemTemp(base, tmpdir(), realpathSync, process.cwd()), true);

  // The temp directory itself: refused. A removal aimed at the whole temp
  // directory is never what was meant.
  assert.equal(isInsideSystemTemp(tmpdir(), tmpdir(), realpathSync, process.cwd()), false);

  // A directory that is not under the temp directory at all: refused.
  assert.equal(isInsideSystemTemp(homedir(), tmpdir(), realpathSync, process.cwd()), false);

  // A name under the temp directory that links out of it: still refused,
  // which is the half resolving must not give away.
  const link = join(base, "escape");
  symlinkSync(homedir(), link);
  assert.equal(isInsideSystemTemp(link, tmpdir(), realpathSync, process.cwd()), false);
});

test("census removes its worktree and leaves the repository alone, from a symlinked path", () => {
  const { real, linked } = buildSymlinkedRepo();
  const censusCli = join(PACKAGE_ROOT, "hooks", "census.ts");
  const result = spawnSync("node", [censusCli, "--base", "HEAD", "--command", "true"], {
    cwd: linked,
    encoding: "utf8",
  });
  // Whatever verdict it reached, it must not have refused its own temporary
  // worktree as being outside the temp directory, and the repository it was
  // pointed at is still there.
  assert.doesNotMatch(result.stderr, /not inside the system temp directory/);
  assert.equal(existsSync(join(real, "src", "pick.mjs")), true);
});
