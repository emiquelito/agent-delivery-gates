#!/usr/bin/env node
// CLI entry point for `adg census`. Runs the test suite at a base commit
// and at HEAD, compares the two censuses, and separately runs the test
// files this change touched against the base source. It answers two
// questions no other check in this package can:
//
//   1. did a test quietly stop running? A suite that lost a test still
//      reports green, and the count is the only thing that moved.
//   2. does a test added beside a fix actually fail without the fix? A
//      test that passes on the old source proves nothing about the change
//      it shipped with.
//
// Contract:
//   census [--base REF] [--command CMD] [--format text|json]
//          [--format-in tap|junit] [--timeout SECONDS] [--no-rerun]
// Exit 0: nothing found and everything was measured. Exit 1: at least one
// finding. Exit 2: could not run as asked. Exit 3: nothing found, but part
// of the run was unmeasured.
//
// Safety, which matters more here than anything else this file does:
//   - the working tree is never touched. The base commit is checked out
//     into a detached `git worktree` under a fresh temporary directory,
//     and `git checkout`, `git stash`, and `git restore` are never run
//     anywhere. Two accidents during this project destroyed uncommitted
//     work through exactly those commands.
//   - the temporary worktree is removed in a finally block, on SIGINT, and
//     on SIGTERM, and the removal refuses to act on any path that is not
//     inside the temporary directory this run created.
//   - the run refuses to start on a dirty working tree, using the same
//     check the other gates use, and says why.
//   - a base run that could not start is reported as a base that could not
//     be compared, never as "every test disappeared". That single
//     confusion is the most dangerous failure this command has, so the
//     guard is explicit and tested.

import process from "node:process";
import { execFileSync, spawnSync } from "node:child_process";
import { spawnCommand, reraiseSignal } from "../src/spawn-command.ts";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  compareCensus,
  exitCodeFor,
  formatReportJson,
  formatReportText,
  findingId,
  mergeCensusFindings,
  mergeRedHalves,
  parseResults,
  resultsLookComplete,
  tapPlan,
  RED_FINDING_KINDS,
  RED_UNMEASURED_KINDS,
  type CompareResult,
  type ResultFormat,
  type TestRecord,
  type Unmeasured,
} from "../src/census.ts";
import { classifyTestPath } from "../src/test-diff-separator.ts";
import { formatDirtyTreeMessage, getGitStatus, resolveRepoRoot } from "../src/clean-tree-gate.ts";
import { isInsideSystemTemp, resolveWithinRoot } from "../src/path-allowlist.ts";

const USAGE = `Usage: census [--base REF] [--command CMD] [--format text|json]
              [--format-in tap|junit] [--timeout SECONDS] [--no-rerun]

Runs the test suite at a base commit and at HEAD, compares the two
censuses, and separately runs the test files this change touched against
the base source.

  --base REF      the commit to compare against (default: the merge-base
                  with the repository's default branch, falling back to
                  HEAD~1 when there is no such branch or the merge-base is
                  HEAD itself)
  --command CMD   the test command (default: "npm test", used only when
                  package.json has a test script)
  --format FORMAT "text" (default) or "json"
  --format-in FMT force the result format: "tap" or "junit". Without this
                  the format is detected from the output, and output in
                  neither format is exit 2, never "no tests found"
  --timeout SECONDS  kill any single run after this long. A run that timed
                  out is unreadable, not empty. The kill takes the run's
                  whole process tree, not just the direct child, so a
                  worker process it started cannot outlive it. On Windows
                  that kill is taskkill /t, which walks the same tree by
                  a different name
  --no-rerun      do not re-run to check whether a disagreement settles
  --help          print this message and exit 0

What it reports:
  disappeared           a test ran at the base commit and does not run at HEAD
  count-dropped         fewer tests ran at HEAD than at the base commit
  not-red-before-green  a test this change added passes against the base
                        source, so it would have passed without the change
  flipped               a test went from pass to fail, or fail to pass
  errored-at-base       a test this change added could not run at all
                        against the base source, usually a missing import.
                        That is an error, not a red run, and it is never
                        counted as red-before-green satisfied
  did-not-settle        the two runs of the same check said different things
                        about one test. Neither the problem nor its absence
                        was established, so the result is unmeasured

The base worktree and its dependencies:
  The base commit is checked out with \`git worktree add --detach\` into a
  temporary directory, which is removed afterwards even when the command
  fails. A fresh worktree has no node_modules. When package.json and every
  lockfile are byte-identical between the base and HEAD, the main
  worktree's install is reused through a symlink, because an identical
  manifest and lockfile describe an identical install. When they differ,
  this exits 2: the base cannot be built comparably, and a base run that
  fails to start must never read as every test disappearing.

Known limits, all of them real:
  - Identity is the file plus the test name. A renamed test therefore
    reads as one test disappearing and another appearing. Two tests that
    share both halves share one identity, which happens whenever the runner
    names no file, as node's TAP does not for a passing test. A test added
    under a name another file already uses is then never checked against
    the base source, and the run says so as an identity-collision it could
    not measure.
  - Two to six full suite runs: HEAD, the base, this change's tests
    against the base source, and a re-run of any of those when a
    disagreement is re-checked. This belongs in pre-push, in CI, or in a
    Stop hook, never in a per-edit hook.
  - A suite that disagrees with itself is reported, not smoothed over. When
    the two runs say different things about one test, in either direction,
    the result is unmeasured and the run exits 3: it is not a finding,
    because the problem was not established, and it is not dropped, because
    its absence was not established either. A flaky suite therefore keeps
    producing exit 3 here until it is fixed.
  - Only TAP and JUnit XML are read. A runner that writes JUnit XML to a
    file has to be told to print it instead, as pytest does with
    \`--junitxml=/dev/stdout\`.
  - The test command runs in the working tree for the HEAD half. A suite
    that writes into its own repository leaves the tree dirty, and that is
    exit 2 at the end of the run.
  - The reused node_modules is the main worktree's own directory, through
    a symlink, not a copy. A suite that writes into node_modules during the
    base run writes into your real install and can corrupt it, and the
    end-of-run tree check cannot see that: node_modules is gitignored, so
    nothing that happens inside it shows up as a dirty tree. Point
    --command at a runner that does not write there, or do not run this
    command over a suite that does.

Exit codes:
  0  nothing found and everything was measured
  1  at least one finding
  2  could not run as asked: a dirty working tree, a base that cannot be
     resolved, no command to run, a package.json or lockfile that differs
     between the base and HEAD, output in neither TAP nor JUnit XML, or a
     tree left dirty afterwards
  3  nothing found, but part of the run was unmeasured: a base run that
     could not be compared, a test that errored against the base source, a
     result the two runs did not agree about, or a result subset that could
     not be read

A run stopped by SIGINT or SIGTERM does not use any of the codes above. On
POSIX it exits with that signal's own convention instead (130 for SIGINT,
143 for SIGTERM), the same as if this tool had never caught the signal at
all, so a shell or CI job can tell "interrupted" apart from every other
outcome. On Windows, which has no such convention to fall back on, it still
exits 2.
`;

/** Lockfiles checked for a byte-identical match between the base and HEAD.
 * Any one of them differing means the base worktree would install
 * something other than what HEAD has, so the two runs would not be
 * comparable and this tool refuses instead of guessing. */
const LOCKFILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
];

function fail(message: string): never {
  process.stderr.write(`census: ${message}\n`);
  process.exit(2);
}

interface ParsedArgs {
  base?: string;
  command?: string;
  format: "text" | "json";
  formatIn?: ResultFormat;
  timeoutSeconds?: number;
  rerun: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { format: "text", rerun: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        result.help = true;
        break;
      case "--base":
        result.base = argv[++i];
        if (result.base === undefined) fail("--base needs a commit argument");
        break;
      case "--command":
        result.command = argv[++i];
        if (result.command === undefined) fail("--command needs a command argument");
        break;
      case "--no-rerun":
        result.rerun = false;
        break;
      case "--format":
        {
          const value = argv[++i];
          if (value !== "text" && value !== "json") {
            fail(`--format must be "text" or "json", got ${value === undefined ? "nothing" : `'${value}'`}`);
          }
          result.format = value;
        }
        break;
      case "--format-in":
        {
          const value = argv[++i];
          if (value !== "tap" && value !== "junit") {
            fail(`--format-in must be "tap" or "junit", got ${value === undefined ? "nothing" : `'${value}'`}`);
          }
          result.formatIn = value;
        }
        break;
      case "--timeout":
        {
          const value = argv[++i];
          const parsed = value === undefined ? Number.NaN : Number(value);
          if (!Number.isFinite(parsed) || parsed <= 0) {
            fail(
              `--timeout must be a positive number of seconds, got ${value === undefined ? "nothing" : `'${value}'`}`,
            );
          }
          result.timeoutSeconds = parsed;
        }
        break;
      default:
        fail(`unknown argument '${arg}'`);
    }
  }
  return result;
}

/**
 * The environment for a child process, with two things removed.
 *
 * Every GIT_* override goes, the same way src/clean-tree-gate.ts does it: a
 * leftover GIT_DIR or GIT_WORK_TREE would point git at a different
 * repository, and this tool adds and removes worktrees.
 *
 * NODE_TEST_CONTEXT goes as well. Node's own test runner sets it for the
 * processes it starts, and a `node --test` that sees it prints its results
 * in a private wire format instead of TAP. Left in place, running this
 * command from inside a test suite, or from any tool that runs under one,
 * would make every run unreadable and every result exit 2.
 */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("GIT_") || key === "NODE_TEST_CONTEXT") continue;
    env[key] = value;
  }
  return env;
}

function runGit(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, env: cleanEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const detail = typeof e.stderr === "string" && e.stderr.trim() !== "" ? e.stderr.trim() : e.message ?? String(err);
    fail(`git failed (${args.join(" ")}): ${detail}`);
  }
}

/** A git call whose failure is an answer, not an error. */
function tryGit(cwd: string, args: string[]): string | null {
  const result = spawnSync("git", args, {
    cwd,
    env: cleanEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined || result.status !== 0) return null;
  return result.stdout;
}

// --- resolving the base --------------------------------------------------------

interface BaseCommit {
  sha: string;
  reason: string;
}

/** The repository's default branch, as a ref this repository can resolve,
 * or null when there is no such branch. */
function detectDefaultBranch(repoRoot: string): string | null {
  const symbolic = tryGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (symbolic !== null && symbolic.trim() !== "") return symbolic.trim();
  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    if (tryGit(repoRoot, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`]) !== null) return candidate;
  }
  return null;
}

/**
 * The commit to compare against. An explicit --base wins. Otherwise the
 * merge-base with the default branch, which is what a change on a branch
 * should be measured against. On the default branch itself that merge-base
 * is HEAD, which would compare HEAD with itself and report nothing at all,
 * so that case falls back to HEAD~1 along with the no-default-branch case.
 * A base that cannot be resolved at all is exit 2: comparing against a
 * commit nobody named would be a made-up answer.
 */
function resolveBase(args: ParsedArgs, repoRoot: string): BaseCommit {
  if (args.base !== undefined) {
    const sha = tryGit(repoRoot, ["rev-parse", "--verify", "--quiet", `${args.base}^{commit}`]);
    if (sha === null || sha.trim() === "") {
      fail(`--base '${args.base}' does not name a commit this repository can resolve`);
    }
    return { sha: sha.trim(), reason: `--base ${args.base}` };
  }

  const headSha = runGit(repoRoot, ["rev-parse", "HEAD"]).trim();
  const defaultBranch = detectDefaultBranch(repoRoot);
  if (defaultBranch !== null) {
    const mergeBase = tryGit(repoRoot, ["merge-base", "HEAD", defaultBranch]);
    const sha = mergeBase === null ? "" : mergeBase.trim();
    if (sha !== "" && sha !== headSha) {
      return { sha, reason: `merge-base with ${defaultBranch}` };
    }
  }

  const parent = tryGit(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD~1^{commit}"]);
  if (parent === null || parent.trim() === "") {
    fail(
      "the base could not be resolved: there is no default branch to take a merge-base with, and HEAD has no parent. " +
        "Name one with --base REF",
    );
  }
  const why =
    defaultBranch === null
      ? "HEAD~1; no default branch was found"
      : `HEAD~1; the merge-base with ${defaultBranch} is HEAD itself`;
  return { sha: parent.trim(), reason: why };
}

// --- the command ---------------------------------------------------------------

/** The command to run: the one given, or "npm test" when package.json has
 * a test script. With neither, this exits 2. A census with no command
 * measures nothing, and reporting that as a pass would be the exact
 * failure this project exists to catch. */
function resolveCommand(args: ParsedArgs, repoRoot: string): string {
  if (args.command !== undefined) {
    if (args.command.trim() === "") fail("--command was empty");
    return args.command;
  }
  const pkgPath = join(repoRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
      if (typeof pkg.scripts?.test === "string" && pkg.scripts.test.trim() !== "") return "npm test";
    } catch (err) {
      fail(`could not read package.json (${(err as Error).message})`);
    }
  }
  fail("no command to run: pass --command CMD, or add a test script to package.json");
}

// --- running the suite ---------------------------------------------------------

interface RunOutput {
  stdout: string;
  stderr: string;
  status: number | null;
  timedOut: boolean;
  /** Why the run never completed, when spawnSync itself could not finish
   * it. A maxBuffer overflow arrives here as ENOBUFS, and the output kept
   * up to that point is a truncated census, not a small suite. */
  failure: string | null;
}

/** Runs the command in its own process group (see src/spawn-command.ts)
 * and, at the timeout or the output cap below, kills that whole group,
 * not just the direct child: a runner that starts worker processes of
 * its own used to leave them running past the timeout, orphaned once the
 * direct child alone was killed. */
async function runCommand(command: string, cwd: string, timeoutMs?: number): Promise<RunOutput> {
  const result = await spawnCommand(command, {
    cwd,
    env: cleanEnv(),
    timeoutMs,
    maxBufferBytes: 64 * 1024 * 1024,
  });
  let failure: string | null = null;
  if (result.outputOverflowed) {
    failure = "the run printed more output than this tool will hold, so its results were cut off part way through";
  } else if (result.spawnError !== undefined) {
    failure = `the run could not be completed (${result.spawnError})`;
  } else if (!result.timedOut && result.killedBySignal !== null) {
    failure = `the run was killed by ${result.killedBySignal} before it finished printing`;
  }
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
    timedOut: result.timedOut,
    failure,
  };
}

interface RunCensus {
  tests: TestRecord[];
  format: ResultFormat;
}

/**
 * Runs the command and parses its output, or returns why it could not be
 * read. stdout is tried on its own first: a runner that writes progress to
 * stderr would otherwise have that text spliced into the middle of its own
 * TAP or XML. Only when stdout alone is unreadable are the two tried
 * together, which is what makes a runner that prints everything to stderr
 * work at all.
 */
async function runAndParse(
  command: string,
  cwd: string,
  args: ParsedArgs,
  timeoutMs?: number,
): Promise<RunCensus | { error: string }> {
  const run = await runCommand(command, cwd, timeoutMs);
  if (run.timedOut) {
    return { error: `the run in ${cwd} was killed at the timeout, so its results were never printed` };
  }
  // A run spawnSync could not finish is exactly as unreadable as one that
  // timed out. ENOBUFS is the one that bites: the output up to the overflow
  // parses cleanly, and the tests that never got printed then read as tests
  // that appeared at HEAD.
  if (run.failure !== null) return { error: `${run.failure} (in ${cwd})` };
  const first = parseResults(run.stdout, args.formatIn);
  if (!("error" in first)) return checkComplete(run, run.stdout, first.format, first.tests, cwd);
  const joined = `${run.stdout}\n${run.stderr}`;
  const both = parseResults(joined, args.formatIn);
  if (!("error" in both)) return checkComplete(run, joined, both.format, both.tests, cwd);
  return { error: both.error };
}

/**
 * The two ways output that parsed is still not a census.
 *
 * A TAP plan says how many results the run meant to print. Fewer than that
 * means the run died mid-stream, and the tests it never reached would
 * otherwise read as tests appearing at HEAD, with the red-before-green run
 * then finding them all passing. That is a false accusation built out of a
 * crash, and this is the check that stops it.
 *
 * A run that exited non-zero having printed neither a plan nor a summary
 * never got to the end of its own output either. A failing suite prints
 * both, so this refuses the crash and not the red run.
 */
function checkComplete(
  run: RunOutput,
  text: string,
  format: ResultFormat,
  tests: TestRecord[],
  cwd: string,
): RunCensus | { error: string } {
  if (format === "tap") {
    const plan = tapPlan(text);
    if (plan !== null && plan.printed !== plan.planned) {
      return {
        error:
          `the run in ${cwd} printed a TAP plan of ${plan.planned} result(s) but ${plan.printed} of them, so its ` +
          "output stops part way through and is not a census of the suite",
      };
    }
  }
  if (run.status !== 0 && !resultsLookComplete(text, format)) {
    return {
      error:
        `the run in ${cwd} exited ${run.status === null ? "without a status" : String(run.status)} without printing ` +
        "a plan or a summary, so it never finished printing its results",
    };
  }
  return { format, tests };
}

// --- the temporary base worktree ------------------------------------------------

interface Worktree {
  /** The temporary directory this run created, and the only path the
   * cleanup below will ever delete. */
  tmpRoot: string;
  /** The base commit's worktree, inside tmpRoot. */
  dir: string;
  /** Whether a node_modules symlink was made inside it. */
  linkedModules: boolean;
}

/**
 * Removes the temporary worktree. Refuses any path that is not inside the
 * temporary directory this run created, which is itself inside the system
 * temp directory: this function must never be able to act on the caller's
 * own working tree, whatever it is handed.
 *
 * The node_modules symlink is unlinked first, by hand. It points at the
 * main worktree's real install, and removing the link before anything else
 * walks the tree means nothing that walks it can follow the link into the
 * caller's own dependencies.
 */
function removeWorktree(repoRoot: string, worktree: Worktree): void {
  // The decision itself lives in src/path-allowlist.ts, next to the
  // containment rule it applies, so it can be exercised on its own. Both
  // sides are resolved there: a string comparison would refuse the very
  // directory this run created on macOS, where the temp directory is a
  // symlink into /private.
  const tmpRoot = resolve(worktree.tmpRoot);
  if (!isInsideSystemTemp(worktree.tmpRoot, tmpdir(), realpathSync, process.cwd())) {
    process.stderr.write(
      `census: refusing to remove '${worktree.tmpRoot}', which is not inside the system temp directory\n`,
    );
    return;
  }
  if (worktree.linkedModules) {
    const link = join(worktree.dir, "node_modules");
    try {
      if (lstatSync(link).isSymbolicLink()) unlinkSync(link);
    } catch {
      // Already gone, or never made. Either way there is nothing to unlink.
    }
  }
  spawnSync("git", ["worktree", "remove", "--force", worktree.dir], {
    cwd: repoRoot,
    env: cleanEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch (err) {
    process.stderr.write(`census: could not remove '${tmpRoot}' (${(err as Error).message})\n`);
  }
  spawnSync("git", ["worktree", "prune"], {
    cwd: repoRoot,
    env: cleanEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// --- the dependency question ----------------------------------------------------

/** A tracked file's bytes at one commit, or null when the commit does not
 * hold it. */
function blobAt(repoRoot: string, sha: string, path: string): string | null {
  return tryGit(repoRoot, ["show", `${sha}:${path}`]);
}

interface DependencyPlan {
  /** Whether to symlink the main worktree's node_modules into the base. */
  symlink: boolean;
  note: string | null;
}

/**
 * Decides how the base worktree gets its dependencies, and refuses when it
 * cannot get comparable ones.
 *
 * A fresh worktree has no node_modules. When package.json and every
 * lockfile are byte-identical between the base commit and HEAD, the
 * installed tree they describe is the same tree, so the main worktree's
 * install is reused through a symlink: that is a great deal faster than a
 * second install and it writes nothing into the caller's repository. When
 * any of them differ, this exits 2. Installing something other than what
 * HEAD has would make the two runs incomparable, and a base run that fails
 * to start would then look exactly like every test disappearing, which is
 * the worst thing this command could report.
 */
function planDependencies(repoRoot: string, baseSha: string): DependencyPlan {
  const headManifest = blobAt(repoRoot, "HEAD", "package.json");
  const baseManifest = blobAt(repoRoot, baseSha, "package.json");
  if (headManifest === null && baseManifest === null) {
    return { symlink: false, note: null };
  }
  if (headManifest !== baseManifest) {
    fail(
      "package.json differs between the base commit and HEAD, so the base cannot be built comparably. " +
        "Run with --base pointing at a commit that shares this package.json, or install the base's dependencies yourself " +
        "and point --command at a runner that needs none",
    );
  }
  for (const lockfile of LOCKFILES) {
    const head = blobAt(repoRoot, "HEAD", lockfile);
    const base = blobAt(repoRoot, baseSha, lockfile);
    if (head === base) continue;
    fail(
      `${lockfile} differs between the base commit and HEAD, so the base cannot be built comparably. ` +
        "The base worktree would install something other than what HEAD has, and a base run that fails to start " +
        "would read as every test disappearing. Pick a base that shares this lockfile with --base",
    );
  }
  if (!existsSync(join(repoRoot, "node_modules"))) {
    return {
      symlink: false,
      note: "There is no node_modules in the working tree, so none was linked into the base worktree.",
    };
  }
  return { symlink: true, note: null };
}

// --- the test files this change touched -------------------------------------------

/**
 * The test files this change added or modified, as repository-relative
 * paths. Whether a path is a test file is answered by classifyTestPath in
 * src/test-diff-separator.ts and nowhere else, so this command and the
 * test-diff gate can never disagree about what a test file is. Two copies
 * of that one decision have already drifted apart three times in this
 * project.
 */
function changedTestFiles(repoRoot: string, baseSha: string): string[] {
  const output = runGit(repoRoot, ["diff", "--name-status", "--find-renames", baseSha, "HEAD"]);
  const paths: string[] = [];
  for (const line of output.split("\n")) {
    if (line.trim() === "") continue;
    const fields = line.split("\t");
    const status = fields[0] ?? "";
    // A rename entry carries the old path and the new one; the new path is
    // the one that exists at HEAD and the one to copy.
    const path = status.startsWith("R") || status.startsWith("C") ? fields[2] : fields[1];
    if (path === undefined || path === "") continue;
    if (status.startsWith("D")) continue;
    if (!classifyTestPath(path).isTest) continue;
    paths.push(path);
  }
  return [...new Set(paths)].sort();
}

/**
 * Copies each of this change's test files into the base worktree, over the
 * base's own copy where it has one. This is the red-before-green check:
 * the new tests, against the old source. Every destination is checked to
 * be inside the base worktree before anything is written, because a path
 * that escaped it would be a write into a directory nobody asked for.
 */
function copyTestFilesInto(repoRoot: string, worktreeDir: string, paths: string[]): void {
  for (const path of paths) {
    const from = join(repoRoot, path);
    if (!existsSync(from)) continue;
    // Both sides as real paths. A destination the base worktree does not
    // hold yet resolves to its nearest existing ancestor with the rest
    // reattached, so a file about to be created passes while a path whose
    // parent links out of the worktree does not.
    const found = resolveWithinRoot(worktreeDir, path, realpathSync, worktreeDir);
    if (!found.contained || found.realPath === found.realRoot) {
      fail(`'${path}' resolves outside the base worktree; refusing to write there`);
    }
    const to = found.realPath;
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
}

// --- the re-run --------------------------------------------------------------

/**
 * Whether a census that parsed cleanly is still no census at all: it holds
 * no test while the run it is compared with holds some. A base like that did
 * not really run, and comparing against it reports every test as new and
 * hands a clean bill to a suite that lost tests.
 *
 * Every base run goes through this, the first one and every re-run. A re-run
 * that collected nothing used to make every finding from the first run look
 * like a disagreement that settled, so the whole report was dropped as flaky
 * and the command exited 0. That made the default mode less safe than
 * --no-rerun, which is the opposite of what a re-run is for. A re-run that
 * collected nothing is unreadable, which is not the same as a re-run that
 * disagreed: it is not evidence of anything, so it settles nothing and
 * unsettles nothing either.
 */
function heldNoTests(tests: TestRecord[], comparedWith: number): boolean {
  return tests.length === 0 && comparedWith > 0;
}

// --- main -------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  let repoRoot: string;
  try {
    repoRoot = resolveRepoRoot(process.cwd());
  } catch (err) {
    fail((err as Error).message);
  }

  // Safety first. This command runs a whole test suite twice or more, and
  // adds a worktree; it will not do any of that on top of work no commit
  // holds. The same check the other gates use, from the same module.
  let status;
  try {
    status = getGitStatus(repoRoot);
  } catch (err) {
    fail((err as Error).message);
  }
  if (status.dirtyLines.length > 0) {
    process.stderr.write(`${formatDirtyTreeMessage(status.dirtyLines)}\n`);
    fail(
      "refusing to run on a dirty working tree: the base commit is checked out into a second worktree and the " +
        "suite is run more than once, and neither is safe to do on top of uncommitted work. Commit it or put it away first",
    );
  }

  const base = resolveBase(args, repoRoot);
  const command = resolveCommand(args, repoRoot);
  const dependencies = planDependencies(repoRoot, base.sha);
  const testFiles = changedTestFiles(repoRoot, base.sha);
  const timeoutMs = args.timeoutSeconds === undefined ? undefined : Math.round(args.timeoutSeconds * 1000);
  const notes: string[] = [];
  if (dependencies.note !== null) notes.push(dependencies.note);

  const tmpRoot = mkdtempSync(join(tmpdir(), "adg-census-"));
  const worktree: Worktree = { tmpRoot, dir: join(tmpRoot, "base"), linkedModules: false };

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    removeWorktree(repoRoot, worktree);
  };
  // Set, not just read, by onSignal below: reraiseSignal ends this process
  // asynchronously, by handing the signal back to Node's own default
  // handling, so the steps still inside the try block below keep running
  // for a little while longer. Without this flag one of them could reach a
  // fail() call over output a signal-killed run never finished printing,
  // which would exit 2 before the re-raised signal actually lands.
  let interrupted = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (interrupted) return;
    interrupted = true;
    cleanup();
    process.stderr.write(`\ncensus: interrupted by ${signal}; the temporary base worktree was removed\n`);
    reraiseSignal(signal, 2);
  };
  const onInt = (): void => onSignal("SIGINT");
  const onTerm = (): void => onSignal("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  // A finally block does not run when something calls process.exit, and
  // every refusal below this point does exactly that. Without this handler
  // a run that could not read its own output left the base worktree on
  // disk, which a test caught. The handler is synchronous, which is the
  // only kind an exit handler may be.
  process.on("exit", cleanup);

  let report = "";
  let exitCode: 0 | 1 | 3 = 0;
  try {
    runGit(repoRoot, ["worktree", "add", "--detach", "--quiet", worktree.dir, base.sha]);
    if (dependencies.symlink) {
      // The manifest and every lockfile are byte-identical between the two
      // commits, so the install they describe is the same install. A
      // symlink is used instead of a copy because a second install of an
      // identical tree would cost minutes and buy nothing.
      symlinkSync(join(repoRoot, "node_modules"), join(worktree.dir, "node_modules"), "dir");
      worktree.linkedModules = true;
    }

    // Yield once before each long-running step, so a signal that arrived
    // while a suite was running is handled while the worktree is still
    // this run's responsibility. Everything else here is synchronous.
    await new Promise((tick) => setImmediate(tick));
    const headRun = await runAndParse(command, repoRoot, args, timeoutMs);
    if (interrupted) return;
    if ("error" in headRun) {
      fail(`the run at HEAD could not be read: ${headRun.error}`);
    }

    await new Promise((tick) => setImmediate(tick));
    const baseRun = await runAndParse(command, worktree.dir, args, timeoutMs);
    if (interrupted) return;
    if ("error" in baseRun) {
      fail(
        `the run at the base commit could not be read: ${baseRun.error}. ` +
          "This is reported as a run that could not happen, never as a suite that lost every test",
      );
    }

    // The explicit guard. A base run that started, printed a readable
    // result, and found no tests at all, while HEAD found some, is a base
    // that did not really run: a missing dependency, a runner that could
    // not collect anything. Comparing against it would report every test
    // at HEAD as new and, worse, would hand a clean bill to a suite that
    // lost tests. So the base census is dropped and said to be dropped.
    let baseTests: TestRecord[] | null = baseRun.tests;
    if (heldNoTests(baseRun.tests, headRun.tests.length)) {
      baseTests = null;
      notes.push(
        "The base run printed readable output but held no tests at all, while HEAD held " +
          `${headRun.tests.length}. That is a base that did not really run, so its census was dropped: nothing here ` +
          "claims a test disappeared.",
      );
    }

    // Census findings first, while the base worktree still holds the base's
    // own test files. Copying this change's tests in has to come after,
    // or the base run's re-run would be measuring the new tests.
    const censusResult = compareCensus({ base: baseTests, head: headRun.tests, redRun: null });
    let runs = 2;
    let unsettled = 0;
    let censusSettlement: { held: Set<string>; unsettled: Unmeasured[] } | null = null;

    if (args.rerun && censusResult.findings.length > 0 && baseTests !== null) {
      await new Promise((tick) => setImmediate(tick));
      const headAgain = await runAndParse(command, repoRoot, args, timeoutMs);
      await new Promise((tick) => setImmediate(tick));
      const baseAgain = await runAndParse(command, worktree.dir, args, timeoutMs);
      if (interrupted) return;
      runs += 2;
      if ("error" in headAgain || "error" in baseAgain) {
        notes.push(
          "A re-run meant to check a disagreement for flakiness could not be read, so every finding below is " +
            "reported as it stood on the first run.",
        );
      } else if (heldNoTests(baseAgain.tests, headAgain.tests.length) || heldNoTests(baseAgain.tests, baseTests.length)) {
        // The same guard the first base run gets. Without it an empty base
        // re-run is a census of nothing, every finding from the first run
        // fails to recur against it, and the whole report is dropped as
        // flaky. That is a run erasing its own findings, so the re-run is
        // called unreadable instead, which it is.
        notes.push(
          "The base re-run printed readable output but held no tests at all, so it was treated as a re-run that " +
            "could not be read and not as evidence that anything below is flaky. Every finding is reported as it " +
            "stood on the first run.",
        );
      } else {
        const second = compareCensus({ base: baseAgain.tests, head: headAgain.tests, redRun: null });
        const settled = mergeCensusFindings(censusResult.findings, second.findings);
        unsettled += settled.unsettled.length;
        censusSettlement = { held: new Set(settled.findings.map(findingId)), unsettled: settled.unsettled };
      }
    }

    // The red-before-green half: this change's test files, over the base's
    // own copies, against the base source. With no test file touched there
    // is nothing to copy, so the run would be the base run a second time
    // and would report every test that appeared as unable to load. That
    // would be a made-up answer, so the run is skipped and said to be.
    let redTests: TestRecord[] | null = null;
    if (testFiles.length > 0) {
      copyTestFilesInto(repoRoot, worktree.dir, testFiles);
      await new Promise((tick) => setImmediate(tick));
      const redRun = await runAndParse(command, worktree.dir, args, timeoutMs);
      if (interrupted) return;
      runs += 1;
      if ("error" in redRun) {
        notes.push(
          `The run of this change's test files against the base source could not be read: ${redRun.error}. ` +
            "No test added by this change is claimed to have been red before it.",
        );
      } else {
        redTests = redRun.tests;
      }
    }

    let result: CompareResult = compareCensus({ base: baseTests, head: headRun.tests, redRun: redTests });

    const redSuspects =
      result.findings.filter((finding) => RED_FINDING_KINDS.has(finding.kind)).length +
      result.unmeasured.filter((item) => RED_UNMEASURED_KINDS.has(item.kind)).length;
    if (args.rerun && redSuspects > 0 && redTests !== null) {
      await new Promise((tick) => setImmediate(tick));
      const redAgain = await runAndParse(command, worktree.dir, args, timeoutMs);
      if (interrupted) return;
      runs += 1;
      if ("error" in redAgain) {
        notes.push(
          "A re-run of this change's tests against the base source could not be read, so the red-before-green " +
            "results below are reported as they stood on the first run.",
        );
      } else if (redTests !== null && redAgain.tests.length === 0 && redTests.length > 0) {
        notes.push(
          "The re-run of this change's tests against the base source printed readable output but held no tests at " +
            "all, so it was treated as a re-run that could not be read. The red-before-green results below are " +
            "reported as they stood on the first run.",
        );
      } else {
        const second = compareCensus({ base: baseTests, head: headRun.tests, redRun: redAgain.tests });
        const merged = mergeRedHalves(result, second);
        result = merged.result;
        unsettled += merged.unsettled;
      }
    }

    if (censusSettlement !== null) {
      // A census finding both runs reported stands. One only a single run
      // reported is a did-not-settle item, so it leaves the findings and
      // joins the unmeasured list, where it costs exit 3 and never exit 0.
      const settlement = censusSettlement;
      const kept = result.findings.filter(
        (finding) => RED_FINDING_KINDS.has(finding.kind) || settlement.held.has(findingId(finding)),
      );
      result = { ...result, findings: kept, unmeasured: [...result.unmeasured, ...settlement.unsettled] };
    }

    if (testFiles.length === 0) {
      notes.push(
        "This change added or modified no test file, so nothing was run against the base source and no test is " +
          "claimed to have been red before it. A fix with no test beside it is what the red-before-green rule is " +
          "about, and no tool can supply the missing test.",
      );
    }

    const reportInput = {
      command,
      baseRef: base.sha.slice(0, 12),
      baseReason: base.reason,
      headFormat: headRun.format,
      baseFormat: baseTests === null ? null : baseRun.format,
      changedTestFiles: testFiles,
      result,
      unsettled,
      runs,
      notes,
    };
    report = args.format === "json" ? formatReportJson(reportInput) : `${formatReportText(reportInput)}\n`;
    exitCode = exitCodeFor(result);
  } finally {
    cleanup();
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  }

  process.stdout.write(report);

  // The working tree has to be exactly as it was found. The HEAD half runs
  // the caller's own test command in the caller's own tree, and a suite
  // that writes into its repository would leave something behind. Saying
  // so is exit 2 whatever the comparison found: a tool that quietly
  // changed the tree is worse than no tool at all.
  let after;
  try {
    after = getGitStatus(repoRoot);
  } catch (err) {
    fail(`could not confirm the tree is clean after the run (${(err as Error).message})`);
  }
  if (after.dirtyLines.length > 0) {
    process.stderr.write(`${formatDirtyTreeMessage(after.dirtyLines)}\n`);
    fail("the working tree is dirty after the run; the test command wrote to it, so check these paths first");
  }

  process.exit(exitCode);
}

main().catch((err: unknown) => {
  process.stderr.write(`census: ${(err as Error).message}\n`);
  process.exit(2);
});
