// Tests for .githooks/pre-commit. The hook is bash, so every test spawns it
// as a real subprocess, the way tests/prose-scan-cli.test.ts spawns the prose
// scan: stdout, stderr, and exit code are the contract.
//
// The hook shells out to real tools (npx tsc, npm test,
// node hooks/scan-prose.ts, node scripts/tally-report.ts), so each fixture
// repo carries its own stand-in
// for every one of them, with an exit code the test controls. This keeps the
// tests fast and independent of this repository's own toolchain, and lets a
// test target exactly one step without the others' real behaviour getting in
// the way.
//
// Every fixture is a throwaway git repository built fresh under
// os.tmpdir(). None of this ever touches the repository this test file
// lives in.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const HOOK = join(REPO_ROOT, ".githooks", "pre-commit");

interface Run {
  status: number | null;
  stdout: string;
  all: string;
  stderr: string;
}

function runHook(cwd: string, env?: Record<string, string | undefined>): Run {
  const r = spawnSync("bash", [HOOK], {
    cwd,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  });
  // The failure banner goes to stderr, the progress lines to stdout, so a
  // test that reads only one of them misses half the contract.
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, all: r.stdout + r.stderr };
}

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
  chmodSync(join(dir, relPath), 0o755);
  // A real `npm install` leaves a matching `.cmd` shim beside a POSIX
  // shebang script so Windows' own process creation, which cannot run a
  // bare extensionless file no matter what its first line says, has
  // something to invoke. `npx tsc` here is finding this stub through the
  // same lookup a real install would use, so without the shim it resolves
  // to nothing local on Windows and falls through to whatever real `tsc`
  // is next on PATH instead -- the fixture's stub was never seen at all.
  //
  // The shim itself shells out to `bash`, which assumes bash is on PATH.
  // True on GitHub's windows-latest runners (Git for Windows ships one and
  // puts it there); not stated, and not guaranteed, anywhere else this
  // suite might run on Windows.
  if (process.platform === "win32") {
    writeFile(dir, `${relPath}.cmd`, `@echo off\r\nbash "%~dpn0" %*\r\n`);
  }
}

interface StepExit {
  tsc?: number;
  test?: number;
  scanProse?: number;
  tally?: number;
}

/** Builds a fixture repository carrying a stand-in for every tool the hook
 * shells out to, each exiting with the given code (0 by default: every step
 * passes unless a test says otherwise). */
function buildFixture(dir: string, exits: StepExit = {}): void {
  const { tsc = 0, test = 0, scanProse = 0, tally = 0 } = exits;
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "fixture@example.invalid"]);
  git(dir, ["config", "user.name", "Fixture"]);

  // npx resolves a local node_modules/.bin entry without touching the
  // network, so this stands in for the real tsc without installing it.
  writeExecutable(
    dir,
    "node_modules/.bin/tsc",
    `#!/usr/bin/env bash\necho "stub tsc ran"\nexit ${tsc}\n`,
  );

  writeFile(
    dir,
    "package.json",
    JSON.stringify(
      {
        name: "fixture",
        private: true,
        scripts: {
          test: `node -e "process.exit(${test})"`,
        },
      },
      null,
      2,
    ),
  );

  writeFile(
    dir,
    "hooks/scan-prose.ts",
    `process.stdout.write("stub scan-prose ran\\n");\nprocess.exit(${scanProse});\n`,
  );

  writeFile(dir, "scripts/tally-report.ts", `process.stdout.write("stub tally ran\\n");\nprocess.exit(${tally});\n`);

  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "Fixture commit"]);
}

function withTempRepo(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "adg-precommit-hook-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// .githooks/pre-commit is bash, run here with `spawnSync("bash", [HOOK], ...)`
// (see runHook above), so every test in this file is a POSIX maintainer-tool
// test: it exercises a hook the project's own Linux/macOS contributors run,
// never something a Windows user's own workflow invokes. bash is not on PATH
// on a plain Windows machine (see the comment on writeExecutable above), so
// these are skipped there instead of ported.
const HOOK_SKIP =
  process.platform === "win32"
    ? "spawns .githooks/pre-commit through bash, a POSIX maintainer tool, not something a Windows user runs"
    : false;

test("all steps passing exits 0", { skip: HOOK_SKIP }, () => {
  withTempRepo((dir) => {
    buildFixture(dir);
    const r = runHook(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /all checks passed/);
  });
});

test("the hook exits non-zero when a check fails, and names it with the command to run it alone", { skip: HOOK_SKIP }, () => {
  withTempRepo((dir) => {
    buildFixture(dir, { test: 1 });
    const r = runHook(dir);
    assert.equal(r.status, 1);
    assert.match(r.all, /FAILED at: tests/);
    assert.match(r.all, /npm test/);
  });
});

test("a failure at an earlier step stops before a later step runs", { skip: HOOK_SKIP }, () => {
  withTempRepo((dir) => {
    buildFixture(dir, { test: 1, scanProse: 1 });
    const r = runHook(dir);
    assert.equal(r.status, 1);
    // A step that passes prints nothing of its own, so the proof that a
    // later step never ran is that its name never appears.
    assert.match(r.all, /FAILED at: tests/);
    assert.doesNotMatch(r.all, /prose scan/);
  });
});

test("a failure at the prose scan step is named correctly", { skip: HOOK_SKIP }, () => {
  withTempRepo((dir) => {
    buildFixture(dir, { scanProse: 1 });
    const r = runHook(dir);
    assert.equal(r.status, 1);
    assert.match(r.all, /FAILED at: prose scan/);
    assert.match(r.all, /hooks\/scan-prose\.ts/);
  });
});

test("a failure at the tally step is named correctly", { skip: HOOK_SKIP }, () => {
  withTempRepo((dir) => {
    buildFixture(dir, { tally: 1 });
    const r = runHook(dir);
    assert.equal(r.status, 1);
    assert.match(r.all, /FAILED at: tally check/);
    assert.match(r.all, /tally-report\.ts --check/);
  });
});

test("ADG_SKIP_PRECOMMIT skips the hook and prints loudly", { skip: HOOK_SKIP }, () => {
  withTempRepo((dir) => {
    // Every step would fail if it ran, so a status-0 result here can only
    // mean the skip took effect, not that the checks happened to pass.
    buildFixture(dir, { tsc: 1, test: 1, scanProse: 1, tally: 1 });
    const r = runHook(dir, { ADG_SKIP_PRECOMMIT: "1" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /SKIPPED/);
    assert.doesNotMatch(r.stdout, /stub tsc ran/);
  });
});

// ---------------------------------------------------------------------------
// templates/pre-commit: the hook `init` writes into other people's projects.
// It skips a step it has nothing to run for. The defect these tests pin: it
// skipped the test step in a Go repository that had failing tests, said "no
// test suite configured yet", and closed with "passed". A skipped step must
// never read as a passing one.
// ---------------------------------------------------------------------------

const TEMPLATE_HOOK = join(REPO_ROOT, "templates", "pre-commit");

function runTemplate(cwd: string): Run {
  const r = spawnSync("bash", [TEMPLATE_HOOK], { cwd, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, all: r.stdout + r.stderr };
}

/** A repository with the package stub the template's first check needs and
 * nothing else the hook could run. `files` are committed as given. */
function buildBareProject(dir: string, files: Record<string, string>): void {
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "fixture@example.invalid"]);
  git(dir, ["config", "user.name", "Fixture"]);
  writeExecutable(dir, "node_modules/.bin/agent-delivery-gates", `#!/usr/bin/env bash\necho 0.0.0\n`);
  for (const [path, content] of Object.entries(files)) writeFile(dir, path, content);
  git(dir, ["add", "-A", "-f"]);
  git(dir, ["commit", "-q", "-m", "Fixture commit"]);
}

const FAILING_GO_TEST = 'package x\nimport "testing"\nfunc TestF(t *testing.T) { t.Fatal("fails") }\n';

test("template: a Go repository with failing tests and no test script is not reported as passing", { skip: HOOK_SKIP }, () => {
  // The state a user reaches after following the install instructions:
  // `npm install` leaves a package.json with no scripts in a Go repository.
  withTempRepo((dir) => {
    buildBareProject(dir, {
      "go.mod": "module x\n",
      "a_test.go": FAILING_GO_TEST,
      "b_test.go": FAILING_GO_TEST,
      "package.json": JSON.stringify({ name: "x" }),
    });
    const r = runTemplate(dir);
    assert.equal(r.status, 0, "loud but allowing: the commit is not blocked");
    assert.doesNotMatch(r.all, /passed/, "no skipped step may be reported as a pass");
    assert.match(r.all, /THE TESTS DID NOT RUN/);
    assert.match(r.all, /go\.mod/);
    assert.match(r.all, /2 \*_test\.go files/);
    assert.match(r.all, /NOT RUN: .*tests/);
    assert.doesNotMatch(r.all, /no test suite/, "must not claim the project has no tests");
  });
});

test("template: the same Go repository with no package.json at all reports the same", { skip: HOOK_SKIP }, () => {
  withTempRepo((dir) => {
    buildBareProject(dir, { "go.mod": "module x\n", "a_test.go": FAILING_GO_TEST });
    const r = runTemplate(dir);
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.all, /passed/);
    assert.match(r.all, /THE TESTS DID NOT RUN/);
  });
});

test("template: a project with no tests at all still commits, and still says the tests did not run", { skip: HOOK_SKIP }, () => {
  withTempRepo((dir) => {
    buildBareProject(dir, { "README.md": "hello\n", "package.json": JSON.stringify({ name: "x" }) });
    const r = runTemplate(dir);
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.all, /passed/);
    assert.doesNotMatch(r.all, /THE TESTS DID NOT RUN/, "no banner when there is nothing to warn about");
    assert.match(r.all, /tests -- NOT RUN/);
  });
});

test("template: when every step runs the closing line says all checks passed", { skip: HOOK_SKIP }, () => {
  withTempRepo((dir) => {
    buildBareProject(dir, {
      "tsconfig.json": "{}\n",
      "node_modules/.bin/tsc": "#!/usr/bin/env bash\nexit 0\n",
      "package.json": JSON.stringify({ name: "x", scripts: { test: 'node -e "process.exit(0)"' } }),
      ".adg/prose-rules.txt": "x\n",
      "docs/gate-tally.md": "x\n",
    });
    chmodSync(join(dir, "node_modules/.bin/tsc"), 0o755);
    const r = runTemplate(dir);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /all checks passed/);
    assert.doesNotMatch(r.all, /NOT RUN/);
  });
});

test("template: a failing test script still blocks the commit", { skip: HOOK_SKIP }, () => {
  withTempRepo((dir) => {
    buildBareProject(dir, {
      "package.json": JSON.stringify({ name: "x", scripts: { test: 'node -e "process.exit(1)"' } }),
    });
    const r = runTemplate(dir);
    assert.equal(r.status, 1);
    assert.match(r.all, /FAILED at: tests/);
  });
});
