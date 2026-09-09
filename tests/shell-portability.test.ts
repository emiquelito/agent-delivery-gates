// The shell scripts in this repository have to run on macOS, where /bin/bash
// is 3.2 and the userland tools are BSD, not GNU. templates/pre-commit is the
// one that matters most: `adg init` writes it into every adopting project and
// it runs on every commit there.
//
// Three things are checked here.
//
//  1. No tracked shell script carries a GNU-only tool invocation, and none
//     carries a bash 4 construct unless the script also carries a guard that
//     refuses to run under an older bash. The file list comes from
//     `git ls-files`, never a list written here, so a script added later is
//     covered without anyone remembering to add it.
//  2. scripts/scan-prose.sh does need bash 4, and its guard exits 2 with a
//     message naming bash when the running major version is below 4.
//  3. The GIT_* stripping in the two pre-commit hooks and in
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

const SCAN_PROSE = join(REPO_ROOT, "scripts", "scan-prose.sh");
const REPO_HOOK = join(REPO_ROOT, ".githooks", "pre-commit");
const TEMPLATE_HOOK = join(REPO_ROOT, "templates", "pre-commit");
const PUBLICATION_CHECK = join(REPO_ROOT, "scripts", "pre-publication-check.sh");

const GUARD_BEGIN = "# --- bash version guard: begin ---";
const GUARD_END = "# --- bash version guard: end ---";
const VERSION_SOURCE_MARKER = "adg-guard-version-source";

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
  assert.ok(paths.length >= 4, `expected several shell scripts, git listed ${paths.length}`);
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

// --- 2: the scan-prose bash 4 guard ------------------------------------------

/**
 * The guard block, lifted verbatim out of the real script.
 *
 * How this is tested, and why: BASH_VERSINFO is readonly in bash and cannot
 * be unset or reassigned, so there is no way to make a modern bash report
 * itself as 3.x, and no old bash to run under. What is done instead is to
 * take the guard's own lines out of the real file and run them, replacing
 * only the single marked line that reads the running version. Every other
 * part of the guard, the comparison, the message, and the exit code, is the
 * real text: change any of them in the script and this test moves with it.
 * The separate ordering test below covers the part this cannot, that the
 * guard runs before anything needing bash 4.
 */
function guardBlock(): string {
  const text = readFileSync(SCAN_PROSE, "utf8");
  const start = text.indexOf(GUARD_BEGIN);
  const end = text.indexOf(GUARD_END);
  assert.ok(start >= 0, `${SCAN_PROSE} has no "${GUARD_BEGIN}" marker`);
  assert.ok(end > start, `${SCAN_PROSE} has no "${GUARD_END}" marker after the begin marker`);
  return text.slice(start, end + GUARD_END.length);
}

function runGuardAt(major: number): { status: number | null; stderr: string; stdout: string } {
  const block = guardBlock();
  const lines = block.split("\n");
  const sourceLines = lines.filter((l) => l.includes(VERSION_SOURCE_MARKER) && !l.trim().startsWith("#"));
  assert.equal(
    sourceLines.length,
    1,
    `expected exactly one line marked ${VERSION_SOURCE_MARKER} in the guard, found ${sourceLines.length}`,
  );
  const script = ["#!/usr/bin/env bash", "set -euo pipefail"]
    .concat(lines.map((l) => (l === sourceLines[0] ? `bash_major=${major}` : l)))
    .concat(["echo GUARD-DID-NOT-FIRE", "exit 0"])
    .join("\n");
  const dir = mkdtempSync(join(tmpdir(), "adg-bash-guard-"));
  try {
    const path = join(dir, "guard.sh");
    writeFileSync(path, script + "\n");
    const r = spawnSync("bash", [path], { encoding: "utf8" });
    return { status: r.status, stderr: r.stderr, stdout: r.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("scan-prose's guard exits 2 and names bash when the running major version is 3", () => {
  const r = runGuardAt(3);
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}. stdout: ${r.stdout} stderr: ${r.stderr}`);
  assert.doesNotMatch(r.stdout, /GUARD-DID-NOT-FIRE/);
  assert.match(r.stderr, /\bbash\b/i);
  assert.match(r.stderr, /bash 4 or newer/i);
  // The message has to be actionable on the machine that hit it.
  assert.match(r.stderr, /brew install bash/);
});

test("scan-prose's guard also refuses bash 2, and lets bash 4 and 5 through", () => {
  assert.equal(runGuardAt(2).status, 2);
  for (const major of [4, 5]) {
    const r = runGuardAt(major);
    assert.equal(r.status, 0, `bash ${major} should be allowed: ${r.stderr}`);
    assert.match(r.stdout, /GUARD-DID-NOT-FIRE/);
  }
});

test("the guard runs before the first thing in scan-prose that needs bash 4", () => {
  const text = readFileSync(SCAN_PROSE, "utf8");
  const guardEnd = text.indexOf(GUARD_END);
  assert.ok(guardEnd > 0, "no guard end marker");
  for (const { pattern } of BASH4_CONSTRUCTS) {
    const global = new RegExp(pattern.source, "g");
    for (const m of text.matchAll(global)) {
      // The guard's own comment names the constructs it is guarding against.
      if (m.index !== undefined && m.index < guardEnd) continue;
      assert.ok(
        m.index !== undefined && m.index > guardEnd,
        `"${m[0]}" at offset ${m.index} appears before the guard finishes at ${guardEnd}`,
      );
    }
  }
});

test("scan-prose does not fire the guard under the bash this suite runs on", () => {
  // The guard must refuse an old bash without also refusing a new one.
  const r = spawnSync("bash", [SCAN_PROSE, "--rules", "/nonexistent/adg/rules.txt", "README.md"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.doesNotMatch(r.stderr, /needs bash 4 or newer/);
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
  writeExecutable(dir, "scripts/scan-prose.sh", "#!/usr/bin/env bash\nexit 0\n");
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
    writeFile(dir, "scripts/scan-prose.sh", readFileSync(SCAN_PROSE, "utf8"));
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
