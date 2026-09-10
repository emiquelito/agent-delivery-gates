// Tests for hooks/mutate.ts. Every test builds a real git repository in
// os.tmpdir() with a real, tiny test suite, spawns the CLI as a real
// subprocess, and asserts what a caller can actually see: the exit code,
// the printed report, and the bytes on disk afterwards. Nothing here
// touches this repository's own tree, and nothing is mocked: this tool
// writes to source files, so the tests have to watch it write to real ones.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { recordedPids, waitForNoneAlive, cleanupTempDir, sweepStaleTempDirs } from "./lib/process-tree.ts";

// A previous run's temp directories that this process's own kill left
// behind because a lock had not yet let go (see cleanupTempDir in
// tests/lib/process-tree.ts) get one more chance to come down here,
// before anything else runs, so they do not just accumulate.
sweepStaleTempDirs("adg-mutate-");

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(HERE, "..", "hooks", "mutate.ts");
const REPO_ROOT = join(HERE, "..");
const NODE_MODULES = join(REPO_ROOT, "node_modules");

/** A test whose command spawns a worker that mutate (or this test's own
 * cleanup) just killed can still be mid-teardown on Windows: the process
 * is gone from the process list, but the kernel has not yet let go of the
 * handle it held on this directory as its own current working directory,
 * and a bare rmSync lands inside that window often enough to fail with
 * EBUSY. tests/census-cli.test.ts and tests/induce-cli.test.ts hit the
 * same thing and settled on 10 retries at 300ms (Node's own linear
 * backoff, up to ~16.5s) as enough headroom without being unbounded; this
 * repeats those same numbers instead of picking a new one, and this
 * file's own rmSync calls did not have any retry at all before, which on
 * its own accounted for most of this file's EBUSY failures. */
function rmSyncResilient(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(cwd: string, args: string[], env?: Record<string, string>): RunResult {
  const result = spawnSync("node", [CLI_PATH, ...args], {
    cwd,
    encoding: "utf8",
    env: env === undefined ? process.env : { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runGit(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

// The module every repository below is built around. Three mutations exist
// in it: >= becomes >, && becomes ||, and - becomes +.
const ORDER_SOURCE = `export function discount(total, isMember) {
  if (total >= 100 && isMember) {
    return total - 10;
  }
  return total;
}
`;

// A suite that pins every one of those three: the boundary case, the
// arithmetic, and the member flag.
const STRONG_SUITE = `import assert from "node:assert/strict";
import { discount } from "../src/order.mjs";

assert.equal(discount(100, true), 90);
assert.equal(discount(99, true), 99);
assert.equal(discount(100, false), 100);
`;

// The same suite with one hole: it never asks what happens for a
// non-member, so turning && into || goes unnoticed.
const HOLED_SUITE = `import assert from "node:assert/strict";
import { discount } from "../src/order.mjs";

assert.equal(discount(100, true), 90);
`;

function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "adg-mutate-cli-test-"));
  runGit(dir, ["init", "-q"]);
  runGit(dir, ["config", "user.email", "test@example.invalid"]);
  runGit(dir, ["config", "user.name", "Test"]);
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  runGit(dir, ["add", "."]);
  runGit(dir, ["commit", "-q", "-m", "first"]);
  return dir;
}

function orderRepo(suite: string, extra: Record<string, string> = {}): string {
  return makeRepo({
    "package.json": `${JSON.stringify({ name: "scratch", private: true, type: "module", scripts: { test: "node tests/order.test.mjs" } }, null, 2)}\n`,
    "src/order.mjs": ORDER_SOURCE,
    "tests/order.test.mjs": suite,
    ...extra,
  });
}

function withRepo(dir: string, fn: () => void): void {
  try {
    fn();
  } finally {
    rmSyncResilient(dir);
  }
}

const SUITE_COMMAND = "node tests/order.test.mjs";

// --- the two outcomes that matter --------------------------------------------

test("a suite that catches every break: exit 0, nothing survived", () => {
  const dir = orderRepo(STRONG_SUITE);
  withRepo(dir, () => {
    const result = runCli(dir, ["--paths", "src/order.mjs", "--command", SUITE_COMMAND]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /killed 3, survived 0, timeout 0, skipped 0/);
    assert.match(result.stdout, /No mutation survived/);
    assert.equal(readFileSync(join(dir, "src/order.mjs"), "utf8"), ORDER_SOURCE);
  });
});

test("a suite with a hole: exit 1, the survivor is named with its line and both texts", () => {
  const dir = orderRepo(HOLED_SUITE);
  withRepo(dir, () => {
    const result = runCli(dir, ["--paths", "src/order.mjs", "--command", SUITE_COMMAND]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /killed 2, survived 1/);
    assert.match(result.stdout, /src\/order\.mjs:2:20\s+boolean-connective\s+&& to \|\|/);
    assert.match(result.stdout, /before: if \(total >= 100 && isMember\) \{/);
    assert.match(result.stdout, /after:\s+if \(total >= 100 \|\| isMember\) \{/);
    assert.equal(readFileSync(join(dir, "src/order.mjs"), "utf8"), ORDER_SOURCE);
  });
});

test("only one file is mutated at a time, so one break cannot mask another", () => {
  // alpha is covered by the suite and beta is not. If the run left alpha
  // mutated while it went on to mutate beta, the command would fail for
  // alpha's break and beta's break would be recorded as killed, hiding the
  // hole in the suite behind an unrelated failure.
  const dir = makeRepo({
    "package.json": `${JSON.stringify({ name: "scratch", private: true, type: "module" }, null, 2)}\n`,
    "src/alpha.mjs": "export function alpha(n) {\n  return n + 1;\n}\n",
    "src/beta.mjs": "export function beta(n) {\n  return n + 1;\n}\n",
    "tests/alpha.test.mjs": `import assert from "node:assert/strict";
import { alpha } from "../src/alpha.mjs";

assert.equal(alpha(1), 2);
`,
  });
  withRepo(dir, () => {
    const result = runCli(dir, [
      "--paths",
      "src/alpha.mjs",
      "src/beta.mjs",
      "--command",
      "node tests/alpha.test.mjs",
      "--format",
      "json",
    ]);
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout) as {
      results: Array<{ verdict: string; mutation: { file: string } }>;
    };
    const byFile = new Map(report.results.map((r) => [r.mutation.file, r.verdict]));
    assert.equal(byFile.get("src/alpha.mjs"), "killed");
    assert.equal(byFile.get("src/beta.mjs"), "survived");
  });
});

// --- safety ------------------------------------------------------------------

test("a dirty working tree: exit 2, nothing is mutated and nothing is run", () => {
  const dir = orderRepo(STRONG_SUITE);
  withRepo(dir, () => {
    const dirty = `${ORDER_SOURCE}// an uncommitted line\n`;
    writeFileSync(join(dir, "src/order.mjs"), dirty);
    const result = runCli(dir, ["--paths", "src/order.mjs", "--command", SUITE_COMMAND]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /working tree is not clean/);
    assert.match(result.stderr, /src\/order\.mjs/);
    assert.match(result.stderr, /refusing to mutate a dirty working tree/);
    assert.equal(result.stdout, "", "a refused run prints no report");
    assert.equal(readFileSync(join(dir, "src/order.mjs"), "utf8"), dirty, "the uncommitted work is untouched");
  });
});

test("a red baseline: exit 2, nothing is mutated", () => {
  const dir = orderRepo(`import assert from "node:assert/strict";\nassert.equal(1, 2);\n`);
  withRepo(dir, () => {
    const result = runCli(dir, ["--paths", "src/order.mjs", "--command", SUITE_COMMAND]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /baseline run of .* failed/);
    assert.match(result.stderr, /cannot judge a mutation/);
    assert.equal(result.stdout, "");
    assert.equal(readFileSync(join(dir, "src/order.mjs"), "utf8"), ORDER_SOURCE);
    assert.equal(runGit(dir, ["status", "--porcelain"]), "");
  });
});

test("every file is byte-identical after a run where the command always fails", () => {
  // Every mutation is killed here, so the command's non-zero exit is the
  // normal path, and the file still has to come back exactly as it was.
  const dir = orderRepo(STRONG_SUITE);
  withRepo(dir, () => {
    const before = readFileSync(join(dir, "src/order.mjs"));
    const result = runCli(dir, ["--paths", "src/order.mjs", "--command", SUITE_COMMAND]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(join(dir, "src/order.mjs")), before);
    assert.equal(runGit(dir, ["status", "--porcelain"]), "", "the tree is clean again");
  });
});

test("a run interrupted partway restores every file it wrote to", async () => {
  const dir = orderRepo(STRONG_SUITE);
  try {
    const before = readFileSync(join(dir, "src/order.mjs"));
    // Each mutation takes about a second, so the interrupt lands in the
    // middle of the run with at least one file already mutated on disk.
    const child = spawn(
      "node",
      // Double-quoted, not single-quoted: this string is handed to
      // spawnCommand, which runs `--command` through the platform's own
      // shell (sh on POSIX, cmd.exe on Windows). cmd.exe does not treat a
      // single quote as a string delimiter at all, so a single-quoted
      // script here would reach node with the quote characters still
      // attached and fail to parse. Double quotes are the delimiter both
      // shells agree on, and the script itself contains no characters
      // either shell would expand inside them.
      [CLI_PATH, "--paths", "src/order.mjs", "--command", 'node -e "setTimeout(()=>process.exit(0),1000)"'],
      { cwd: dir, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
      child.on("exit", (code, signal) => resolveExit({ code, signal }));
    });
    await new Promise((r) => setTimeout(r, 2500));
    child.kill("SIGINT");
    const { code, signal } = await exited;
    // Design correction B: mutate re-raises the signal with its own
    // default disposition once cleanup is done, instead of exiting with a
    // fixed code of its own choosing, so a shell or CI job can tell an
    // interrupted run apart from an ordinary failure. Node reports a
    // process that ended this way with a null code and the signal itself,
    // not a translated 128+n number; that translation is done by a shell
    // reporting $?, not by Node's own child_process events. Windows has no
    // such default disposition to fall back on, and keeps the old fixed
    // exit 2 there (see reraiseSignal in src/spawn-command.ts).
    if (process.platform === "win32") {
      assert.equal(code, 2, stderr);
    } else {
      assert.equal(code, null, stderr);
      assert.equal(signal, "SIGINT", stderr);
    }
    assert.match(stderr, /interrupted by SIGINT/);
    assert.deepEqual(readFileSync(join(dir, "src/order.mjs")), before);
    assert.equal(runGit(dir, ["status", "--porcelain"]), "", "the tree is clean again");
  } finally {
    rmSyncResilient(dir);
  }
});

// --- selection ---------------------------------------------------------------

test("a test file handed in explicitly is never mutated", () => {
  const dir = orderRepo(STRONG_SUITE);
  withRepo(dir, () => {
    const result = runCli(dir, [
      "--paths",
      "src/order.mjs",
      "tests/order.test.mjs",
      "package.json",
      "--command",
      SUITE_COMMAND,
      "--format",
      "json",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as { files: string[]; results: Array<{ mutation: { file: string } }> };
    assert.deepEqual(report.files, ["src/order.mjs"]);
    for (const entry of report.results) {
      assert.equal(entry.mutation.file, "src/order.mjs");
    }
  });
});

test("with no selector, the source files changed by HEAD are the ones mutated", () => {
  const dir = orderRepo(STRONG_SUITE);
  withRepo(dir, () => {
    const result = runCli(dir, ["--command", SUITE_COMMAND, "--format", "json"]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as { files: string[] };
    assert.deepEqual(report.files, ["src/order.mjs"]);
  });
});

test("--staged mutates the staged diff and puts every file back byte for byte", () => {
  // An earlier version of this test asserted the opposite: it recorded the
  // clean-tree check refusing every --staged run, because a staged change
  // counts as dirty, and called that the point. It was not the point. It
  // meant --staged could never do any work in any git state. This is what
  // the flag is supposed to do.
  const dir = orderRepo(STRONG_SUITE, { "src/other.mjs": "export const other = 1;\n" });
  withRepo(dir, () => {
    const staged = "export const other = 1 + 1;\n";
    writeFileSync(join(dir, "src/other.mjs"), staged);
    runGit(dir, ["add", "src/other.mjs"]);
    const statusBefore = runGit(dir, ["status", "--porcelain"]);

    const result = runCli(dir, ["--staged", "--command", SUITE_COMMAND, "--format", "json"]);
    // The suite says nothing about other.mjs, so its one mutation survives:
    // a real verdict on a real mutation, not a refusal.
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout) as {
      files: string[];
      planned: number;
      attempted: number;
      results: Array<{ verdict: string; mutation: { file: string; line: number; original: string } }>;
    };
    assert.deepEqual(report.files, ["src/other.mjs"]);
    assert.equal(report.planned, 1);
    assert.equal(report.attempted, 1);
    assert.equal(report.results.length, 1);
    assert.equal(report.results[0].verdict, "survived");
    assert.equal(report.results[0].mutation.file, "src/other.mjs");
    assert.equal(report.results[0].mutation.original, "+");

    assert.equal(readFileSync(join(dir, "src/other.mjs"), "utf8"), staged, "the staged text is back byte for byte");
    assert.equal(readFileSync(join(dir, "src/order.mjs"), "utf8"), ORDER_SOURCE);
    assert.equal(runGit(dir, ["status", "--porcelain"]), statusBefore, "the index and the tree are as they were");
    assert.equal(runGit(dir, ["diff"]), "", "nothing is left unstaged");
  });
});

test("--staged refuses when there is unstaged work under the staged change", () => {
  const dir = orderRepo(STRONG_SUITE, { "src/other.mjs": "export const other = 1;\n" });
  withRepo(dir, () => {
    writeFileSync(join(dir, "src/other.mjs"), "export const other = 1 + 1;\n");
    runGit(dir, ["add", "src/other.mjs"]);
    // A further edit on top of the staged one: no commit holds it, and this
    // tool writes to that file.
    const unstaged = "export const other = 1 + 2;\n";
    writeFileSync(join(dir, "src/other.mjs"), unstaged);
    const result = runCli(dir, ["--staged", "--command", SUITE_COMMAND]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /These changes are not staged/);
    assert.match(result.stderr, /src\/other\.mjs/);
    assert.match(result.stderr, /--staged expects the unstaged tree to be clean/);
    assert.equal(result.stdout, "", "a refused run prints no report");
    assert.equal(readFileSync(join(dir, "src/other.mjs"), "utf8"), unstaged, "the unstaged work is untouched");
  });
});

test("--staged refuses when an untracked file is sitting in the tree", () => {
  const dir = orderRepo(STRONG_SUITE, { "src/other.mjs": "export const other = 1;\n" });
  withRepo(dir, () => {
    writeFileSync(join(dir, "src/other.mjs"), "export const other = 1 + 1;\n");
    runGit(dir, ["add", "src/other.mjs"]);
    writeFileSync(join(dir, "src/loose.mjs"), "export const loose = 1 + 1;\n");
    const result = runCli(dir, ["--staged", "--command", SUITE_COMMAND]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /These changes are not staged/);
    assert.match(result.stderr, /src\/loose\.mjs/);
  });
});

test("--staged with an empty staged diff: exit 2, never a quiet pass", () => {
  const dir = orderRepo(STRONG_SUITE);
  withRepo(dir, () => {
    const result = runCli(dir, ["--staged", "--command", SUITE_COMMAND]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /named no files/);
  });
});

test("a --paths target git ignores: exit 2, and the file is left alone", () => {
  // An ignored file has no committed copy, and git status never reports it,
  // so the clean-tree check cannot see it either. If a run were killed
  // partway through mutating it, nothing could put it back.
  const dir = orderRepo(STRONG_SUITE, { ".gitignore": "scratch-out/\n" });
  withRepo(dir, () => {
    mkdirSync(join(dir, "scratch-out"), { recursive: true });
    const scratch = "export const scratch = 1 + 1;\n";
    writeFileSync(join(dir, "scratch-out/scratch.mjs"), scratch);
    assert.equal(runGit(dir, ["status", "--porcelain"]), "", "an ignored file leaves the tree looking clean");
    const result = runCli(dir, ["--paths", "scratch-out/scratch.mjs", "--command", SUITE_COMMAND]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /git ignores scratch-out\/scratch\.mjs/);
    assert.match(result.stderr, /no committed copy to restore from/);
    assert.equal(result.stdout, "");
    assert.equal(readFileSync(join(dir, "scratch-out/scratch.mjs"), "utf8"), scratch);
  });
});

test("--range mutates the source files changed across the range", () => {
  const dir = orderRepo(STRONG_SUITE);
  withRepo(dir, () => {
    const first = runGit(dir, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(dir, "src/other.mjs"), "export const other = 1 + 1;\n");
    runGit(dir, ["add", "."]);
    runGit(dir, ["commit", "-q", "-m", "second"]);
    const result = runCli(dir, ["--range", `${first}..HEAD`, "--command", SUITE_COMMAND, "--format", "json"]);
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout) as { files: string[] };
    assert.deepEqual(report.files, ["src/other.mjs"]);
  });
});

test("--max caps how many mutations are attempted", () => {
  const dir = orderRepo(STRONG_SUITE);
  withRepo(dir, () => {
    const result = runCli(dir, ["--paths", "src/order.mjs", "--command", SUITE_COMMAND, "--max", "1"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Mutations: 3 planned, 1 attempted/);
    assert.match(result.stdout, /killed 1, survived 0/);
  });
});

test("--max takes the first N in order, and the report says a later file was never reached", () => {
  // The cap is not spread across the selection: it takes the first N of the
  // path, then line, then column order. A big file early in that order can
  // use the whole budget, and a reader who sees "survived 0" has to be told
  // that the rest of the selection was never touched.
  const dir = makeRepo({
    "package.json": `${JSON.stringify({ name: "scratch", private: true, type: "module" }, null, 2)}\n`,
    "src/a_big.mjs": "export const one = 1 + 1;\nexport const two = 2 + 2;\nexport const three = 3 + 3;\n",
    "src/z_small.mjs": "export const four = 4 + 4;\n",
  });
  withRepo(dir, () => {
    const result = runCli(dir, [
      "--paths",
      "src/a_big.mjs",
      "src/z_small.mjs",
      "--command",
      "node -e \"\"",
      "--max",
      "2",
    ]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /Mutations: 4 planned, 2 attempted/);
    assert.match(result.stdout, /Not every planned mutation was attempted: --max stopped the run at 2 of 4\./);
    assert.match(result.stdout, /leaves 2 of the 4 planned mutations unmeasured/);
    assert.doesNotMatch(result.stdout, /z_small\.mjs:/, "the later file was never attempted");
    assert.match(result.stdout, /Files: src\/a_big\.mjs, src\/z_small\.mjs/);
  });
});

test("two runs over the same input report the same mutations in the same order", () => {
  const dir = orderRepo(STRONG_SUITE);
  withRepo(dir, () => {
    const args = ["--paths", "src/order.mjs", "--command", SUITE_COMMAND, "--format", "json"];
    const first = JSON.parse(runCli(dir, args).stdout) as { results: Array<{ mutation: unknown }> };
    const second = JSON.parse(runCli(dir, args).stdout) as { results: Array<{ mutation: unknown }> };
    assert.deepEqual(
      first.results.map((r) => r.mutation),
      second.results.map((r) => r.mutation),
    );
  });
});

// --- timeout -----------------------------------------------------------------

test("a mutation that hangs is reported as a timeout, not as killed", () => {
  const dir = makeRepo({
    "package.json": `${JSON.stringify({ name: "scratch", private: true, type: "module" }, null, 2)}\n`,
    "src/drain.mjs": `export function drain(items) {
  let left = items;
  while (left.length > 0) {
    left = left.slice(1);
  }
  return left.length;
}
`,
    "tests/drain.test.mjs": `import assert from "node:assert/strict";
import { drain } from "../src/drain.mjs";

assert.equal(drain([1, 2, 3]), 0);
`,
  });
  withRepo(dir, () => {
    // The first mutation in order turns `> 0` into `>= 0`, which never ends.
    const result = runCli(dir, [
      "--paths",
      "src/drain.mjs",
      "--command",
      "node tests/drain.test.mjs",
      "--max",
      "1",
      "--timeout",
      "3",
    ]);
    // Exit 3, not 0: nothing survived, but nothing was judged either, and a
    // run that could not measure its own work must never read as a clean
    // one.
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stdout, /killed 0, survived 0, timeout 1, skipped 0/);
    assert.match(result.stdout, /No verdict on these \(1\):/);
    assert.match(result.stdout, /timeout\s+src\/drain\.mjs:3:22\s+comparison-boundary\s+> to >=/);
    assert.match(result.stdout, /never got a verdict: those lines are still unmeasured \(exit 3\)/);
  });
});

// --- arguments ---------------------------------------------------------------

test("a selected file with no mutation in it: exit 2, never a quiet pass", () => {
  const dir = orderRepo(STRONG_SUITE, { "src/flat.mjs": "export const flat = 1;\n" });
  withRepo(dir, () => {
    const result = runCli(dir, ["--paths", "src/flat.mjs", "--command", SUITE_COMMAND]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /held a mutation this tool knows how to make/);
  });
});

test("no command and no test script: exit 2", () => {
  const dir = makeRepo({
    "package.json": `${JSON.stringify({ name: "scratch", private: true, type: "module" }, null, 2)}\n`,
    "src/order.mjs": ORDER_SOURCE,
  });
  withRepo(dir, () => {
    const result = runCli(dir, ["--paths", "src/order.mjs"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /no command to run/);
  });
});

test("with a test script and no --command, the command is npm test", () => {
  const dir = orderRepo(STRONG_SUITE);
  withRepo(dir, () => {
    const result = runCli(dir, ["--paths", "src/order.mjs", "--max", "1", "--format", "json"]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as { command: string };
    assert.equal(report.command, "npm test");
  });
});

test("two selectors at once: exit 2", () => {
  const dir = orderRepo(STRONG_SUITE);
  withRepo(dir, () => {
    const result = runCli(dir, ["--staged", "--rev", "HEAD"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /only one of --rev, --range, --staged, --paths/);
  });
});

test("an unknown argument: exit 2", () => {
  const dir = orderRepo(STRONG_SUITE);
  withRepo(dir, () => {
    const result = runCli(dir, ["--nope"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown argument '--nope'/);
  });
});

test("a path outside the repository: exit 2", () => {
  const dir = orderRepo(STRONG_SUITE);
  withRepo(dir, () => {
    const result = runCli(dir, ["--paths", "/etc/hosts", "--command", SUITE_COMMAND]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /outside the repository/);
  });
});

test("--help: prints the usage and the operator list, exits 0", () => {
  const dir = orderRepo(STRONG_SUITE);
  withRepo(dir, () => {
    const result = runCli(dir, ["--help"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage: mutate/);
    assert.match(result.stdout, /comparison boundary/);
    assert.match(result.stdout, /at least one mutation survived/);
    // The four things a caller cannot work out from the output alone.
    assert.match(result.stdout, /3\s+nothing survived, but at least one mutation never got a verdict/);
    assert.match(result.stdout, /A SIGKILL, a power cut, or a hard crash/);
    assert.match(result.stdout, /leaves the last mutated file mutated\n\s+on disk/);
    assert.match(result.stdout, /git checkout -- <path>/);
    assert.match(result.stdout, /the cap keeps the first N of that\n\s+order/);
    assert.match(result.stdout, /A path git ignores is refused/);
  });
});

test("outside a git repository: exit 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "adg-mutate-nogit-test-"));
  withRepo(dir, () => {
    const env = { ...process.env };
    delete env.GIT_DIR;
    const result = spawnSync("node", [CLI_PATH, "--paths", "x.mjs"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...env, GIT_CEILING_DIRECTORIES: dirname(dir) },
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /rev-parse/);
  });
});

// --- no descendant survives a timed-out mutation -----------------------------

// Sixty-four orphaned `node tests/drain.test.mjs` processes were once found
// running on this machine, the oldest ten hours old, holding 11 GB of RAM.
// spawnSync(command, { shell: true, timeout, killSignal: "SIGKILL" }) kills
// only the shell; a worker process the command itself starts is never
// signalled and is reparented to init. This proves the fix: a command that
// spawns a worker sharing its own process group, where the worker only
// spins forever once the mutation under test flips a loop's `<` to `<=`.

const LOOP_MJS = `export function shouldContinue(seen) {
  return seen < 1;
}
`;

// A launcher whose worker is a normal (non-detached) child, so it shares
// the launcher's process group exactly the way a test runner's worker
// process shares its runner's group.
const RUN_MJS = `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const pidDir = process.argv[2];
const here = dirname(fileURLToPath(import.meta.url));
const worker = spawn(process.execPath, [join(here, "worker.mjs")], { stdio: "ignore" });
writeFileSync(join(pidDir, worker.pid + ".pid"), String(worker.pid));
worker.on("exit", (code) => process.exit(code ?? 0));
`;

// Two iterations and done, unless the mutated \`<=\` turns this into a spin
// that never returns. Ignoring SIGTERM matches the production report: "a
// Node process stuck in a synchronous infinite loop never reaches its
// event loop and so never runs its SIGTERM handler."
const WORKER_MJS = `import { shouldContinue } from "./src/loop.mjs";
process.on("SIGTERM", () => {});
let seen = 0;
while (shouldContinue(seen)) {
  seen = 1;
}
`;

// recordedPids, isAlive, and waitForNoneAlive live in tests/lib/process-tree.ts.

test("a timed-out mutation leaves no descendant running", () => {
  const dir = makeRepo({
    "src/loop.mjs": LOOP_MJS,
    "run.mjs": RUN_MJS,
    "worker.mjs": WORKER_MJS,
  });
  const pidDir = mkdtempSync(join(tmpdir(), "adg-mutate-orphan-pids-"));
  withRepo(dir, () => {
    try {
      const result = runCli(dir, [
        "--paths",
        "src/loop.mjs",
        "--command",
        `node run.mjs ${pidDir}`,
        "--timeout",
        "1",
      ]);
      const pids = recordedPids(pidDir);
      assert.ok(
        pids.length > 0,
        `expected the mutation to spawn a worker; mutate printed: ${result.stdout}\n${result.stderr}`,
      );
      const survivors = waitForNoneAlive(pids, 5_000);
      assert.deepEqual(survivors, [], "a worker process outlived the timed-out mutation");
    } finally {
      rmSyncResilient(pidDir);
    }
  });
});

// --- Ctrl-C leaves no descendant running (reviewer finding 1) ---------------

// detached: true (added so the timeout could kill a whole process group)
// also moves the command out of the terminal's foreground group, so a real
// Ctrl-C, which the OS delivers only to the foreground group, no longer
// reaches it at all. This proves the fix directly: a command whose worker
// shares its own process group and ignores SIGTERM, so only a real group
// kill removes it, and a SIGINT sent to the mutate process itself, exactly
// what a terminal's Ctrl-C sends.

// This script and the shell it runs through both write their own pid out,
// not just the worker they spawn to hang: its own (process.pid) and the
// shell's (process.ppid -- spawnCommand runs this through `sh -c`/
// `cmd.exe /c`, so the shell is this script's direct parent). Recording
// it this way -- each process reporting its own id -- is what lets
// recordedPids() (tests/lib/process-tree.ts) read back the whole tree
// afterward without this test needing any platform-specific
// process-enumeration tool.
const SIGINT_LEAK_RUN_MJS = `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const pidDir = process.argv[2];
const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(pidDir, "script-" + process.pid + ".pid"), String(process.pid));
writeFileSync(join(pidDir, "shell-" + process.ppid + ".pid"), String(process.ppid));
const worker = spawn(process.execPath, [join(here, "sigint-leak-worker.mjs")], { stdio: "ignore" });
writeFileSync(join(pidDir, "worker-" + worker.pid + ".pid"), String(worker.pid));
worker.on("exit", (code) => process.exit(code ?? 0));
`;

const SIGINT_LEAK_WORKER_MJS = `process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`;

// recordedPids, isAlive, and waitForNoneAlive live in tests/lib/process-tree.ts.

test("a real Ctrl-C (SIGINT) during the baseline leaves no descendant running, and says it was interrupted, not that the baseline failed", async () => {
  const dir = makeRepo({
    "src/loop.mjs": "export function shouldContinue(seen) {\n  return seen < 1;\n}\n",
    "sigint-run.mjs": SIGINT_LEAK_RUN_MJS,
    "sigint-leak-worker.mjs": SIGINT_LEAK_WORKER_MJS,
  });
  const pidDir = mkdtempSync(join(tmpdir(), "adg-mutate-sigint-pids-"));
  try {
    const child = spawn(
      "node",
      [CLI_PATH, "--paths", "src/loop.mjs", "--command", `node sigint-run.mjs ${pidDir}`],
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
    // The command spawns its worker unconditionally, on the very first call
    // (the baseline), so waiting for the pid file is enough: a descendant
    // is actually there by the time the SIGINT below is sent.
    const recordDeadline = Date.now() + 10_000;
    while (recordedPids(pidDir).length === 0 && Date.now() < recordDeadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    // The whole tree, not just the leaf worker: SIGINT_LEAK_RUN_MJS above
    // writes out its own pid and the shell's (its ppid) as soon as it
    // starts, and mutate's own pid (child.pid) is added here, so a
    // surviving shell or a surviving mutate process -- exactly what
    // checking only the innermost worker would miss -- fails this the
    // same way a surviving worker does.
    const pids = [...recordedPids(pidDir), ...(child.pid === undefined ? [] : [child.pid])];
    assert.ok(pids.length > 0, `expected a worker to be recorded before the interrupt; got:\n${stdout}\n${stderr}`);
    child.kill("SIGINT");
    // A bounded wait, not an unconditional await: if the fix were absent
    // and mutate itself somehow never exited, this test must fail instead
    // of hanging forever.
    const exitResult = await Promise.race([
      exited,
      new Promise<"timed-out">((r) => setTimeout(() => r("timed-out"), 10_000)),
    ]);
    if (exitResult === "timed-out") child.kill("SIGKILL");
    const survivors = waitForNoneAlive(pids, 5_000);
    assert.deepEqual(survivors, [], "a process in mutate's tree outlived it after a real SIGINT");
    // reviewer finding 3: mutate used to register its own SIGINT/SIGTERM
    // handlers only after the baseline returned, so a Ctrl-C during the
    // baseline (this window) fell through to the "the baseline failed"
    // refusal instead of the interrupted message the mutation loop always
    // printed. Both windows have to say the same thing now.
    assert.match(stderr, /interrupted by SIGINT/);
    assert.doesNotMatch(stderr, /baseline run of .* failed/, "a Ctrl-C must never read as a broken baseline");
    assert.doesNotMatch(stderr, /cannot judge a mutation/, "a Ctrl-C must never read as a broken baseline");
    // Design correction B: re-raised with the signal's own default
    // disposition once cleanup is done, not a fixed code mutate picked
    // itself. Node reports a process that ended this way with a null code
    // and the signal itself, not a translated 128+n number. Windows keeps
    // the old fixed exit 2 (see reraiseSignal in src/spawn-command.ts).
    assert.notEqual(exitResult, "timed-out", `stdout:\n${stdout}\nstderr:\n${stderr}`);
    if (process.platform === "win32") {
      assert.equal((exitResult as { code: number | null }).code, 2, `stdout:\n${stdout}\nstderr:\n${stderr}`);
    } else {
      assert.equal((exitResult as { code: number | null }).code, null, `stdout:\n${stdout}\nstderr:\n${stderr}`);
      assert.equal(
        (exitResult as { signal: NodeJS.Signals | null }).signal,
        "SIGINT",
        `stdout:\n${stdout}\nstderr:\n${stderr}`,
      );
    }
  } finally {
    // A directory rmSync cannot remove here is a cleanup problem, not
    // evidence that anything survived -- that claim is already settled
    // above, by waitForNoneAlive, before this ever runs. cleanupTempDir
    // retries the same way rmSyncResilient always has, then logs a note
    // and moves on instead of failing this test over it.
    cleanupTempDir(pidDir);
    cleanupTempDir(dir);
  }
});

// A gate function whose truth mutate's one mutation flips: false at the
// baseline (0 < 0), true once `<` becomes `<=` (0 <= 0). The command below
// uses it to spawn its leaking worker only for the mutated run, never for
// the baseline, so a SIGINT sent once the worker is recorded lands
// squarely in the post-baseline mutation window: exactly the window
// reviewer finding 1 says was never exercised, because mutate's own
// onInt/onTerm are registered before this point now, and
// src/spawn-command.ts's own listener for the in-flight command is the
// only other one on the same signal.
const GATED_SIGINT_RUN_MJS = `import { shouldHang } from "./src/loop.mjs";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const pidDir = process.argv[2];
if (!shouldHang(0)) {
  process.exit(0);
}
// Only past this point (the mutated run, never the baseline) does this
// script's own pid and the shell's (its ppid) get written out, alongside
// the worker's -- see the matching comment on SIGINT_LEAK_RUN_MJS above.
writeFileSync(join(pidDir, "script-" + process.pid + ".pid"), String(process.pid));
writeFileSync(join(pidDir, "shell-" + process.ppid + ".pid"), String(process.ppid));
const here = dirname(fileURLToPath(import.meta.url));
const worker = spawn(process.execPath, [join(here, "sigint-leak-worker.mjs")], { stdio: "ignore" });
writeFileSync(join(pidDir, "worker-" + worker.pid + ".pid"), String(worker.pid));
// Never resolves on its own: only a real group kill ends this, the same
// as the worker it spawned.
`;

test("a real Ctrl-C (SIGINT) during a mutation, after the baseline has already returned, leaves no descendant running (reviewer finding 1)", async () => {
  const dir = makeRepo({
    "src/loop.mjs": "export function shouldHang(n) {\n  return n < 0;\n}\n",
    "gated-sigint-run.mjs": GATED_SIGINT_RUN_MJS,
    "sigint-leak-worker.mjs": SIGINT_LEAK_WORKER_MJS,
  });
  const pidDir = mkdtempSync(join(tmpdir(), "adg-mutate-sigint-post-baseline-pids-"));
  try {
    const child = spawn(
      "node",
      [CLI_PATH, "--paths", "src/loop.mjs", "--command", `node gated-sigint-run.mjs ${pidDir}`],
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
    const exited = new Promise<number | null>((resolveExit) => {
      child.on("exit", (code) => resolveExit(code));
    });
    // The baseline call runs shouldHang(0) against the original `<`, which
    // is false, so it exits at once and spawns no worker at all. Only the
    // one mutation (`<` to `<=`) makes shouldHang(0) true, so a pid file
    // appearing here means the baseline has already returned and mutate's
    // own onInt/onTerm are registered.
    const recordDeadline = Date.now() + 10_000;
    while (recordedPids(pidDir).length === 0 && Date.now() < recordDeadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    // The whole tree, not just the leaf worker: see the matching comment
    // on the SIGINT test above.
    const pids = [...recordedPids(pidDir), ...(child.pid === undefined ? [] : [child.pid])];
    assert.ok(
      pids.length > 0,
      `expected the mutation's worker to be recorded before the interrupt; got:\n${stdout}\n${stderr}`,
    );
    child.kill("SIGINT");
    const exitCode = await Promise.race([
      exited,
      new Promise<"timed-out">((r) => setTimeout(() => r("timed-out"), 10_000)),
    ]);
    if (exitCode === "timed-out") child.kill("SIGKILL");
    const survivors = waitForNoneAlive(pids, 5_000);
    assert.deepEqual(
      survivors,
      [],
      "a process in mutate's tree outlived it after a real SIGINT sent during a post-baseline mutation",
    );
    assert.match(stderr, /interrupted by SIGINT/);
  } finally {
    // See the matching comment on the SIGINT test above: a locked
    // directory here is a cleanup problem, not evidence that anything
    // survived.
    cleanupTempDir(pidDir);
    cleanupTempDir(dir);
  }
});

// --- the baseline run has its own timeout (reviewer finding 3) --------------

test("a hung baseline run is timed out, reported plainly, and leaves no descendant", async () => {
  const dir = makeRepo({
    "src/loop.mjs": "export function shouldContinue(seen) {\n  return seen < 1;\n}\n",
    "sigint-run.mjs": SIGINT_LEAK_RUN_MJS,
    "sigint-leak-worker.mjs": SIGINT_LEAK_WORKER_MJS.replace("process.on(\"SIGTERM\", () => {});\n", ""),
  });
  const pidDir = mkdtempSync(join(tmpdir(), "adg-mutate-baseline-timeout-pids-"));
  try {
    // The baseline is the very first run of the command, before any file
    // is mutated, so this command hangs on the FIRST call already: it
    // spawns a worker that never exits and never lets the baseline itself
    // return. spawnSync's own timeout is only a safety net in case the fix
    // is absent and --timeout 2 truly has no effect on the baseline: without
    // it, this test would hang forever instead of failing red.
    const spawned = spawnSync(
      "node",
      [CLI_PATH, "--paths", "src/loop.mjs", "--command", `node sigint-run.mjs ${pidDir}`, "--timeout", "2"],
      { cwd: dir, encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL" },
    );
    const result = { status: spawned.status, stdout: spawned.stdout, stderr: spawned.stderr };
    // Collected and swept before any assertion, so a failing assertion
    // (expected when this test is run red, against the unpatched code)
    // never skips over cleaning up a leaked descendant.
    const pids = recordedPids(pidDir);
    const survivors = waitForNoneAlive(pids, 5_000);
    assert.equal(result.status, 2, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stderr, /baseline run of .* did not finish within 2s/);
    assert.doesNotMatch(result.stderr, /exit killed/, "a baseline timeout must not read as a plain failed exit");
    assert.ok(pids.length > 0, `expected the baseline to spawn a worker; got: ${result.stdout}\n${result.stderr}`);
    assert.deepEqual(survivors, [], "a worker process outlived the timed-out baseline run");
  } finally {
    rmSyncResilient(pidDir);
    rmSyncResilient(dir);
  }
});

// --- mutate has an output ceiling, the same as induce and census (finding 2) --

test("a mutation that floods stdout is killed well before its timeout, not let run unbounded", () => {
  // shouldFlood(0) is false on the original `<` (0 < 0), so the baseline
  // exits at once. Mutating `<` to `<=` makes it true (0 <= 0), and the
  // mutated run floods stdout through a real subprocess (node itself, the
  // same portable stand-in used elsewhere in this file, not the Unix-only
  // `yes`) so the flood is not throttled by this Node process's own event
  // loop and still works on Windows. That subprocess writes a single chunk
  // well past the 64 MB cap -- large enough that even a generous margin of
  // error in the cap still gets crossed -- and sets process.exitCode
  // instead of calling process.exit(), so the write reaches the pipe
  // before the process ends instead of being truncated. With no cap that
  // run has nothing to stop it short of the timeout; with a cap it is
  // killed within a couple of seconds of crossing it, long before a
  // generous timeout fires. The spawnSync result is checked: a flood that
  // never started must fail loudly, not read as a survived mutation.
  const dir = makeRepo({
    "src/gate.mjs": "export function shouldFlood(n) {\n  return n < 0;\n}\n",
    "flood-run.mjs": `import { shouldFlood } from "./src/gate.mjs";
import { spawnSync } from "node:child_process";
if (shouldFlood(0)) {
  const result = spawnSync(
    process.execPath,
    ["-e", "process.stdout.write('0123456789'.repeat(10_000_000)); process.exitCode = 1;"],
    { stdio: "inherit" },
  );
  if (result.error) {
    throw new Error(\`flood subprocess failed to start: \${result.error.message}\`);
  }
} else {
  process.exit(0);
}
`,
  });
  withRepo(dir, () => {
    const result = runCli(dir, [
      "--paths",
      "src/gate.mjs",
      "--command",
      "node flood-run.mjs",
      "--timeout",
      "8",
      "--format",
      "json",
    ]);
    const report = JSON.parse(result.stdout) as {
      results: Array<{ verdict: string; durationMs: number; exitCode: number | null }>;
    };
    assert.equal(report.results.length, 1, result.stdout);
    const [entry] = report.results;
    // reviewer finding 2: this used to assert verdict === "killed", which
    // blessed the bug the finding is about. A run killed for overflowing
    // the output cap never let the suite's own exit code through: nothing
    // here says the suite noticed the mutation, only that it printed too
    // much. Crediting that as a catch is exactly what isUnmeasured already
    // refuses to do for a timeout, and an overflow kill is unmeasured for
    // the same reason.
    assert.equal(
      entry.verdict,
      "output-overflow",
      `expected the flood to be capped and reported as unmeasured, not timed out or credited as a catch: ${result.stdout}`,
    );
    assert.equal(entry.exitCode, null, "an overflow kill has no exit code to report, the same as a timeout");
    assert.ok(
      entry.durationMs < 4000,
      `expected the output cap to kill the flood in a few seconds, not ride out the 8s timeout: took ${entry.durationMs}ms`,
    );
    // Exit 3, not 0: nothing survived, but this one mutation was never
    // judged. Reading this as a clean run would be the exact failure
    // finding 2 is about.
    assert.equal(result.status, 3, result.stdout);
  });
});

// Same category of gap as the "kill -9 $$" test in tests/induce-cli.test.ts
// and tests/census-cli.test.ts, one level further down: this one does not
// rely on a shell builtin, but on Node's child_process reporting which
// signal ended a process. Node's own docs say that reporting is POSIX-only
// -- "On Windows, the exit signal is not supported and will always be
// null" -- so spawnCommand's `signal`, and the killedBySignal it derives
// from it, can never be anything but null there, whatever actually killed
// the tree. die-run.mjs's process.kill(0, "SIGKILL") additionally depends
// on pid 0 addressing the caller's whole POSIX process group, which
// Windows has no equivalent of either. This is skipped, not rewritten,
// because there is no Windows signal to observe: assumed from Node's
// documented behaviour, not verified on a Windows runner.
test(
  "a mutation whose run is killed by a signal, not by the timeout or the output cap, is its own verdict too (finding 2)",
  { skip: process.platform === "win32" ? "Windows never reports a child's exit signal; see the comment above" : false },
  () => {
    // Built the same way as the flood test above: the baseline runs the original
    // `<`, which is false, and exits cleanly; the one mutation to `<=` makes
    // the gate true and the command signals itself instead of exiting. A
    // command killed by a signal arrives with a null status, and used to
    // read exactly like a plain non-zero exit ("killed"), crediting the
    // suite with a catch a segfault or an out-of-memory kill has nothing to
    // do with.
    //
    // spawnCommand runs the command through a shell (`sh -c "node
    // die-run.mjs"`), and a shell that notices its own foreground child die
    // by a signal reports that as its OWN plain exit code (128 + the signal
    // number), not by dying of the signal itself; `process.kill(process.pid,
    // ...)` from inside the node process therefore never reaches
    // spawnCommand's `close` handler as a signal at all. `process.kill(0,
    // ...)` sends to pid 0, which POSIX defines as "every process in the
    // caller's own process group" -- the shell included, since detached:
    // true made it the leader of that group -- so the shell itself dies by
    // the signal directly, which is what a real segfault or an external
    // out-of-memory kill would also do to it.
    const dir = makeRepo({
      "src/gate.mjs": "export function shouldDie(n) {\n  return n < 0;\n}\n",
      "die-run.mjs": `import { shouldDie } from "./src/gate.mjs";
if (shouldDie(0)) {
  process.kill(0, "SIGKILL");
} else {
  process.exit(0);
}
`,
    });
    withRepo(dir, () => {
      const result = runCli(dir, [
        "--paths",
        "src/gate.mjs",
        "--command",
        "node die-run.mjs",
        "--format",
        "json",
      ]);
      const report = JSON.parse(result.stdout) as {
        results: Array<{ verdict: string; exitCode: number | null }>;
      };
      assert.equal(report.results.length, 1, result.stdout);
      const [entry] = report.results;
      assert.equal(entry.verdict, "killed-by-signal", result.stdout);
      assert.equal(entry.exitCode, null);
      assert.equal(result.status, 3, "nothing survived, but the one mutation was never judged");
      const parsed = JSON.parse(result.stdout) as { summary: Record<string, number> };
      assert.deepEqual(parsed.summary, {
        killed: 0,
        survived: 0,
        timeout: 0,
        skipped: 0,
        outputOverflow: 0,
        killedBySignal: 1,
      });
    });
  },
);

// --- Python end to end --------------------------------------------------

// The module every Python repository below is built around. Three
// mutations exist in it: >= becomes >, and becomes or, - becomes +.
const PY_ORDER_SOURCE = `def discount(total, is_member):
    """Ten percent off for a member spending at least 100."""
    if total >= 100 and is_member:
        return total - 10
    return total
`;

// The "suite" is a Node script, not a real Python interpreter: this test
// environment is not guaranteed to have one, and the CLI only cares that
// its command exits 0 on a pass and non-zero on a failure. Checking the
// mutated source's own text for the operators this test cares about is
// enough to prove the CLI actually wrote the mutation, ran a command
// against it, and restored the original afterwards; it does not need to
// execute the Python to do that. assert.match on the read text is the
// same technique tests/mutate.test.ts uses to check a `before`/`after`
// line, one level up at the whole-file level.
function pyVerifierScript(...substrings: string[]): string {
  const checks = substrings
    .map((s) => `assert.ok(text.includes(${JSON.stringify(s)}), ${JSON.stringify(`missing: ${s}`)});`)
    .join("\n");
  return `import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const text = readFileSync(new URL("../src/order.py", import.meta.url), "utf8");
${checks}
`;
}

function pyOrderRepo(verifier: string, extra: Record<string, string> = {}): string {
  return makeRepo({
    "package.json": `${JSON.stringify({ name: "scratch", private: true, type: "module", scripts: { test: "node tests/order.test.mjs" } }, null, 2)}\n`,
    "src/order.py": PY_ORDER_SOURCE,
    "tests/order.test.mjs": verifier,
    ...extra,
  });
}

const PY_SUITE_COMMAND = "node tests/order.test.mjs";

test("a Python file is now mutated: comparison, connective, and arithmetic operators all become candidates", () => {
  const dir = pyOrderRepo(pyVerifierScript("total >= 100", " and is_member", "total - 10"));
  withRepo(dir, () => {
    const result = runCli(dir, ["--paths", "src/order.py", "--command", PY_SUITE_COMMAND, "--format", "json"]);
    const report = JSON.parse(result.stdout) as {
      results: Array<{ mutation: { operator: string; original: string; replacement: string }; verdict: string }>;
    };
    const operators = report.results.map((r) => `${r.mutation.operator}:${r.mutation.original}->${r.mutation.replacement}`).sort();
    assert.deepEqual(operators, [
      "arithmetic:-->+",
      "boolean-connective:and->or",
      "comparison-boundary:>=->>",
    ]);
    assert.ok(
      report.results.every((r) => r.verdict === "killed"),
      result.stdout,
    );
    assert.equal(result.status, 0, result.stdout);
    assert.equal(readFileSync(join(dir, "src/order.py"), "utf8"), PY_ORDER_SOURCE, "the file is restored byte for byte");
  });
});

test("a Python suite with a hole in it: the and/or connective survives, the rest are killed", () => {
  // Checks the boundary and the arithmetic, never the connective: the same
  // structure as HOLED_SUITE for the C-family repo above.
  const dir = pyOrderRepo(pyVerifierScript("total >= 100", "total - 10"));
  withRepo(dir, () => {
    const result = runCli(dir, ["--paths", "src/order.py", "--command", PY_SUITE_COMMAND]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /killed 2, survived 1/);
    assert.match(result.stdout, /src\/order\.py:3:21\s+boolean-connective\s+and to or/);
  });
});

// --- the silence problem: a language with no operator set --------------

test("a repository with only an unsupported-language file: exit 3, named and unmeasured, not silence", () => {
  const dir = makeRepo({
    "package.json": `${JSON.stringify({ name: "scratch", private: true, type: "module", scripts: { test: "node -e 1" } }, null, 2)}\n`,
    "app/main.rb": "def discount(total)\n  total\nend\n",
  });
  withRepo(dir, () => {
    const result = runCli(dir, ["--paths", "app/main.rb"]);
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stdout, /No operator set for these \(1\):/);
    assert.match(result.stdout, /app\/main\.rb/);
    assert.match(result.stdout, /file\(s\) had no operator set for their language.*unmeasured, not passed over \(exit 3\)/);
    assert.equal(readFileSync(join(dir, "app/main.rb"), "utf8"), "def discount(total)\n  total\nend\n");
  });
});

test("a mix of a mutable file and an unsupported-language file: both show up, survivor still wins", () => {
  const dir = orderRepo(HOLED_SUITE, { "app/main.rb": "def discount(total)\n  total\nend\n" });
  withRepo(dir, () => {
    const result = runCli(dir, [
      "--paths",
      "src/order.mjs",
      "app/main.rb",
      "--command",
      SUITE_COMMAND,
      "--format",
      "json",
    ]);
    const report = JSON.parse(result.stdout) as { unsupportedFiles: string[] };
    assert.deepEqual(report.unsupportedFiles, ["app/main.rb"]);
    assert.equal(result.status, 1, result.stdout);
  });
});

test("a test file with an unsupported extension is dropped silently, same as any other test file", () => {
  // Only a real candidate the tool could in principle mutate is reported;
  // a file excluded for being a test file was never going to be mutated
  // anyway, and reporting it would blur "no operator set" with "correctly
  // excluded".
  const dir = orderRepo(STRONG_SUITE, { "spec/main_spec.rb": "describe('x') {}\n" });
  withRepo(dir, () => {
    const result = runCli(dir, ["--paths", "src/order.mjs", "spec/main_spec.rb", "--command", SUITE_COMMAND, "--format", "json"]);
    const report = JSON.parse(result.stdout) as { unsupportedFiles: string[] };
    assert.deepEqual(report.unsupportedFiles, []);
    assert.equal(result.status, 0, result.stdout);
  });
});

// --- Finding 2, redone a second time: exit 3 only for a language this
// tool recognises, and nothing selected vanishes from the report either
// way -----------------------------------------------------------------
//
// Two wrong forms came before this one. First KNOWN_LANGUAGE_EXTENSIONS,
// an allowlist naming Python and the six tree-sitter languages: a file in
// any other real language fell outside it and was dropped without a
// trace. Fixed by turning unsupportedLanguagePaths into a denylist of
// known non-source extensions instead -- but a denylist has to name every
// extension a real repository can hold to stay quiet on it, and missed
// this project's own scripts/pre-publication-check.sh (a plain tracked
// shell script), which then made an ordinary already-merged commit
// (10dd43b) exit 3 for a reason unconnected to code quality.
//
// The fix asks a narrower question instead: exit 3 means this tool could
// not measure something it should have been able to -- a file in a
// language it has a grammar or an operator table for (Ruby, here) that it
// still could not mutate. A language it has never attempted at all --
// Elixir, a shell script -- was never something it claimed to measure, so
// it is reported by name (nothing vanishes) but never turns a clean run
// into exit 3.

test("a recognised language with no operator table folds into exit 3; an unrecognized one next to it does not, and neither vanishes", () => {
  const dir = makeRepo({
    "package.json": `${JSON.stringify({ name: "scratch", private: true, type: "module", scripts: { test: "node -e 1" } }, null, 2)}\n`,
    "lib/discount.ex": "defmodule Discount do\n  def apply(total), do: total\nend\n",
    "lib/main.rb": "def discount(total)\n  total\nend\n",
  });
  withRepo(dir, () => {
    const result = runCli(dir, ["--paths", "lib/discount.ex", "lib/main.rb", "--format", "json"]);
    const report = JSON.parse(result.stdout) as {
      unsupportedFiles: string[];
      unrecognizedFiles: string[];
      planned: number;
      attempted: number;
    };
    assert.deepEqual(report.unsupportedFiles, ["lib/main.rb"]);
    assert.deepEqual(report.unrecognizedFiles, ["lib/discount.ex"]);
    assert.equal(report.planned, 0);
    assert.equal(report.attempted, 0);
    assert.equal(result.status, 3, result.stdout, "the recognised-but-unsupported file still folds into exit 3");
  });
});

test("the same two-file case, in text format: neither file vanishes from the printed report either", () => {
  const dir = makeRepo({
    "package.json": `${JSON.stringify({ name: "scratch", private: true, type: "module", scripts: { test: "node -e 1" } }, null, 2)}\n`,
    "lib/discount.ex": "defmodule Discount do\n  def apply(total), do: total\nend\n",
    "lib/main.rb": "def discount(total)\n  total\nend\n",
  });
  withRepo(dir, () => {
    const result = runCli(dir, ["--paths", "lib/discount.ex", "lib/main.rb"]);
    assert.equal(result.status, 3, result.stdout);
    assert.match(result.stdout, /No operator set for these \(1\):/);
    assert.match(result.stdout, /lib\/main\.rb/);
    assert.match(result.stdout, /Not a language this tool recognises, not measured \(1\):/);
    assert.match(result.stdout, /lib\/discount\.ex/);
  });
});

test("this repository's own commit no longer exits 3 over an ordinary shell script: exit 0, the script named, not counted", () => {
  const dir = makeRepo({
    "package.json": `${JSON.stringify({ name: "scratch", private: true, type: "module", scripts: { test: "node -e 1" } }, null, 2)}\n`,
    "scripts/pre-publication-check.sh": "#!/usr/bin/env bash\nset -euo pipefail\necho ok\n",
  });
  withRepo(dir, () => {
    const result = runCli(dir, ["--paths", "scripts/pre-publication-check.sh", "--format", "json"]);
    const report = JSON.parse(result.stdout) as {
      unsupportedFiles: string[];
      unrecognizedFiles: string[];
      planned: number;
    };
    assert.deepEqual(report.unsupportedFiles, []);
    assert.deepEqual(report.unrecognizedFiles, ["scripts/pre-publication-check.sh"]);
    assert.equal(report.planned, 0);
    assert.equal(result.status, 0, result.stdout);
  });
});

test("a Ruby file alone still reaches exit 3: the real case this signal exists for survives", () => {
  const dir = makeRepo({
    "package.json": `${JSON.stringify({ name: "scratch", private: true, type: "module", scripts: { test: "node -e 1" } }, null, 2)}\n`,
    "lib/main.rb": "def discount(total)\n  total\nend\n",
  });
  withRepo(dir, () => {
    const result = runCli(dir, ["--paths", "lib/main.rb", "--format", "json"]);
    const report = JSON.parse(result.stdout) as { unsupportedFiles: string[]; planned: number };
    assert.deepEqual(report.unsupportedFiles, ["lib/main.rb"]);
    assert.equal(report.planned, 0);
    assert.equal(result.status, 3, result.stdout);
  });
});

test("common data and config extensions still never fold into exit 3", () => {
  // The denylist has to actually keep the noise out: an ordinary commit
  // touching only these files must read as "nothing to mutate" (exit 2),
  // the same as it always did, not as "unmeasured" (exit 3).
  const dir = makeRepo({
    "package.json": `${JSON.stringify({ name: "scratch", private: true, type: "module", scripts: { test: "node -e 1" } }, null, 2)}\n`,
    "README.md": "# scratch\n",
    "config.yml": "on: push\n",
    "notes.txt": "nothing to see here\n",
  });
  withRepo(dir, () => {
    const result = runCli(dir, ["--paths", "README.md", "config.yml", "notes.txt"]);
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stderr, /none of the selected files held a mutation this tool knows how to make/);
  });
});

// --- Finding 1: a grammar that failed to load must never be trusted -----
//
// tree-sitter-python and web-tree-sitter are devDependencies, so an
// adopter's ordinary `npm install` never puts them in node_modules. The
// first version of this repro renamed them out of THIS repository's own
// node_modules, ran the real CLI as a real subprocess against the
// crippled tree, and restored the packages in a finally block. A
// reviewer found two hazards in that: a SIGKILL of the test process (this
// suite's own --help text warns that a SIGKILL "leaves the last mutated
// file mutated on disk" -- the same class of problem one level up -- and
// this suite has been killed mid-run before) skips the finally block and
// leaves the package renamed for whatever runs next on this machine; and
// `node --test tests/*.test.ts` runs test files in parallel processes, so
// another file's in-process import of the real package can land mid-rename
// and fail for a reason that has nothing to do with what it is testing
// (reproduced: 0 successful imports out of 40 attempts during the churn
// window).
//
// ADG_TEST_FORCE_GRAMMAR_FAILURE (see src/code-mask.ts) removes the
// filesystem from the picture entirely: set in this one subprocess's own
// environment, it makes resolveTreeSitterService take the exact same
// "load failed" path a real missing devDependency takes -- grammarLoadFailures
// included -- without ever touching node_modules. Nothing is renamed, so
// there is nothing for a SIGKILL to leave broken and nothing for a
// sibling test file to race against. A subprocess is still required, not
// just an unwarmed service: src/code-mask.ts caches a resolved service
// per process, so the only way to see a fresh load attempt fail is a
// fresh process, which is what runCli already spawns for every test in
// this file.

const DOCSTRING_SOURCE = `def discount(total, is_member):
    """
    Compute the discount. True and False are the boolean literals,
    and 'and'/'or' are the connectives, kept here on purpose.
    """
    if total >= 100 and is_member:
        return total - 10
`;

test("CRITICAL repro: with the Python grammar forced to fail, a Python docstring is never mutated and the file is reported unmeasured, not silently corrupted", () => {
  const dir = makeRepo({
    "package.json": `${JSON.stringify({ name: "scratch", private: true, type: "module", scripts: { test: "node -e 1" } }, null, 2)}\n`,
    "lib/discount.py": DOCSTRING_SOURCE,
  });
  withRepo(dir, () => {
    const result = runCli(
      dir,
      ["--paths", "lib/discount.py", "--command", "node -e 1", "--format", "json"],
      { ADG_TEST_FORCE_GRAMMAR_FAILURE: ".py" },
    );
    const report = JSON.parse(result.stdout) as {
      results: unknown[];
      planned: number;
      grammarFailedFiles: string[];
      grammarAbsentFiles: string[];
    };
    assert.deepEqual(report.results, [], "nothing was ever planned for this file, not even a survivor");
    assert.equal(report.planned, 0);
    // ADG_TEST_FORCE_GRAMMAR_FAILURE forces the present-but-broken branch,
    // never absence: see Finding 2's split of grammarUnavailableFiles into
    // grammarAbsentFiles/grammarFailedFiles in src/mutate.ts.
    assert.deepEqual(report.grammarFailedFiles, ["lib/discount.py"]);
    assert.deepEqual(report.grammarAbsentFiles, []);
    assert.equal(result.status, 3, result.stdout);
    assert.equal(
      readFileSync(join(dir, "lib/discount.py"), "utf8"),
      DOCSTRING_SOURCE,
      "the docstring's True/False and and/or were never touched",
    );
  });
});

test("CRITICAL repro, text format: the printed report names the file and says why, exit 3", () => {
  const dir = makeRepo({
    "package.json": `${JSON.stringify({ name: "scratch", private: true, type: "module", scripts: { test: "node -e 1" } }, null, 2)}\n`,
    "lib/discount.py": DOCSTRING_SOURCE,
  });
  withRepo(dir, () => {
    const result = runCli(dir, ["--paths", "lib/discount.py", "--command", "node -e 1"], {
      ADG_TEST_FORCE_GRAMMAR_FAILURE: ".py",
    });
    assert.equal(result.status, 3, result.stdout);
    assert.match(result.stdout, /Grammar failed to load for these \(1\):/);
    assert.match(result.stdout, /lib\/discount\.py/);
    assert.match(result.stdout, /could not be trusted because their grammar failed to load.*\(exit 3\)/);
    assert.equal(readFileSync(join(dir, "lib/discount.py"), "utf8"), DOCSTRING_SOURCE);
  });
});

test("ADG_TEST_FORCE_GRAMMAR_FAILURE only forces the extensions it names: a Ruby file in the same run is unaffected", () => {
  // Ruby has a grammar (src/tree-sitter-grammars.ts) but no operator
  // table, so it is unsupportedFiles either way -- this pins that forcing
  // .py does not leak into a completely different extension's own,
  // independent "no operator table" report.
  const dir = makeRepo({
    "package.json": `${JSON.stringify({ name: "scratch", private: true, type: "module", scripts: { test: "node -e 1" } }, null, 2)}\n`,
    "lib/discount.py": DOCSTRING_SOURCE,
    "lib/main.rb": "def discount(total)\n  total\nend\n",
  });
  withRepo(dir, () => {
    const result = runCli(
      dir,
      ["--paths", "lib/discount.py", "lib/main.rb", "--command", "node -e 1", "--format", "json"],
      { ADG_TEST_FORCE_GRAMMAR_FAILURE: ".py" },
    );
    const report = JSON.parse(result.stdout) as { grammarFailedFiles: string[]; unsupportedFiles: string[] };
    assert.deepEqual(report.grammarFailedFiles, ["lib/discount.py"]);
    assert.deepEqual(report.unsupportedFiles, ["lib/main.rb"]);
  });
});

// --- Finding 3: a killed subprocess touches node_modules not at all -----
//
// The old node_modules-renaming technique's whole hazard came from a
// filesystem change that a kill could leave half-done. This proves the
// replacement has no such change to leave half-done in the first place:
// spawn a mutate run with ADG_TEST_FORCE_GRAMMAR_FAILURE set, against a
// slow "suite" so the process is still alive to kill, SIGKILL it
// mid-run, and confirm this repository's real node_modules directory
// listing is byte-for-byte the same afterwards -- nothing renamed,
// nothing left half-restored, because nothing was ever touched.

test("a SIGKILLed run using ADG_TEST_FORCE_GRAMMAR_FAILURE leaves node_modules untouched", async () => {
  // src/spawn-command.ts runs the mutation command as the leader of its
  // own detached process group precisely so a timeout can kill the whole
  // group; the flip side, documented in this tool's own --help text, is
  // that a SIGKILL of THIS tool's own process cannot be caught by any
  // handler and never reaches that group at all. The worker below writes
  // its own pid out before it sleeps, so this test can find and sweep it
  // up itself once the assertion is made -- a test-hygiene detail with
  // nothing to do with what is under test here, which is only that
  // node_modules itself is never touched.
  //
  // On Windows, `child` (the CLI) is not the only process with `dir` as
  // its current working directory: spawnCommand's own child there is the
  // shell it runs the mutation command through (`cmd.exe /c node
  // slow.mjs ...`), and that shell inherits `dir` as its cwd too. A plain
  // `child.kill("SIGKILL")` only ends the CLI itself; the shell is its own
  // process, not signalled by killing its parent, and keeps running with
  // that handle open. Killing the worker.pid the worker wrote out (below,
  // in the finally block) cleans up the innermost process but still
  // leaves that shell alive. `taskkill /pid <pid> /t /f` kills the CLI's
  // whole descendant tree -- the shell included -- in one call, which is
  // what actually clears every handle this test's own rmSync needs
  // released. Assumed from how cmd.exe /c hosts a command's process tree;
  // not verified on a Windows runner.
  const pidDir = mkdtempSync(join(tmpdir(), "adg-mutate-grammar-kill-pids-"));
  const dir = makeRepo({
    "package.json": `${JSON.stringify({ name: "scratch", private: true, type: "module", scripts: { test: "node -e 1" } }, null, 2)}\n`,
    "lib/discount.py": DOCSTRING_SOURCE,
    "slow.mjs": `import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], String(process.pid));
await new Promise((r) => setTimeout(r, 60_000));
`,
  });
  const pidFile = join(pidDir, "worker.pid");
  const before = readdirSync(NODE_MODULES).sort();
  try {
    const child = spawn("node", [CLI_PATH, "--paths", "lib/discount.py", "--command", `node slow.mjs ${pidFile}`], {
      cwd: dir,
      env: { ...process.env, ADG_TEST_FORCE_GRAMMAR_FAILURE: ".py" },
      stdio: "ignore",
    });
    const deadline = Date.now() + 5_000;
    while (!existsSync(pidFile) && Date.now() < deadline) {
      await new Promise((resolveTick) => setTimeout(resolveTick, 25));
    }
    assert.ok(existsSync(pidFile), "the mutation command must have started before this test can kill mid-run");
    if (process.platform === "win32" && child.pid !== undefined) {
      try {
        execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
      } catch {
        // already gone
      }
    } else {
      child.kill("SIGKILL");
    }
    await new Promise((resolveExit) => child.on("exit", resolveExit));

    const after = readdirSync(NODE_MODULES).sort();
    assert.deepEqual(after, before, "node_modules must hold exactly the packages it held before the kill");
    for (const name of ["tree-sitter-python", "web-tree-sitter", "tree-sitter-rust"]) {
      assert.ok(existsSync(join(NODE_MODULES, name)), `${name} must still be present, not renamed aside`);
    }
  } finally {
    const workerPid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : undefined;
    if (workerPid !== undefined) {
      try {
        process.kill(workerPid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    rmSyncResilient(pidDir);
    rmSyncResilient(dir);
  }
});

test("once the grammar is back, the same file mutates only the real code, not the docstring", () => {
  // The other half of the same proof: this is not a regression in the
  // ordinary case, only a refusal in the broken one.
  const dir = makeRepo({
    "package.json": `${JSON.stringify({ name: "scratch", private: true, type: "module", scripts: { test: "node -e 1" } }, null, 2)}\n`,
    "lib/discount.py": DOCSTRING_SOURCE,
  });
  withRepo(dir, () => {
    const result = runCli(dir, ["--paths", "lib/discount.py", "--command", "node -e 1", "--format", "json"]);
    const report = JSON.parse(result.stdout) as { grammarAbsentFiles: string[]; grammarFailedFiles: string[]; planned: number };
    assert.deepEqual(report.grammarAbsentFiles, []);
    assert.deepEqual(report.grammarFailedFiles, []);
    assert.equal(report.planned, 3, "only the comparison, connective, and arithmetic in real code, not the docstring");
    assert.equal(readFileSync(join(dir, "lib/discount.py"), "utf8"), DOCSTRING_SOURCE);
  });
});
