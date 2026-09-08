// Tests for hooks/mutate.ts. Every test builds a real git repository in
// os.tmpdir() with a real, tiny test suite, spawns the CLI as a real
// subprocess, and asserts what a caller can actually see: the exit code,
// the printed report, and the bytes on disk afterwards. Nothing here
// touches this repository's own tree, and nothing is mocked: this tool
// writes to source files, so the tests have to watch it write to real ones.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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
    const exited = new Promise<number | null>((resolveExit) => {
      child.on("exit", (code) => resolveExit(code));
    });
    await new Promise((r) => setTimeout(r, 2500));
    child.kill("SIGINT");
    const code = await exited;
    assert.equal(code, 2, stderr);
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
