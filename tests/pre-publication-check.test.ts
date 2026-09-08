// Tests for scripts/pre-publication-check.sh. The script is bash, so every
// test spawns it as a real subprocess, the way tests/scan-prose.test.ts
// spawns scripts/scan-prose.sh: stdout, stderr, and exit code are the
// contract, never an internal function's return value.
//
// Every fixture is a throwaway git repository built fresh under
// os.tmpdir(). None of this ever touches the repository this test file
// lives in.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "pre-publication-check.sh");
const REAL_SCAN_PROSE = readFileSync(join(REPO_ROOT, "scripts", "scan-prose.sh"), "utf8");

// A fictitious working-notes directory name, used only inside these throwaway
// fixtures. Never the name this project's own .gitignore actually uses: this
// file must not carry that name any more than the script it tests may.
const FIXTURE_NOTES_DIR = "scratch-notes";

// Built by concatenation, on purpose, so the raw bytes of this source file
// never carry a contiguous home-directory path. scripts/scan-prose.test.ts
// does the same thing for its own banned-word fixture, for the same reason:
// the thing under test would otherwise flag its own test file.
const HOME_SEGMENT = "/" + "home" + "/";
function fixtureHomePath(user: string): string {
  return `${HOME_SEGMENT}${user}/notes.txt`;
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCheck(cwd: string, env?: Record<string, string | undefined>): Run {
  const r = spawnSync("bash", [SCRIPT], {
    cwd,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function withTempRepo(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "adg-pre-pub-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function git(dir: string, args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}

function writeFile(dir: string, relPath: string, content: string): void {
  const full = join(dir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** Sets up a bare repo with an initial commit: a .gitignore naming the
 * fixture notes directory as its last entry, and a working copy of the real
 * prose scanner so check 8 has something to run. Nothing else is committed;
 * each test adds what it needs on top. */
function initRepo(dir: string): void {
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "fixture@example.invalid"]);
  git(dir, ["config", "user.name", "Fixture"]);
  writeFile(
    dir,
    ".gitignore",
    ["node_modules/", "", "# Scratch space for this fixture, never published.", `${FIXTURE_NOTES_DIR}/`, ""].join(
      "\n",
    ),
  );
  writeFile(dir, "scripts/scan-prose.sh", REAL_SCAN_PROSE);
  writeFile(dir, "README.md", "Nothing to see here.\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "Initial commit"]);
  execFileSync("chmod", ["+x", join(dir, "scripts", "scan-prose.sh")]);
}

function commit(dir: string, message: string, allowEmpty = true): void {
  git(dir, ["add", "-A"]);
  const args = ["commit", "-q", "-m", message];
  if (allowEmpty) args.push("--allow-empty");
  git(dir, args);
}

// A repo whose forbidden-names list is set to a word that never appears, so
// check 6 runs instead of being skipped.
const NO_SUCH_NAME = "zzz-fixture-does-not-contain-this-zzz";

// --- the clean case ----------------------------------------------------------

test("a clean fixture repository passes", () => {
  withTempRepo((dir) => {
    initRepo(dir);
    const r = runCheck(dir, { ADG_FORBIDDEN_NAMES: NO_SUCH_NAME });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /pre-publication-check: PASSED/);
  });
});

// --- check 1: notes directory history ---------------------------------------

test("a commit that added a file under the notes directory fails, even once the file is gone from the current tree", () => {
  withTempRepo((dir) => {
    initRepo(dir);
    writeFile(dir, `${FIXTURE_NOTES_DIR}/draft.md`, "working notes\n");
    git(dir, ["add", "-f", `${FIXTURE_NOTES_DIR}/draft.md`]);
    git(dir, ["commit", "-q", "-m", "Add a scratch file"]);
    // Removed again in a later commit. The check has to look at all of
    // history, not the current tree: a commit that added the file is
    // still readable at that commit even after a later commit removes it.
    git(dir, ["rm", "-q", "-f", "--ignore-unmatch", `${FIXTURE_NOTES_DIR}/draft.md`]);
    git(dir, ["commit", "-q", "-m", "Remove the scratch file again"]);
    const r = runCheck(dir, { ADG_FORBIDDEN_NAMES: NO_SUCH_NAME });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL\s+\[1\]/);
  });
});

// --- check 2: AI attribution in commit messages -----------------------------

test("a commit message with an assistant co-authored-by line fails", () => {
  withTempRepo((dir) => {
    initRepo(dir);
    writeFile(dir, "notes.md", "an ordinary change\n");
    commit(dir, "Update notes\n\nCo-Authored-By: Claude <noreply@anthropic.invalid>", false);
    const r = runCheck(dir, { ADG_FORBIDDEN_NAMES: NO_SUCH_NAME });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL\s+\[2\]/);
  });
});

// --- check 3: personal path in commit messages ------------------------------

test("a commit message with a home directory path fails", () => {
  withTempRepo((dir) => {
    initRepo(dir);
    writeFile(dir, "notes.md", "an ordinary change\n");
    commit(dir, `Fix the path bug seen at ${fixtureHomePath("fixtureuser")}`, false);
    const r = runCheck(dir, { ADG_FORBIDDEN_NAMES: NO_SUCH_NAME });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL\s+\[3\]/);
  });
});

// --- check 4: a tracked file naming the notes directory ---------------------

test("a tracked file naming the notes directory fails", () => {
  withTempRepo((dir) => {
    initRepo(dir);
    writeFile(dir, "docs/setup.md", `Working notes live under ${FIXTURE_NOTES_DIR}/ locally.\n`);
    commit(dir, "Document the local setup");
    const r = runCheck(dir, { ADG_FORBIDDEN_NAMES: NO_SUCH_NAME });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL\s+\[4\]/);
  });
});

// --- check 5: a tracked file holding a home directory path ------------------

test("a tracked file holding a home directory path fails", () => {
  withTempRepo((dir) => {
    initRepo(dir);
    writeFile(dir, "docs/setup.md", `Run it from ${fixtureHomePath("fixtureuser")}.\n`);
    commit(dir, "Document the local setup");
    const r = runCheck(dir, { ADG_FORBIDDEN_NAMES: NO_SUCH_NAME });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL\s+\[5\]/);
  });
});

// --- check 6: forbidden names -------------------------------------------------

test("a forbidden name in a tracked file fails", () => {
  withTempRepo((dir) => {
    initRepo(dir);
    const forbidden = "fixture-forbidden-word";
    writeFile(dir, "docs/setup.md", `This mentions ${forbidden} in passing.\n`);
    commit(dir, "Document the local setup");
    const r = runCheck(dir, { ADG_FORBIDDEN_NAMES: forbidden });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL\s+\[6\]/);
  });
});

test("a forbidden name that appears only in a commit message fails", () => {
  withTempRepo((dir) => {
    initRepo(dir);
    const forbidden = "fixture-forbidden-word-in-history";
    commit(dir, `A commit that mentions ${forbidden} once`);
    const r = runCheck(dir, { ADG_FORBIDDEN_NAMES: forbidden });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL\s+\[6\]/);
    assert.match(r.stdout, /cannot be removed by deleting a file/);
  });
});

test("no forbidden names configured makes the run incomplete and exits 1", () => {
  withTempRepo((dir) => {
    initRepo(dir);
    const r = runCheck(dir, { ADG_FORBIDDEN_NAMES: undefined, ADG_FORBIDDEN_NAMES_FILE: undefined });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /SKIP\s+\[6\]/);
    assert.match(r.stdout, /INCOMPLETE/);
  });
});

// --- check 7: local settings tracked -----------------------------------------

test("a tracked local settings file fails", () => {
  withTempRepo((dir) => {
    initRepo(dir);
    writeFile(dir, ".claude/settings.local.json", "{}\n");
    commit(dir, "Commit local settings by mistake");
    const r = runCheck(dir, { ADG_FORBIDDEN_NAMES: NO_SUCH_NAME });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL\s+\[7\]/);
  });
});

// --- running from a subfolder -------------------------------------------------

test("running from a subfolder gives the same answer", () => {
  withTempRepo((dir) => {
    initRepo(dir);
    writeFile(dir, "docs/setup.md", `Working notes live under ${FIXTURE_NOTES_DIR}/ locally.\n`);
    commit(dir, "Document the local setup");
    const sub = join(dir, "docs");
    const r = runCheck(sub, { ADG_FORBIDDEN_NAMES: NO_SUCH_NAME });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL\s+\[4\]/);
  });
});

// --- not a git repository ------------------------------------------------------

test("a directory that is not a git repository exits 2", () => {
  withTempRepo((dir) => {
    const r = runCheck(dir, { ADG_FORBIDDEN_NAMES: NO_SUCH_NAME });
    assert.equal(r.status, 2);
  });
});

// The names file is written by a person, so it needs the things a person
// writes: notes to themselves, and blank lines. Treating a note as a name to
// search for turns the check into noise.
test("a comment line in the names file is not treated as a name", () => {
  withTempRepo((dir) => {
    initRepo(dir);
    const namesFile = join(dir, "..", "names-with-comment.txt");
    writeFileSync(namesFile, "# a note to myself\n\nzzznotpresentzzz\n");
    try {
      const r = runCheck(dir, { ADG_FORBIDDEN_NAMES_FILE: namesFile });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /checked 1 name/);
    } finally {
      rmSync(namesFile, { force: true });
    }
  });
});

// Being asked to read a file that is not there is not a failed check. It is
// the script unable to do what it was asked, which is a different exit code
// and must never look like either a pass or a clean fail.
test("a names file that cannot be read exits 2", () => {
  withTempRepo((dir) => {
    initRepo(dir);
    const r = runCheck(dir, { ADG_FORBIDDEN_NAMES_FILE: join(dir, "..", "absent-names.txt") });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /cannot read/);
  });
});
