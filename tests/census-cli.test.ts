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
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
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

// --- a suite that disagrees with itself --------------------------------------

// A disagreement is re-run once before it is reported. The test below is
// flaky on purpose and in one direction only: against the base source it
// passes on its first run and fails afterwards, driven by a counter in a
// file outside the repository. The first red run therefore says
// "not-red-before-green" and the re-run says the test was red there. The two
// runs answered the same question two ways, so nothing was measured: the
// result is unmeasured and the run exits 3. It used to be dropped as flaky
// and exit 0, which reported a result nobody could measure as a clean one.
test("a result the two runs disagree about is unmeasured and exit 3, never dropped", () => {
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
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.match(result.stdout, /1 result\(s\) did not settle between the two runs/);
  assert.match(result.stdout, /did-not-settle/);
  assert.match(result.stdout, /the value was raised was passing against the base source on the first run/);
  assert.match(result.stdout, /part of this run was never measured/);
  assert.doesNotMatch(result.stdout, /not-red-before-green/);
  assert.doesNotMatch(result.stdout, /dropped as flaky/);
  assert.doesNotMatch(result.stdout, /Red before green/);
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

// --- a base run that stopped part way ---------------------------------------

// The failure this command exists to keep out, in its quietest form. A base
// run that prints some TAP and then dies leaves a truncated census, the tests
// it never reached read as new at HEAD, and the red-before-green run (which
// copies the fixed test files in, so it no longer dies) sees them all pass.
// That reported four tests as proving nothing while the count line printed
// the tell. A run that did not finish printing is a run that cannot be
// compared, and this is where that is decided.
test("a base run that printed fewer results than its plan is exit 2, not a smaller suite", () => {
  const dir = makeRepo({ "tests/a.test.mjs": `${HEADER}test("a", () => {});\n` }, {
    marker: "head only\n",
  });
  // The base worktree has no marker, so it takes the truncated branch: a
  // plan promising six results and two printed before the crash.
  const command =
    "if [ -f marker ]; then printf 'TAP version 13\\nok 1 - alpha\\nok 2 - beta\\n1..2\\n'; " +
    "else printf '1..6\\nok 1 - alpha\\nok 2 - beta\\n'; exit 1; fi";
  const result = runCli(dir, ["--command", command]);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /the run at the base commit could not be read/);
  assert.match(result.stderr, /printed a TAP plan of 6 result\(s\) but 2 of them/);
  assert.doesNotMatch(result.stdout + result.stderr, /disappeared/);
  assert.doesNotMatch(result.stdout + result.stderr, /not-red-before-green/);
  rmSync(dir, { recursive: true, force: true });
});

test("a base run that died before printing a plan or a summary is exit 2", () => {
  const dir = makeRepo({ "tests/a.test.mjs": `${HEADER}test("a", () => {});\n` }, {
    marker: "head only\n",
  });
  const command =
    "if [ -f marker ]; then printf 'TAP version 13\\nok 1 - alpha\\nok 2 - beta\\n1..2\\n'; " +
    "else printf 'TAP version 13\\nok 1 - alpha\\n'; exit 1; fi";
  const result = runCli(dir, ["--command", command]);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /without printing a plan or a summary/);
  assert.doesNotMatch(result.stdout + result.stderr, /disappeared/);
  rmSync(dir, { recursive: true, force: true });
});

// A run the operating system took away is unreadable for the same reason a
// timed-out one is: spawnSync reports how it ended, and what was printed
// before it ended is part of a census and not a census. A maxBuffer overflow
// arrives the same way, as an ENOBUFS on the same field.
test("a base run killed part way through is exit 2, not a smaller suite", () => {
  const dir = makeRepo({ "tests/a.test.mjs": `${HEADER}test("a", () => {});\n` }, {
    marker: "head only\n",
  });
  const command =
    "if [ -f marker ]; then printf 'TAP version 13\\nok 1 - alpha\\nok 2 - beta\\n1..2\\n'; " +
    "else printf 'TAP version 13\\nok 1 - alpha\\nok 2 - beta\\n1..2\\n'; kill -9 $$; fi";
  // The base prints a whole plan and is then killed, so nothing in the text
  // says anything is wrong with it. How the run ended is the only thing left
  // that does, and without it this reads as a clean exit 0.
  const result = runCli(dir, ["--command", command]);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /the run at the base commit could not be read/);
  assert.match(result.stderr, /killed by SIGKILL/);
  assert.doesNotMatch(result.stdout + result.stderr, /disappeared/);
  rmSync(dir, { recursive: true, force: true });
});

// The other half of the same rule: a suite that fails is not a suite that
// crashed. A failing run exits non-zero and still prints its plan, and
// refusing that would make every red base run unreadable.
test("a base run that failed but finished printing is still compared", () => {
  const dir = makeRepo({ "tests/a.test.mjs": `${HEADER}test("a", () => {});\n` }, {
    marker: "head only\n",
  });
  const command =
    "if [ -f marker ]; then printf 'TAP version 13\\nok 1 - alpha\\nok 2 - beta\\n1..2\\n'; " +
    "else printf 'TAP version 13\\nnot ok 1 - alpha\\nok 2 - beta\\n1..2\\n'; exit 1; fi";
  const result = runCli(dir, ["--command", command]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /flipped/);
  assert.match(result.stdout, /2 at the base/);
  rmSync(dir, { recursive: true, force: true });
});

// --- a base re-run that collected nothing --------------------------------------

// The re-run is there to drop a disagreement that does not hold. A base
// re-run that collects nothing holds no test to disagree with, so every
// finding from the first run failed to recur and the whole report was dropped
// as flaky: exit 0, with a line saying two findings had been dropped. That
// made the default less safe than --no-rerun. The re-run now goes through the
// same guard the first base run does.
test("a base re-run that collected nothing is unreadable, never evidence of flakiness", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "adg-census-cli-test-state-"));
  const state = join(stateDir, "count");
  const dir = makeRepo({ "tests/a.test.mjs": `${HEADER}test("a", () => {});\n` }, {
    marker: "head only\n",
  });
  // HEAD holds one test. The base holds two on its first run and none on its
  // second, which is a base that did not really run the second time.
  const command =
    "if [ -f marker ]; then printf 'TAP version 13\\nok 1 - alpha\\n1..1\\n'; else " +
    'n=$(cat "$ADG_BASE_STATE" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$ADG_BASE_STATE"; ' +
    "if [ \"$n\" = 1 ]; then printf 'TAP version 13\\nok 1 - alpha\\nok 2 - beta\\n1..2\\n'; " +
    "else printf 'TAP version 13\\n1..0\\n'; fi; fi";
  const result = runCli(dir, ["--command", command], { ADG_BASE_STATE: state });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /disappeared: a test stopped running/);
  assert.match(result.stdout, /beta ran at the base commit and does not run at HEAD/);
  assert.match(result.stdout, /count-dropped/);
  assert.match(result.stdout, /The base re-run printed readable output but held no tests at all/);
  assert.doesNotMatch(result.stdout, /did not hold on a second run/);
  // A re-run that collected nothing is not a re-run that disagreed. It is
  // evidence of nothing, so it settles nothing and unsettles nothing.
  assert.doesNotMatch(result.stdout, /did not settle/);
  assert.doesNotMatch(result.stdout, /did-not-settle/);
  rmSync(dir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

// --- two runs that disagree about the same test ---------------------------------

// The re-check used to filter the first run's lists by what recurred, so a
// test the first run called unable to run against the base source and the
// second called passing against it matched neither list and vanished from
// both. Exit 0, under a closing line claiming every added test had been red.
// Then it took the worse of the two verdicts, which reported a problem the
// run had not established. Neither run is now believed over the other: two
// answers to one question is no answer, so the result is unmeasured.
test("two red runs that answer the same question two ways measure nothing", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "adg-census-cli-test-state-"));
  const state = join(stateDir, "count");
  const dir = makeRepo(
    { "tests/a.test.mjs": `${HEADER}test("old", () => {});\n` },
    {
      marker: "head only\n",
      "tests/a.test.mjs": `${HEADER}test("old", () => {});\ntest("added", () => {});\n`,
    },
  );
  // In the base worktree: the census run holds only "old"; the first red run
  // reports "added" as never having run; the re-run reports it passing, which
  // is a finding and must not be lost for having been found second.
  const command =
    "if [ -f marker ]; then printf 'TAP version 13\\nok 1 - old\\nok 2 - added\\n1..2\\n'; else " +
    'n=$(cat "$ADG_BASE_STATE" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$ADG_BASE_STATE"; ' +
    "if [ \"$n\" = 1 ]; then printf 'TAP version 13\\nok 1 - old\\n1..1\\n'; " +
    "elif [ \"$n\" = 2 ]; then printf 'TAP version 13\\nok 1 - old\\n1..1\\n'; " +
    "else printf 'TAP version 13\\nok 1 - old\\nok 2 - added\\n1..2\\n'; fi; fi";
  const result = runCli(dir, ["--command", command], { ADG_BASE_STATE: state });
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.match(result.stdout, /did-not-settle/);
  assert.match(
    result.stdout,
    /added was unable to run against the base source at all on the first run and passing against the base source on the second/,
  );
  assert.match(result.stdout, /1 result\(s\) did not settle between the two runs/);
  assert.doesNotMatch(result.stdout, /not-red-before-green/);
  assert.doesNotMatch(result.stdout, /every test this change added was red/);
  rmSync(dir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

// A test that disagreed with itself does not make a finding elsewhere any
// less of a finding. Exit 1 wins over exit 3, and both are printed: the run
// says what it found and, apart from that, what it could not measure.
test("a real finding beside an unsettled result is exit 1, and both are reported", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "adg-census-cli-test-state-"));
  const state = join(stateDir, "count");
  const dir = makeRepo(
    { "tests/a.test.mjs": `${HEADER}test("old", () => {});\n` },
    {
      marker: "head only\n",
      "tests/a.test.mjs": `${HEADER}test("old", () => {});\ntest("added", () => {});\n`,
    },
  );
  // HEAD holds "old" and "added". The base holds "old" and "gone" on both of
  // its census runs, so "gone" disappeared and stays a finding. The two runs
  // against the base source then disagree about "added": passing on the
  // first, failing on the second.
  const command =
    "if [ -f marker ]; then printf 'TAP version 13\\nok 1 - old\\nok 2 - added\\n1..2\\n'; else " +
    'n=$(cat "$ADG_BASE_STATE" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$ADG_BASE_STATE"; ' +
    "if [ \"$n\" -le 2 ]; then printf 'TAP version 13\\nok 1 - old\\nok 2 - gone\\n1..2\\n'; " +
    "elif [ \"$n\" = 3 ]; then printf 'TAP version 13\\nok 1 - old\\nok 2 - added\\n1..2\\n'; " +
    "else printf 'TAP version 13\\nok 1 - old\\nnot ok 2 - added\\n1..2\\n'; fi; fi";
  const result = runCli(dir, ["--command", command], { ADG_BASE_STATE: state });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /disappeared: a test stopped running/);
  assert.match(result.stdout, /gone ran at the base commit and does not run at HEAD/);
  assert.match(result.stdout, /did-not-settle/);
  assert.match(result.stdout, /1 result\(s\) did not settle between the two runs/);
  assert.match(result.stdout, /Suite runs: 6/);
  rmSync(dir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

// --- two tests that share an identity ---------------------------------------------

// Node's TAP names no file for a passing test, so identity is the name alone
// and a new test named like an existing one in another file is invisible: it
// is not in `appeared`, and the red-before-green check never runs on it. The
// count is the only thing left that shows it.
test("a test added under a name another file already uses is an identity collision", () => {
  const dir = makeRepo(
    { "tests/a.test.mjs": `${HEADER}test("handles it", () => {});\n` },
    { "tests/b.test.mjs": `${HEADER}test("handles it", () => {});\n` },
  );
  const result = runCli(dir, ["--command", SUITE]);
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.match(result.stdout, /identity-collision/);
  assert.match(result.stdout, /1 at the base, 2 at HEAD/);
  assert.match(result.stdout, /share an identity with another test/);
  assert.doesNotMatch(result.stdout, /every test this change added was red/);
  rmSync(dir, { recursive: true, force: true });
});

// --- a '>' inside a JUnit attribute value, end to end -------------------------------

// A runner that groups a test under a describe block writes name="outer >
// inner". Cutting the tag at the first ">" lost the name and swallowed the
// case after it, which invented two disappeared tests and a dropped count for
// a change that had done nothing of the sort.
test("a '>' in a JUnit test name invents nothing", () => {
  const suite = (name: string) => `<testsuite name="s" tests="2">
  <testcase classname="a.js" name="${name}"/>
  <testcase classname="a.js" name="second"/>
</testsuite>
`;
  // A bare ">" inside an attribute value, which XML allows and which is what
  // a runner writes when it joins a describe block to the test under it.
  const dir = makeRepo({ "results.xml": suite("plain") }, { "results.xml": suite("outer > inner") });
  const result = runCli(dir, ["--command", "cat results.xml"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /2 at the base, 2 at HEAD/);
  assert.match(result.stdout, /a\.js :: plain ran at the base commit/);
  assert.doesNotMatch(result.stdout, /count-dropped/);
  assert.doesNotMatch(result.stdout, /a\.js :: second ran at the base commit/);
  rmSync(dir, { recursive: true, force: true });
});

test("a JUnit testcase with no name is exit 2, never a census", () => {
  const dir = makeRepo({ "results.xml": `<testsuite><testcase classname="a.js"/></testsuite>\n` }, {
    "notes.txt": "unchanged\n",
  });
  const result = runCli(dir, ["--command", "cat results.xml"]);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /carried no name/);
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
  assert.match(result.stdout, /A suite that disagrees with itself is reported, not smoothed over/);
  assert.match(result.stdout, /producing exit 3 here until it is fixed/);
  assert.match(result.stdout, /Two to six full suite runs/);
  assert.match(result.stdout, /writes into your real install and can corrupt it/);
  assert.match(result.stdout, /node_modules is gitignored/);
  assert.match(result.stdout, /share one identity/);
  rmSync(dir, { recursive: true, force: true });
});

test("an unknown argument is exit 2", () => {
  const dir = makeRepo({ "tests/a.test.mjs": `${HEADER}test("a", () => {});\n` });
  const result = runCli(dir, ["--nope"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown argument '--nope'/);
  rmSync(dir, { recursive: true, force: true });
});

// --- no descendant survives a timed-out run --------------------------------------

// spawnSync(command, { shell: true, timeout, killSignal: "SIGKILL" }) killed
// only the shell, never a worker process the command itself started. This
// proves the fix directly: a command whose worker shares its own process
// group and never returns. The pid file directory is named with
// "cli-test" so leftoverWorktrees() above, which watches for a real `adg
// census` worktree left behind, does not mistake it for one.

const LEAK_RUN_MJS = `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const pidDir = process.argv[2];
const here = dirname(fileURLToPath(import.meta.url));
const worker = spawn(process.execPath, [join(here, "leak-worker.mjs")], { stdio: "ignore" });
writeFileSync(join(pidDir, worker.pid + ".pid"), String(worker.pid));
worker.on("exit", (code) => process.exit(code ?? 0));
`;

const LEAK_WORKER_MJS = `process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`;

function recordedPids(pidDir: string): number[] {
  return readdirSync(pidDir)
    .filter((name) => name.endsWith(".pid"))
    .map((name) => Number(readFileSync(join(pidDir, name), "utf8")));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Polls for up to `budgetMs` for every pid to be gone, then force-kills
 * anything still alive so this test never leaves a process behind, red
 * run or green. Returns the pids still alive when the budget ran out,
 * which is empty exactly when the fix works. */
function waitForNoneAlive(pids: number[], budgetMs: number): number[] {
  const deadline = Date.now() + budgetMs;
  let stillAlive = pids.filter(isAlive);
  while (stillAlive.length > 0 && Date.now() < deadline) {
    spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 50)"], { timeout: 200 });
    stillAlive = pids.filter(isAlive);
  }
  for (const pid of stillAlive) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  return stillAlive;
}

test("a timed-out run leaves no descendant running", () => {
  const dir = makeRepo({
    "leak-run.mjs": LEAK_RUN_MJS,
    "leak-worker.mjs": LEAK_WORKER_MJS,
    "README.md": "first\n",
  });
  const base = runGit(dir, ["rev-parse", "HEAD"]).trim();
  writeFileSync(join(dir, "README.md"), "second\n");
  runGit(dir, ["add", "."]);
  runGit(dir, ["commit", "-q", "-m", "second"]);
  const pidDir = mkdtempSync(join(tmpdir(), "adg-census-cli-test-orphan-pids-"));
  try {
    const result = runCli(dir, [
      "--base",
      base,
      "--command",
      `node leak-run.mjs ${pidDir}`,
      "--timeout",
      "1",
      "--no-rerun",
    ]);
    const pids = recordedPids(pidDir);
    assert.ok(
      pids.length > 0,
      `expected the run to spawn a worker; census printed: ${result.stdout}\n${result.stderr}`,
    );
    const survivors = waitForNoneAlive(pids, 5_000);
    assert.deepEqual(survivors, [], "a worker process outlived the timed-out run");
  } finally {
    rmSync(pidDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Ctrl-C leaves no descendant running (reviewer finding 1) ---------------

// detached: true (added so the timeout could kill a whole process group)
// also moves the command out of the terminal's foreground group, so a real
// Ctrl-C, which the OS delivers only to the foreground group, no longer
// reaches it at all. This proves the fix directly: a run whose command
// spawns a worker sharing its own process group and never returns, and a
// real SIGINT sent to the census process itself, exactly what a
// terminal's Ctrl-C sends. No --timeout is given, so nothing but a real
// SIGINT (and this fix) ever stops the hung run.

test("a real Ctrl-C (SIGINT) to the census process leaves no descendant running", async () => {
  const dir = makeRepo({
    "leak-run.mjs": LEAK_RUN_MJS,
    "leak-worker.mjs": LEAK_WORKER_MJS,
    "README.md": "first\n",
  });
  const base = runGit(dir, ["rev-parse", "HEAD"]).trim();
  writeFileSync(join(dir, "README.md"), "second\n");
  runGit(dir, ["add", "."]);
  runGit(dir, ["commit", "-q", "-m", "second"]);
  const pidDir = mkdtempSync(join(tmpdir(), "adg-census-cli-test-sigint-pids-"));
  try {
    const child = spawn(
      "node",
      [CLI_PATH, "--base", base, "--command", `node leak-run.mjs ${pidDir}`, "--no-rerun"],
      { cwd: dir, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null } | "timed-out">((resolveExit) => {
      child.on("exit", (code, signal) => resolveExit({ code, signal }));
    });
    const recordDeadline = Date.now() + 15_000;
    while (recordedPids(pidDir).length === 0 && Date.now() < recordDeadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const pids = recordedPids(pidDir);
    assert.ok(pids.length > 0, `expected a worker to be recorded before the interrupt; got:\n${stdout}\n${stderr}`);
    child.kill("SIGINT");
    const exitResult = await Promise.race([
      exited,
      new Promise<"timed-out">((r) => setTimeout(() => r("timed-out"), 10_000)),
    ]);
    if (exitResult === "timed-out") child.kill("SIGKILL");
    const survivors = waitForNoneAlive(pids, 5_000);
    assert.deepEqual(survivors, [], "a worker process outlived census after a real SIGINT");
    assert.deepEqual(leftoverWorktrees(), [], "the temporary base worktree was not removed after the interrupt");
    // Design correction B: census re-raises the signal with its own
    // default disposition once the worktree is removed, instead of a
    // fixed exit code, so a shell or CI job can tell an interrupted run
    // apart from an ordinary failure. Node reports that as a null code
    // and the signal itself. Windows keeps the old fixed exit 2.
    assert.notEqual(exitResult, "timed-out", `stdout:\n${stdout}\nstderr:\n${stderr}`);
    if (process.platform === "win32") {
      assert.equal((exitResult as { code: number | null }).code, 2);
    } else {
      assert.equal((exitResult as { code: number | null }).code, null);
      assert.equal((exitResult as { signal: NodeJS.Signals | null }).signal, "SIGINT");
    }
  } finally {
    rmSync(pidDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
