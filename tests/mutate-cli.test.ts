// Tests for hooks/mutate.ts. Every test builds a real git repository in
// os.tmpdir() with a real, tiny test suite, spawns the CLI as a real
// subprocess, and asserts what a caller can actually see: the exit code,
// the printed report, and the bytes on disk afterwards. Nothing here
// touches this repository's own tree, and nothing is mocked: this tool
// writes to source files, so the tests have to watch it write to real ones.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(HERE, "..", "hooks", "mutate.ts");

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(cwd: string, args: string[]): RunResult {
  const result = spawnSync("node", [CLI_PATH, ...args], { cwd, encoding: "utf8" });
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
    rmSync(dir, { recursive: true, force: true });
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
      [CLI_PATH, "--paths", "src/order.mjs", "--command", "node -e 'setTimeout(()=>process.exit(0),1000)'"],
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
    rmSync(dir, { recursive: true, force: true });
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
      "node -e ''",
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
      rmSync(pidDir, { recursive: true, force: true });
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

const SIGINT_LEAK_RUN_MJS = `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const pidDir = process.argv[2];
const here = dirname(fileURLToPath(import.meta.url));
const worker = spawn(process.execPath, [join(here, "sigint-leak-worker.mjs")], { stdio: "ignore" });
writeFileSync(join(pidDir, worker.pid + ".pid"), String(worker.pid));
worker.on("exit", (code) => process.exit(code ?? 0));
`;

const SIGINT_LEAK_WORKER_MJS = `process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`;

// recordedPids, isAlive, and waitForNoneAlive are already defined above for
// the timed-out-mutation test and are reused here as-is.

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
    const pids = recordedPids(pidDir);
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
    assert.deepEqual(survivors, [], "a worker process outlived mutate after a real SIGINT");
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
    rmSync(pidDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
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
const here = dirname(fileURLToPath(import.meta.url));
const worker = spawn(process.execPath, [join(here, "sigint-leak-worker.mjs")], { stdio: "ignore" });
writeFileSync(join(pidDir, worker.pid + ".pid"), String(worker.pid));
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
    const pids = recordedPids(pidDir);
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
      "a worker process outlived mutate after a real SIGINT sent during a post-baseline mutation",
    );
    assert.match(stderr, /interrupted by SIGINT/);
  } finally {
    rmSync(pidDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
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
    rmSync(pidDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- mutate has an output ceiling, the same as induce and census (finding 2) --

test("a mutation that floods stdout is killed well before its timeout, not let run unbounded", () => {
  // shouldFlood(0) is false on the original `<` (0 < 0), so the baseline
  // exits at once. Mutating `<` to `<=` makes it true (0 <= 0), and the
  // mutated run floods stdout forever, through a real `yes` subprocess so
  // the flood is not throttled by this Node process's own event loop.
  // With no cap that run has nothing to stop it short of the timeout;
  // with a cap it is killed within a couple of seconds of crossing it,
  // long before a generous timeout fires.
  const dir = makeRepo({
    "src/gate.mjs": "export function shouldFlood(n) {\n  return n < 0;\n}\n",
    "flood-run.mjs": `import { shouldFlood } from "./src/gate.mjs";
import { spawnSync } from "node:child_process";
if (shouldFlood(0)) {
  spawnSync("yes", [], { stdio: "inherit" });
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

test("a mutation whose run is killed by a signal, not by the timeout or the output cap, is its own verdict too (finding 2)", () => {
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
});
