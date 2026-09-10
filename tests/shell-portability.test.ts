// The shell scripts in this repository have to run on macOS, where /bin/bash
// is 3.2 and the userland tools are BSD, not GNU. templates/pre-commit is the
// one that matters most: `adg init` writes it into every adopting project and
// it runs on every commit there.
//
// Two things are checked here.
//
//  1. No tracked shell script carries a GNU-only tool invocation, and none
//     carries a bash 4 construct unless the script also carries a guard that
//     refuses to run under an older bash. The file list comes from
//     `git ls-files`, never a list written here, so a script added later is
//     covered without anyone remembering to add it. No tracked script needs
//     that guarded exemption today: the one script that did was the prose
//     scan, and the prose scan is a Node program now, so both scans below
//     pass with nothing to report. That is the point of them.
//  2. The GIT_* stripping in the two pre-commit hooks and in
//     scripts/pre-publication-check.sh still works after `env -0` was
//     replaced by `compgen -v GIT_`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");

const REPO_HOOK = join(REPO_ROOT, ".githooks", "pre-commit");
const TEMPLATE_HOOK = join(REPO_ROOT, "templates", "pre-commit");
const PUBLICATION_CHECK = join(REPO_ROOT, "scripts", "pre-publication-check.sh");

// The markers a script would have to carry to earn the right to use a bash 4
// construct. No tracked script carries them today; the constants stay so the
// exemption stays checkable if one ever does.
const GUARD_BEGIN = "# --- bash version guard: begin ---";
const GUARD_END = "# --- bash version guard: end ---";

// --- 1: no non-portable construct in any tracked shell script ---------------

/** Every tracked file that is run by bash. Taken from git, not from a list
 * written here, so a script added later cannot slip past by not being
 * mentioned. */
function trackedShellScripts(): string[] {
  const out = execFileSync("git", ["ls-files", "-z", "--", "*.sh", ".githooks/*", "templates/pre-commit"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const paths = out.split("\0").filter((p) => p.length > 0);
  // Named, not just counted: a list that came back short because the glob
  // stopped matching would otherwise pass both scans below by looking at
  // nothing. These three are the shell this repository still has.
  for (const expected of [".githooks/pre-commit", "templates/pre-commit", "scripts/pre-publication-check.sh"]) {
    assert.ok(paths.includes(expected), `git did not list ${expected}; it listed ${paths.join(", ")}`);
  }
  return paths;
}

interface Construct {
  /** What to look for. */
  pattern: RegExp;
  /** What a reader has to do about it. */
  why: string;
}

/** GNU-only tool invocations. Banned outright: the bash version guard says
 * nothing about which userland tools are installed, so no guard excuses
 * these. */
const GNU_CONSTRUCTS: Construct[] = [
  { pattern: /\benv\s+-0\b/, why: "env -0 is GNU only; BSD env has no -0. Use compgen -v to read variable names." },
  { pattern: /\breadlink\s+(-[A-Za-z]*\s+)*-[A-Za-z]*f\b/, why: "readlink -f is GNU only; BSD readlink has no -f." },
  { pattern: /\bgrep\s+(-[A-Za-z]*\s+)*-[A-Za-z]*P\b/, why: "grep -P is GNU only; BSD grep has no -P." },
  { pattern: /\bsed\s+(-[A-Za-z]*\s+)*-[A-Za-z]*i\s/, why: "sed -i takes a mandatory argument on BSD and none on GNU." },
  { pattern: /\bdate\s+(-[A-Za-z]*\s+)*-[A-Za-z]*d\b/, why: "date -d is GNU only; BSD date uses -v and -j -f." },
];

/** bash 4 constructs. Allowed only in a script that refuses to run under an
 * older bash, because there the reader gets a clear message instead of a
 * syntax error or a wrong answer. */
const BASH4_CONSTRUCTS: Construct[] = [
  { pattern: /\b(mapfile|readarray)\b/, why: "mapfile/readarray arrived in bash 4." },
  { pattern: /\b(declare|local|typeset)\s+(-[A-Za-z]*\s+)*-[A-Za-z]*A\b/, why: "associative arrays arrived in bash 4." },
  { pattern: /\$\{[^{}]*(,,|\^\^)[^{}]*\}/, why: "${x,,} and ${x^^} case folding arrived in bash 4." },
];

/** True when the script stops with a clear message under a bash older than
 * 4, which is what earns it the right to use a bash 4 construct. */
function hasBashVersionGuard(text: string): boolean {
  return text.includes(GUARD_BEGIN) && text.includes(GUARD_END) && text.includes("BASH_VERSINFO");
}

function offendingLines(text: string, pattern: RegExp): string[] {
  return text
    .split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => pattern.test(line))
    .map(({ line, n }) => `${n}: ${line.trim()}`);
}

/** A known-bad line for every construct above. A pattern list that got
 * emptied, or a pattern edited until it matches nothing, passes the two scans
 * below by looking at nothing at all; this table is what stops that. Each
 * entry has to be matched by the list it belongs to, and each list has to be
 * the length recorded here. */
const KNOWN_BAD_GNU = [
  "done < <(env -0)",
  'target=$(readlink -f "$path")',
  'grep -P "\\d+" "$file"',
  "sed -i 's/a/b/' file.txt",
  'date -d "2020-01-01" +%s',
];

const KNOWN_BAD_BASH4 = [
  "  mapfile -d '' -t rel <\"$tmpd/list\"",
  "declare -A counts=()",
  'case "${1,,}" in',
];

test("the construct lists are not empty and every pattern matches a known-bad line", () => {
  assert.equal(GNU_CONSTRUCTS.length, KNOWN_BAD_GNU.length);
  assert.equal(BASH4_CONSTRUCTS.length, KNOWN_BAD_BASH4.length);
  for (const [i, sample] of KNOWN_BAD_GNU.entries()) {
    assert.ok(
      GNU_CONSTRUCTS.some(({ pattern }) => pattern.test(sample)),
      `no GNU pattern matches known-bad line ${i}: ${sample}`,
    );
  }
  for (const [i, sample] of KNOWN_BAD_BASH4.entries()) {
    assert.ok(
      BASH4_CONSTRUCTS.some(({ pattern }) => pattern.test(sample)),
      `no bash 4 pattern matches known-bad line ${i}: ${sample}`,
    );
  }
  // And nothing in either list may match an ordinary, portable line.
  for (const good of ['git grep -InF -- "$name"', 'sed -e "s/a/b/" file', "printf '%s' \"$x\"", "date +%s"]) {
    for (const { pattern } of [...GNU_CONSTRUCTS, ...BASH4_CONSTRUCTS]) {
      assert.equal(pattern.test(good), false, `${pattern} wrongly matches the portable line: ${good}`);
    }
  }
});

test("no tracked shell script uses a GNU-only tool invocation", () => {
  const failures: string[] = [];
  for (const rel of trackedShellScripts()) {
    const text = readFileSync(join(REPO_ROOT, rel), "utf8");
    for (const { pattern, why } of GNU_CONSTRUCTS) {
      for (const hit of offendingLines(text, pattern)) {
        failures.push(`${rel}:${hit}  --  ${why}`);
      }
    }
  }
  assert.deepEqual(failures, [], `macOS ships BSD userland tools:\n${failures.join("\n")}`);
});

test("no tracked shell script uses a bash 4 construct without a version guard", () => {
  const failures: string[] = [];
  for (const rel of trackedShellScripts()) {
    const text = readFileSync(join(REPO_ROOT, rel), "utf8");
    if (hasBashVersionGuard(text)) continue;
    for (const { pattern, why } of BASH4_CONSTRUCTS) {
      for (const hit of offendingLines(text, pattern)) {
        failures.push(`${rel}:${hit}  --  ${why}`);
      }
    }
  }
  assert.deepEqual(failures, [], `macOS ships bash 3.2 as /bin/bash:\n${failures.join("\n")}`);
});

test("the two pre-commit hooks and the publication check carry no bash 4 construct at all", () => {
  // These three are the scripts a person on a Mac runs without being asked to
  // install anything, so the guarded exemption above must not apply to them.
  // Checked by name on purpose: this is the claim that these specific files
  // stay runnable under the system bash.
  for (const path of [REPO_HOOK, TEMPLATE_HOOK, PUBLICATION_CHECK]) {
    const text = readFileSync(path, "utf8");
    assert.equal(hasBashVersionGuard(text), false, `${path} should not need a bash 4 guard`);
    for (const { pattern, why } of [...GNU_CONSTRUCTS, ...BASH4_CONSTRUCTS]) {
      assert.deepEqual(offendingLines(text, pattern), [], `${path}: ${why}`);
    }
  }
});

// --- 3: the GIT_* stripping still works --------------------------------------

function git(dir: string, args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}

function writeFile(dir: string, relPath: string, content: string): void {
  const full = join(dir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function writeExecutable(dir: string, relPath: string, content: string): void {
  writeFile(dir, relPath, content);
  execFileSync("chmod", ["+x", join(dir, relPath)]);
  // See the matching comment in tests/precommit-hook.test.ts: without a
  // `.cmd` shim beside it, this stub is invisible to `npx tsc` on Windows,
  // which then runs whichever real `tsc` is next on PATH instead.
  if (process.platform === "win32") {
    writeFile(dir, `${relPath}.cmd`, `@echo off\r\nbash "%~dpn0" %*\r\n`);
  }
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "adg-git-strip-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A repository the .githooks/pre-commit hook can run to completion in, with
 * a stand-in for each of the four tools it shells out to. `tscExit` is what
 * the first step returns, which is how a decoy repository is told apart from
 * the real one in the test below. */
function buildHookRepo(dir: string, tscExit: number): void {
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "fixture@example.invalid"]);
  git(dir, ["config", "user.name", "Fixture"]);
  writeExecutable(dir, "node_modules/.bin/tsc", `#!/usr/bin/env bash\nexit ${tscExit}\n`);
  writeFile(
    dir,
    "package.json",
    JSON.stringify({ name: "fixture", private: true, scripts: { test: 'node -e "process.exit(0)"' } }, null, 2),
  );
  writeFile(dir, "hooks/scan-prose.ts", "process.exit(0);\n");
  writeFile(dir, "scripts/tally-report.ts", "process.exit(0);\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "Fixture commit"]);
}

test("the pre-commit hook ignores a GIT_DIR pointing at a path that does not exist", () => {
  withTempDir((dir) => {
    buildHookRepo(dir, 0);
    const r = spawnSync("bash", [REPO_HOOK], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GIT_DIR: "/nonexistent/adg/decoy.git" },
    });
    assert.equal(r.status, 0, `hook should have found the real repository: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /all checks passed/);
  });
});

test("the pre-commit hook resolves the repository it is run in, not one GIT_DIR and GIT_WORK_TREE point at", () => {
  // A decoy that is a real repository, so the failure mode under test is
  // "resolved the wrong tree" and not "git could not run at all". Its
  // typecheck stub exits 1, so a hook that followed GIT_DIR reports a
  // typecheck failure the real repository would never produce.
  withTempDir((real) => {
    withTempDir((decoy) => {
      buildHookRepo(real, 0);
      buildHookRepo(decoy, 1);
      const r = spawnSync("bash", [REPO_HOOK], {
        cwd: real,
        encoding: "utf8",
        env: { ...process.env, GIT_DIR: join(decoy, ".git"), GIT_WORK_TREE: decoy },
      });
      assert.equal(r.status, 0, `hook followed the decoy: ${r.stdout}${r.stderr}`);
      assert.match(r.stdout, /all checks passed/);
      assert.doesNotMatch(r.stdout + r.stderr, /FAILED at: typecheck/);
    });
  });
});

test("the publication check ignores a GIT_DIR pointing at a path that does not exist", () => {
  withTempDir((dir) => {
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.email", "fixture@example.invalid"]);
    git(dir, ["config", "user.name", "Fixture"]);
    writeFile(dir, ".gitignore", "node_modules/\nadg-fixture-notes/\n");
    writeFile(dir, "hooks/scan-prose.ts", readFileSync(join(REPO_ROOT, "hooks", "scan-prose.ts"), "utf8"));
    writeFile(dir, "src/prose-scan.ts", readFileSync(join(REPO_ROOT, "src", "prose-scan.ts"), "utf8"));
    writeFile(dir, "README.md", "Nothing to see here.\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "Fixture commit"]);
    const r = spawnSync("bash", [PUBLICATION_CHECK], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GIT_DIR: "/nonexistent/adg/decoy.git", GIT_WORK_TREE: "/nonexistent/adg/tree" },
    });
    // The root it prints is the proof: it resolved the directory it was run
    // in and not whatever GIT_DIR named.
    assert.match(r.stdout, /pre-publication-check: repository root /, r.stdout + r.stderr);
    const printed = /repository root (.*)/.exec(r.stdout)?.[1] ?? "";
    const resolved = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8" }).trim();
    assert.equal(printed, resolved);
    assert.doesNotMatch(r.stderr, /not a git repository/);
  });
});
