// Tests for hooks/census.ts. Every test builds a real git repository in
// os.tmpdir() with a real, tiny test suite, spawns the CLI as a real
// subprocess, and asserts what a caller can actually see: the exit code,
// the printed report, and what is left on disk afterwards. Nothing here
// touches this repository's own tree.
//
// This command adds a git worktree and runs a suite two or three times, so
// the tests have to watch it do both against real repositories. Mocking
// either one would leave the two failures that matter most untested: a
// worktree left behind, and a base run that could not start being read as
// every test disappearing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(HERE, "..", "hooks", "census.ts");
const SUITE = "node --test tests/*.test.mjs";

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(cwd: string, args: string[], env: Record<string, string> = {}): RunResult {
  const result = spawnSync("node", [CLI_PATH, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runGit(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

function write(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

/** A repository with a first commit holding `base`, and a second commit
 * holding `head` written over it. Files named in `head` with a null value
 * are deleted by the second commit. */
function makeRepo(base: Record<string, string>, head: Record<string, string | null> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "adg-census-cli-test-"));
  runGit(dir, ["init", "-q", "-b", "work"]);
  runGit(dir, ["config", "user.email", "test@example.invalid"]);
  runGit(dir, ["config", "user.name", "Test"]);
  write(dir, base);
  runGit(dir, ["add", "."]);
  runGit(dir, ["commit", "-q", "-m", "first"]);
  if (Object.keys(head).length > 0) {
    for (const [path, content] of Object.entries(head)) {
      if (content === null) rmSync(join(dir, path));
      else write(dir, { [path]: content });
    }
    runGit(dir, ["add", "-A"]);
    runGit(dir, ["commit", "-q", "-m", "second"]);
  }
  return dir;
}

/** Every temporary directory this command could have left behind. */
function leftoverWorktrees(): string[] {
  return readdirSync(tmpdir()).filter(
    (entry) => entry.startsWith("adg-census-") && !entry.includes("cli-test") && !entry.includes("flake"),
  );
}

const HEADER = `import { test } from "node:test";
import assert from "node:assert/strict";
`;

// --- a test that stopped running ---------------------------------------------

test("a test that stopped running is reported, with the dropped count beside it", () => {
  const dir = makeRepo(
    {
      "tests/order.test.mjs": `${HEADER}
test("adds", () => { assert.equal(1 + 1, 2); });
test("subtracts", () => { assert.equal(2 - 1, 1); });
test("multiplies", () => { assert.equal(2 * 2, 4); });
`,
    },
    {
      "tests/order.test.mjs": `${HEADER}
test("adds", () => { assert.equal(1 + 1, 2); });
test("multiplies", () => { assert.equal(2 * 2, 4); });
`,
    },
  );
  const result = runCli(dir, ["--command", SUITE]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /disappeared: a test stopped running/);
  assert.match(result.stdout, /subtracts ran at the base commit and does not run at HEAD/);
  assert.match(result.stdout, /count-dropped/);
  assert.match(result.stdout, /3 tests at the base commit and 2 at HEAD/);
  rmSync(dir, { recursive: true, force: true });
});

// --- red before green ----------------------------------------------------------

const WEAK_BASE = {
  "src/discount.mjs": `export function discount(total) {
  return total;
}
`,
  "tests/discount.test.mjs": `${HEADER}import { discount } from "../src/discount.mjs";

test("returns a number", () => { assert.equal(typeof discount(100), "number"); });
`,
};

const FIXED_SOURCE = `export function discount(total) {
  if (total >= 100) return total - 10;
  return total;
}
`;

test("a test added beside a fix that passes on the old source is a finding", () => {
  const dir = makeRepo(WEAK_BASE, {
    "src/discount.mjs": FIXED_SOURCE,
    // This test would have passed before the fix too, so it demonstrates
    // nothing about the fix it shipped with.
    "tests/discount.test.mjs": `${HEADER}import { discount } from "../src/discount.mjs";

test("returns a number", () => { assert.equal(typeof discount(100), "number"); });
test("the discount path is covered", () => { assert.equal(typeof discount(100), "number"); });
`,
  });
  const result = runCli(dir, ["--command", SUITE]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /not-red-before-green/);
  assert.match(result.stdout, /the discount path is covered passes against the base source/);
  assert.match(result.stdout, /0 of those red against the base source/);
  rmSync(dir, { recursive: true, force: true });
});

test("the same fix with a test that exercises the new behaviour is clean", () => {
  const dir = makeRepo(WEAK_BASE, {
    "src/discount.mjs": FIXED_SOURCE,
    "tests/discount.test.mjs": `${HEADER}import { discount } from "../src/discount.mjs";

test("returns a number", () => { assert.equal(typeof discount(100), "number"); });
test("the discount path is covered", () => { assert.equal(discount(100), 90); });
`,
  });
  const result = runCli(dir, ["--command", SUITE]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /1 of those red against the base source/);
  assert.match(result.stdout, /Red before green \(1\)/);
  assert.match(result.stdout, /every test this change added was red against the base source/);
  rmSync(dir, { recursive: true, force: true });
});

// The one that must never be scored as red. A test importing a module the
// base does not have cannot run at all there, and a run that never happened
// is not a failing run.
test("a test that cannot load against the base source is unmeasured, not red", () => {
  const dir = makeRepo(
    {
      "tests/old.test.mjs": `${HEADER}
test("still here", () => { assert.ok(true); });
`,
    },
    {
      "src/feature.mjs": `export const feature = () => "on";\n`,
      "tests/feature.test.mjs": `${HEADER}import { feature } from "../src/feature.mjs";

test("the feature is on", () => { assert.equal(feature(), "on"); });
`,
    },
  );
  const result = runCli(dir, ["--command", SUITE]);
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.match(result.stdout, /errored-at-base/);
  assert.match(result.stdout, /that is an error, not a red run/);
  assert.match(result.stdout, /0 of those red against the base source/);
  assert.doesNotMatch(result.stdout, /Red before green/);
  rmSync(dir, { recursive: true, force: true });
});

// --- flakes ---------------------------------------------------------------------

// A disagreement is re-run once before it is reported. The test below is
// flaky on purpose and in one direction only: against the base source it
// passes on its first run and fails afterwards, driven by a counter in a
// file outside the repository. The first red run therefore says
// "not-red-before-green" and the re-run says otherwise, so the finding is
// dropped and counted.
test("a finding that does not hold on a re-run is dropped as flaky", () => {
  const state = join(mkdtempSync(join(tmpdir(), "adg-census-flake-")), "count");
  const dir = makeRepo(
    {
      "src/value.mjs": `export const VALUE = 1;\n`,
      "tests/value.test.mjs": `${HEADER}import { VALUE } from "../src/value.mjs";

test("the value is a number", () => { assert.equal(typeof VALUE, "number"); });
`,
    },
    {
      "src/value.mjs": `export const VALUE = 2;\n`,
      "tests/value.test.mjs": `${HEADER}import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { VALUE } from "../src/value.mjs";

test("the value is a number", () => { assert.equal(typeof VALUE, "number"); });
test("the value was raised", () => {
  const state = process.env.ADG_FLAKE_STATE;
  const seen = (existsSync(state) ? Number(readFileSync(state, "utf8")) : 0) + 1;
  writeFileSync(state, String(seen));
  if (VALUE === 2) return;
  assert.equal(seen, 2);
});
`,
    },
  );
  const result = runCli(dir, ["--command", SUITE], { ADG_FLAKE_STATE: state });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /1 finding\(s\) did not hold on a second run/);
  assert.doesNotMatch(result.stdout, /not-red-before-green/);
  rmSync(dir, { recursive: true, force: true });
  rmSync(dirname(state), { recursive: true, force: true });
});

test("--no-rerun reports the disagreement as it stood on the first run", () => {
  const dir = makeRepo(WEAK_BASE, {
    "src/discount.mjs": FIXED_SOURCE,
    "tests/discount.test.mjs": `${HEADER}import { discount } from "../src/discount.mjs";

test("returns a number", () => { assert.equal(typeof discount(100), "number"); });
test("the discount path is covered", () => { assert.equal(typeof discount(100), "number"); });
`,
  });
  const result = runCli(dir, ["--command", SUITE, "--no-rerun"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /Suite runs: 3/);
  rmSync(dir, { recursive: true, force: true });
});

// --- refusals -------------------------------------------------------------------

test("a dirty working tree is refused, and says why", () => {
  const dir = makeRepo({ "tests/a.test.mjs": `${HEADER}test("a", () => {});\n` }, {
    "tests/b.test.mjs": `${HEADER}test("b", () => {});\n`,
  });
  writeFileSync(join(dir, "scratch.txt"), "work no commit holds\n");
  const result = runCli(dir, ["--command", SUITE]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /refusing to run on a dirty working tree/);
  assert.match(result.stderr, /scratch\.txt/);
  assert.equal(result.stdout, "");
  rmSync(dir, { recursive: true, force: true });
});

test("a base that cannot be resolved is exit 2, never a comparison against nothing", () => {
  const dir = makeRepo({ "tests/a.test.mjs": `${HEADER}test("a", () => {});\n` });
  const named = runCli(dir, ["--command", SUITE, "--base", "no-such-ref"]);
  assert.equal(named.status, 2);
  assert.match(named.stderr, /does not name a commit this repository can resolve/);

  // One commit, no parent, no default branch to take a merge-base with.
  const rootOnly = runCli(dir, ["--command", SUITE]);
  assert.equal(rootOnly.status, 2);
  assert.match(rootOnly.stderr, /the base could not be resolved/);
  assert.equal(rootOnly.stdout, "");
  rmSync(dir, { recursive: true, force: true });
});

test("a lockfile that differs between the base and HEAD is refused", () => {
  const pkg = `{ "name": "x", "private": true }\n`;
  const dir = makeRepo(
    { "package.json": pkg, "package-lock.json": `{ "lockfileVersion": 3, "name": "x" }\n`, "tests/a.test.mjs": `${HEADER}test("a", () => {});\n` },
    { "package-lock.json": `{ "lockfileVersion": 3, "name": "x", "packages": {} }\n` },
  );
  const result = runCli(dir, ["--command", SUITE]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /package-lock\.json differs between the base commit and HEAD/);
  assert.match(result.stderr, /would read as every test disappearing/);
  assert.equal(result.stdout, "");
  rmSync(dir, { recursive: true, force: true });
});

test("a package.json that differs between the base and HEAD is refused", () => {
  const dir = makeRepo(
    { "package.json": `{ "name": "x" }\n`, "tests/a.test.mjs": `${HEADER}test("a", () => {});\n` },
    { "package.json": `{ "name": "x", "version": "2.0.0" }\n` },
  );
  const result = runCli(dir, ["--command", SUITE]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /package\.json differs between the base commit and HEAD/);
  rmSync(dir, { recursive: true, force: true });
});

// The failure this command must never make. Output nobody can read is a run
// that could not happen; reading it as an empty census would report every
// test in the suite as having disappeared.
test("output in neither format is exit 2, and never reads as zero tests", () => {
  const dir = makeRepo({ "tests/a.test.mjs": `${HEADER}test("a", () => {});\n` }, {
    "tests/b.test.mjs": `${HEADER}test("b", () => {});\n`,
  });
  const result = runCli(dir, ["--command", "echo 'npm ERR! missing script: test'; exit 1"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /the run at HEAD could not be read/);
  assert.match(result.stderr, /neither TAP nor JUnit/);
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stdout + result.stderr, /disappeared/);
  rmSync(dir, { recursive: true, force: true });
});

// A base run that starts, prints readable output, and holds no tests is a
// base that did not really run. It is reported as a base that could not be
// compared, and nothing claims a test disappeared.
test("a base run holding no tests is unmeasured, not every test disappearing", () => {
  const dir = makeRepo({ "tests/a.test.mjs": `${HEADER}test("a", () => {});\ntest("b", () => {});\n` }, {
    "tests/a.test.mjs": `${HEADER}test("a", () => {});\ntest("b", () => {});\ntest("c", () => {});\n`,
  });
  // The command prints an empty but readable TAP plan anywhere the marker
  // file is missing, which is only ever the base worktree.
  const command = `if [ -f marker ]; then ${SUITE}; else printf 'TAP version 13\\n1..0\\n'; fi`;
  writeFileSync(join(dir, "marker"), "head only\n");
  runGit(dir, ["add", "marker"]);
  runGit(dir, ["commit", "-q", "-m", "marker"]);
  const result = runCli(dir, ["--command", command]);
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.match(result.stdout, /base-not-comparable/);
  assert.match(result.stdout, /base not comparable/);
  assert.doesNotMatch(result.stdout, /disappeared: a test stopped running/);
  assert.doesNotMatch(result.stdout, /count-dropped/);
  rmSync(dir, { recursive: true, force: true });
});

// --- the worktree ------------------------------------------------------------------

test("the temporary worktree is removed even when the command fails", () => {
  const before = leftoverWorktrees();
  const dir = makeRepo({ "tests/a.test.mjs": `${HEADER}test("a", () => {});\n` }, {
    "tests/b.test.mjs": `${HEADER}test("b", () => {});\n`,
  });
  // A command that prints nothing readable is exit 2, and exit 2 is taken
  // by calling process.exit, which skips a finally block. The worktree has
  // to be gone anyway.
  const result = runCli(dir, ["--command", "exit 7"]);
  assert.equal(result.status, 2);
  assert.deepEqual(leftoverWorktrees(), before);
  assert.equal(runGit(dir, ["worktree", "list"]).trim().split("\n").length, 1);
  assert.equal(runGit(dir, ["status", "--porcelain"]), "");
  rmSync(dir, { recursive: true, force: true });
});

test("the temporary worktree is removed after a run that found something", () => {
  const before = leftoverWorktrees();
  const dir = makeRepo({ "tests/a.test.mjs": `${HEADER}test("a", () => {});\ntest("b", () => {});\n` }, {
    "tests/a.test.mjs": `${HEADER}test("a", () => {});\n`,
  });
  const result = runCli(dir, ["--command", SUITE]);
  assert.equal(result.status, 1);
  assert.deepEqual(leftoverWorktrees(), before);
  assert.equal(runGit(dir, ["worktree", "list"]).trim().split("\n").length, 1);
  assert.equal(runGit(dir, ["status", "--porcelain"]), "");
  assert.ok(!existsSync(join(dir, "node_modules")));
  rmSync(dir, { recursive: true, force: true });
});

// --- JUnit XML end to end -------------------------------------------------------

test("JUnit XML is read end to end, and a lost case is reported", () => {
  const dir = makeRepo(
    {
      "results.xml": `<testsuite name="s" tests="3">
  <testcase classname="OrderTest" name="adds"/>
  <testcase classname="OrderTest" name="subtracts"/>
  <testcase classname="OrderTest" name="multiplies"/>
</testsuite>
`,
    },
    {
      "results.xml": `<testsuite name="s" tests="2">
  <testcase classname="OrderTest" name="adds"/>
  <testcase classname="OrderTest" name="multiplies"/>
</testsuite>
`,
    },
  );
  const result = runCli(dir, ["--command", "cat results.xml"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /Result format: junit/);
  assert.match(result.stdout, /OrderTest :: subtracts ran at the base commit/);
  assert.match(result.stdout, /count-dropped/);
  rmSync(dir, { recursive: true, force: true });
});

test("--format-in junit forces the parser, and unreadable output is still exit 2", () => {
  const dir = makeRepo({ "results.xml": `<testsuite><testcase name="a"/></testsuite>\n` }, {
    "notes.txt": "the suite did not change\n",
  });
  const forced = runCli(dir, ["--command", "cat results.xml", "--format-in", "junit"]);
  assert.equal(forced.status, 0, forced.stdout + forced.stderr);
  const wrong = runCli(dir, ["--command", "echo hello", "--format-in", "junit"]);
  assert.equal(wrong.status, 2);
  rmSync(dir, { recursive: true, force: true });
});

// --- what gets printed -------------------------------------------------------------

test("--format json prints the findings as data", () => {
  const dir = makeRepo({ "tests/a.test.mjs": `${HEADER}test("a", () => {});\ntest("b", () => {});\n` }, {
    "tests/a.test.mjs": `${HEADER}test("a", () => {});\n`,
  });
  const result = runCli(dir, ["--command", SUITE, "--format", "json"]);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout) as { findings: { kind: string }[]; counts: { base: number } };
  assert.ok(parsed.findings.some((f) => f.kind === "disappeared"));
  assert.equal(parsed.counts.base, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("--help prints the known limits and exits 0", () => {
  const dir = makeRepo({ "tests/a.test.mjs": `${HEADER}test("a", () => {});\n` });
  const result = runCli(dir, ["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /renamed test therefore/);
  assert.match(result.stdout, /never in a per-edit hook/);
  assert.match(result.stdout, /Only TAP and JUnit XML/);
  assert.match(result.stdout, /flaky suite still produces noise/);
  rmSync(dir, { recursive: true, force: true });
});

test("an unknown argument is exit 2", () => {
  const dir = makeRepo({ "tests/a.test.mjs": `${HEADER}test("a", () => {});\n` });
  const result = runCli(dir, ["--nope"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown argument '--nope'/);
  rmSync(dir, { recursive: true, force: true });
});
