#!/usr/bin/env node
// CLI entry point for `adg mutate`. Breaks source code in a fixed set of
// known ways, one break at a time, runs a command after each break, and
// reports which breaks the command failed to notice. A break nothing
// noticed means no test is holding that line: the suite runs the code, it
// does not prove it.
//
// Contract:
//   mutate [--rev REV] [--range A..B] [--staged] [--paths PATH...]
//          [--command CMD] [--max N] [--timeout SECONDS] [--format text|json]
// Exit 0: every attempted mutation got a verdict and none survived. Exit 1:
// at least one mutation survived. Exit 2: could not run as asked, which
// includes a dirty working tree, a baseline run that was already failing,
// no command to run, and a tree left dirty afterwards. Exit 3: nothing
// survived, but at least one mutation never got a verdict. A run that could
// not happen, and a run that could not judge part of its own work, must
// never read the same as a run that judged all of it and found nothing.
//
// This tool writes to the caller's own source files, so the safety rules
// come first and are not optional:
//   - it refuses to start on a dirty working tree, using the same check
//     hooks/pre-mutation-clean-tree.ts uses, so there is always a committed
//     copy to compare against. Under --staged, whose whole job is to mutate
//     the staged diff, the requirement is narrower: staged changes are
//     expected, and the unstaged tree has to be clean;
//   - it refuses a --paths target that git ignores, because an ignored file
//     has no committed copy to fall back on;
//   - it holds every original in memory and restores it in a finally block,
//     on SIGINT, and on SIGTERM;
//   - it checks the tree is clean again at the end and fails loudly if not.
// The one hole none of that closes: a SIGKILL or a hard crash cannot be
// caught, and leaves the last mutated file mutated on disk. --help says so,
// and says how to get a tracked file back.

import process from "node:process";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, statSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnCommand } from "../src/spawn-command.ts";
import {
  exitCodeFor,
  formatReportJson,
  formatReportText,
  planMutations,
  selectMutablePaths,
  type MutationResult,
  type SourceFile,
} from "../src/mutate.ts";
import { runOneMutation, type CommandRun } from "../src/mutate-runner.ts";
import {
  formatDirtyTreeMessage,
  getGitStatus,
  resolveRepoRoot,
  unstagedDirtyLines,
} from "../src/clean-tree-gate.ts";
import { resolveWithinRoot } from "../src/path-allowlist.ts";

const DEFAULT_MAX = 25;

/** How much output one run may print before Node kills it. mutate never
 * reads stdout or stderr, but spawnCommand still buffers both in memory
 * for the run's whole lifetime, and this tool runs the command once per
 * mutation. With no cap that buffer is unbounded and repeats once per
 * mutation attempted; the old spawnSync had an implicit 1 MB cap, so this
 * is the same size induce and census already use, kept consistent across
 * all three instead of picking a fourth number. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Bounds the baseline run when the caller gave no --timeout. The
 * per-mutation default (baselineMs * 3 + 10s, below) is derived from how
 * long the baseline took, so the baseline itself cannot use that formula:
 * there is no prior duration yet to derive it from. An explicit --timeout
 * still applies to the baseline the same way it applies to every
 * mutation, since the caller asked for that same bound on "any single
 * run"; only the no-flag case needs a stand-in. Ten minutes is generous
 * enough not to fail an ordinary slow suite while still bounding a
 * baseline that hangs, so a run this tool cannot interrupt itself does
 * not depend entirely on an external kill.
 */
const DEFAULT_BASELINE_TIMEOUT_MS = 10 * 60 * 1000;

const USAGE = `Usage: mutate [--rev REV] [--range A..B] [--staged] [--paths PATH...]
              [--command CMD] [--max N] [--timeout SECONDS] [--format text|json]

Breaks source code in known ways, one break per run of the command, and
reports which breaks the command did not notice. A surviving break means no
test read that line closely enough to fail.

  --rev REV       mutate the source files changed by that commit (default: HEAD)
  --range A..B    mutate the source files changed across that range
  --staged        mutate the source files in the staged diff. Staged changes
                  are expected here; the unstaged tree has to be clean
  --paths PATH... mutate exactly these files. A path git ignores is refused
  --command CMD   the command to run after each break (default: "npm test",
                  used only when package.json has a test script)
  --max N         attempt at most N mutations (default: ${DEFAULT_MAX}); each one
                  runs the whole command. Mutations are ordered by path, then
                  line, then column, and the cap keeps the first N of that
                  order, so a file early in the order can use the whole
                  budget and a file after it is never touched at all. The
                  report says how many were planned and how many attempted,
                  and says plainly when the two differ
  --timeout SECONDS  per-mutation timeout (default: three times the baseline
                  run plus ten seconds). Also bounds the baseline run
                  itself, which has no prior duration to derive a default
                  from; with no --timeout the baseline gets a fixed ten
                  minutes instead. At the timeout, the command's whole
                  process tree is killed, not just the command itself, so
                  a worker process it started cannot outlive it. On
                  Windows that kill is taskkill /t, which walks the same
                  tree by a different name.
  --format FORMAT "text" (default) or "json"
  --help          print this message and exit 0

Exactly one of --rev, --range, --staged, --paths may be given.

Operators, applied one at a time:
  comparison boundary  <  to <=,  <= to <,  >  to >=,  >= to >
  equality             === to !==, !== to ===, == to !=, != to ==
  boolean connective   && to ||, || to &&
  boolean literal      true to false, false to true
  arithmetic           + to -, - to +

Test files are never mutated, and neither is a comment line, an import
line, or text inside a string literal.

Safety, and the one limit with no fix:
  Every file this tool writes to is held in memory and put back in a finally
  block, on SIGINT, and on SIGTERM. A SIGKILL, a power cut, or a hard crash
  cannot be caught by any handler, and leaves the last mutated file mutated
  on disk. Get a tracked file back with \`git checkout -- <path>\`. An
  untracked or ignored path has no committed copy and no way back, which is
  why a --paths target git ignores is refused before anything runs.

Exit codes:
  0  every attempted mutation got a verdict and none survived
  1  at least one mutation survived
  2  could not run as asked: a dirty working tree, an unstaged change under
     --staged, a --paths target git ignores, a baseline run that was already
     failing, no command to run, nothing to mutate, a bad argument, or a
     tree left dirty afterwards
  3  nothing survived, but at least one mutation never got a verdict: it
     timed out or was skipped, so that part of the run is unmeasured
`;

/**
 * The dirty lines that stop this run. Everything git reports, except under
 * --staged, where a staged change is the run's own input and only an
 * unstaged or untracked line blocks. The same filter runs before the
 * mutations and again after them, so the after-check cannot pass on a rule
 * the before-check never applied.
 */
function blockingDirtyLines(dirtyLines: string[], staged: boolean): string[] {
  return staged ? unstagedDirtyLines(dirtyLines) : dirtyLines;
}

/** The stderr message for unstaged work found under --staged. */
function formatUnstagedMessage(lines: string[]): string {
  return [
    "mutate: --staged mutates the staged diff, so a staged change is expected here.",
    "These changes are not staged, and this tool writes to the files it mutates:",
    ...lines.map((line) => `  ${line}`),
    "Stage them, commit them, or put them away first.",
  ].join("\n");
}

function fail(message: string): never {
  process.stderr.write(`mutate: ${message}\n`);
  process.exit(2);
}

interface ParsedArgs {
  rev?: string;
  range?: string;
  staged: boolean;
  paths?: string[];
  command?: string;
  max: number;
  timeoutSeconds?: number;
  format: "text" | "json";
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { staged: false, max: DEFAULT_MAX, format: "text", help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        result.help = true;
        break;
      case "--rev":
        result.rev = argv[++i];
        if (result.rev === undefined) fail("--rev needs a commit argument");
        break;
      case "--range":
        result.range = argv[++i];
        if (result.range === undefined) fail("--range needs an A..B argument");
        break;
      case "--staged":
        result.staged = true;
        break;
      case "--paths":
        {
          const paths: string[] = [];
          let j = i + 1;
          while (j < argv.length && !argv[j].startsWith("-")) {
            paths.push(argv[j]);
            j++;
          }
          if (paths.length === 0) fail("--paths needs at least one path argument");
          result.paths = paths;
          i = j - 1; // the for loop's i++ resumes right after the last path consumed
        }
        break;
      case "--command":
        result.command = argv[++i];
        if (result.command === undefined) fail("--command needs a command argument");
        break;
      case "--max":
        {
          const value = argv[++i];
          const parsed = value === undefined ? Number.NaN : Number(value);
          if (!Number.isInteger(parsed) || parsed < 1) {
            fail(`--max must be a whole number of at least 1, got ${value === undefined ? "nothing" : `'${value}'`}`);
          }
          result.max = parsed;
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
      case "--format":
        {
          const value = argv[++i];
          if (value !== "text" && value !== "json") {
            fail(`--format must be "text" or "json", got ${value === undefined ? "nothing" : `'${value}'`}`);
          }
          result.format = value;
        }
        break;
      default:
        fail(`unknown argument '${arg}'`);
    }
  }

  const selectorCount = [
    result.rev !== undefined,
    result.range !== undefined,
    result.staged,
    result.paths !== undefined,
  ].filter(Boolean).length;
  if (selectorCount > 1) {
    fail("specify only one of --rev, --range, --staged, --paths");
  }

  return result;
}

/**
 * Builds the environment for a git call with every GIT_* override removed,
 * the same way src/clean-tree-gate.ts does: a leftover GIT_DIR or
 * GIT_WORK_TREE would point git at a different tree, and this tool would
 * then write mutations into a repository nobody asked it to touch.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  return env;
}

function runGit(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, env: gitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const detail = typeof e.stderr === "string" && e.stderr.trim() !== "" ? e.stderr.trim() : e.message ?? String(err);
    fail(`git failed (${args.join(" ")}): ${detail}`);
  }
}

/** The repository-relative paths the selector names. */
function resolveCandidatePaths(args: ParsedArgs, repoRoot: string): string[] {
  if (args.paths !== undefined) {
    const relative = args.paths.map((path) => toRepoRelative(path, repoRoot));
    refuseIgnoredPaths(relative, repoRoot);
    return relative;
  }
  if (args.range !== undefined) {
    return splitPaths(runGit(repoRoot, ["diff", "--name-only", "--find-renames", args.range]));
  }
  if (args.staged) {
    return splitPaths(runGit(repoRoot, ["diff", "--name-only", "--find-renames", "--staged"]));
  }
  const rev = args.rev ?? "HEAD";
  return splitPaths(
    runGit(repoRoot, ["diff-tree", "--no-commit-id", "--name-only", "--root", "-r", "--find-renames", rev]),
  );
}

/**
 * Refuses any --paths target git ignores. The whole safety model here is
 * that git holds a copy of every file this tool writes to: a restore that
 * never runs, because the process was killed, is recoverable with
 * `git checkout -- <path>` and nothing else. An ignored path has no
 * committed copy, and `git status --porcelain` does not report it either,
 * so the clean-tree check above never sees it. Mutating one would put a
 * file at risk that nothing could put back.
 */
function refuseIgnoredPaths(paths: string[], repoRoot: string): void {
  const ignored = gitIgnoredPaths(paths, repoRoot);
  if (ignored.length === 0) return;
  fail(
    `git ignores ${ignored.join(", ")}, and an ignored file has no committed copy to restore from. ` +
      "If this run were killed partway, that file would stay mutated with nothing to put back. " +
      "Track the file in git, or point --paths somewhere else",
  );
}

/** The subset of `paths` git ignores. `git check-ignore` exits 0 when it
 * matched something, 1 when it matched nothing, and anything else is a real
 * failure that has to stop the run: a check that could not run must never
 * read as a check that passed. */
function gitIgnoredPaths(paths: string[], repoRoot: string): string[] {
  const result = spawnSync("git", ["check-ignore", "--", ...paths], {
    cwd: repoRoot,
    env: gitEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) fail(`git check-ignore failed: ${result.error.message}`);
  if (result.status === 0) return splitPaths(result.stdout);
  if (result.status === 1) return [];
  const detail = (result.stderr ?? "").trim();
  fail(`git check-ignore failed${detail === "" ? "" : `: ${detail}`}`);
}

function splitPaths(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** Turns a path the caller gave into one relative to the repository root,
 * and refuses anything that resolves outside it: this tool writes to what
 * it is pointed at, so it may only be pointed inside the repository whose
 * cleanliness it just checked. */
function toRepoRelative(path: string, repoRoot: string): string {
  // Both sides are resolved to their real paths before the comparison.
  // resolveRepoRoot reads the root from git, which hands back the real
  // path, so comparing it with a candidate that still carries the symlinks
  // it was reached through refused files that were inside the repository
  // all along.
  const found = resolveWithinRoot(repoRoot, path, realpathSync, process.cwd());
  if (!found.contained) {
    fail(`'${path}' is outside the repository at ${found.realRoot}`);
  }
  return relative(found.realRoot, found.realPath);
}

/** Reads each selected file, dropping any that no longer exists (a commit
 * that deleted a file still names it) or that is not a regular file. */
function readSourceFiles(paths: string[], repoRoot: string): SourceFile[] {
  const files: SourceFile[] = [];
  for (const path of paths) {
    const absolute = join(repoRoot, path);
    if (!existsSync(absolute)) continue;
    let isFile = false;
    try {
      isFile = statSync(absolute).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) continue;
    try {
      files.push({ path, text: readFileSync(absolute, "utf8") });
    } catch (err) {
      fail(`could not read '${path}' (${(err as Error).message})`);
    }
  }
  return files;
}

/** The command to run: the one given, or "npm test" when package.json has a
 * test script. With neither, this exits 2: a mutation run with no command
 * measures nothing, and reporting that as a pass would be the exact failure
 * this project exists to catch. */
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

/** Runs the command through a shell in the repository root, with an
 * optional timeout in milliseconds. A timeout is reported as its own
 * outcome, never folded into a non-zero exit: a mutation that hung was
 * never judged, and calling that a kill would credit the suite with a
 * catch it did not make.
 *
 * The command runs as the leader of its own process group (see
 * src/spawn-command.ts) and, at the timeout, the whole group is killed,
 * not just the shell: a test runner's worker process shares the shell's
 * group, and a signal to the shell alone never reaches it, which is how a
 * timed-out mutation used to leave orphaned processes running. */
async function runCommand(command: string, repoRoot: string, timeoutMs?: number): Promise<CommandRun> {
  const result = await spawnCommand(command, { cwd: repoRoot, timeoutMs, maxBufferBytes: MAX_OUTPUT_BYTES });
  return { status: result.status, timedOut: result.timedOut, durationMs: result.durationMs };
}

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

  // Safety first: no mutation ever runs against work no commit holds. This
  // is the same check hooks/pre-mutation-clean-tree.ts runs, from the same
  // module, because a second copy of it would be a second chance to get it
  // wrong. --staged is the one narrowing: it was asked to mutate the staged
  // diff, so a staged change is the input, not a reason to refuse, while an
  // unstaged edit or an untracked file still stops the run.
  let status;
  try {
    status = getGitStatus(repoRoot);
  } catch (err) {
    fail((err as Error).message);
  }
  const blocking = blockingDirtyLines(status.dirtyLines, args.staged);
  if (blocking.length > 0) {
    if (args.staged) {
      process.stderr.write(`${formatUnstagedMessage(blocking)}\n`);
      fail("refusing to mutate: --staged expects the unstaged tree to be clean");
    }
    process.stderr.write(`${formatDirtyTreeMessage(blocking)}\n`);
    fail("refusing to mutate a dirty working tree; commit or put the changes away first");
  }

  const command = resolveCommand(args, repoRoot);
  const candidates = resolveCandidatePaths(args, repoRoot);
  const mutablePaths = selectMutablePaths(candidates);
  const files = readSourceFiles(mutablePaths, repoRoot);
  const planned = planMutations(files);
  const attempted = planned.slice(0, args.max);

  // Nothing to mutate is not a pass. A run that measured nothing has to
  // read as a run that could not happen, or an empty selector (--staged on
  // a clean tree names no file at all) would report the same exit code as a
  // suite that caught every break.
  if (attempted.length === 0) {
    fail(
      candidates.length === 0
        ? "the selector named no files, so there was nothing to mutate"
        : "none of the selected files held a mutation this tool knows how to make",
    );
  }

  // The baseline. A suite that is already red cannot tell anyone what a
  // mutation did, so this is a hard stop, not a warning. It needs its own
  // timeout: the per-mutation default below is derived from how long the
  // baseline took, so the baseline cannot use that formula, and with no
  // timer at all nothing here would ever call the group kill if this run
  // were killed while the baseline hung. An explicit --timeout bounds the
  // baseline the same as every mutation; with none given,
  // DEFAULT_BASELINE_TIMEOUT_MS stands in.
  const baselineTimeoutMs =
    args.timeoutSeconds !== undefined ? Math.round(args.timeoutSeconds * 1000) : DEFAULT_BASELINE_TIMEOUT_MS;
  const baseline = await runCommand(command, repoRoot, baselineTimeoutMs);
  if (baseline.timedOut) {
    fail(
      `the baseline run of '${command}' did not finish within ${baselineTimeoutMs / 1000}s, before anything was ` +
        "mutated; a suite this tool cannot even measure once cannot judge a mutation. Pass --timeout to allow more " +
        "time if the suite is legitimately this slow",
    );
  }
  if (baseline.status !== 0) {
    fail(
      `the baseline run of '${command}' failed (exit ${baseline.status ?? "killed"}) before anything was mutated; ` +
        "a suite that is already failing cannot judge a mutation",
    );
  }
  const timeoutMs =
    args.timeoutSeconds !== undefined ? Math.round(args.timeoutSeconds * 1000) : baseline.durationMs * 3 + 10_000;

  const originals = new Map<string, string>();
  for (const file of files) originals.set(file.path, file.text);

  let restored = false;
  const restoreAll = (): void => {
    if (restored) return;
    restored = true;
    for (const [path, text] of originals) {
      try {
        writeFileSync(join(repoRoot, path), text);
      } catch (err) {
        process.stderr.write(`mutate: could not restore '${path}' (${(err as Error).message})\n`);
      }
    }
  };

  // An interrupted run still has to put every file back. The handlers stay
  // registered for the whole mutation loop; a signal that arrives while the
  // command is running is delivered once that call returns.
  const onSignal = (signal: string): void => {
    restoreAll();
    process.stderr.write(`\nmutate: interrupted by ${signal}; every mutated file was restored\n`);
    process.exit(2);
  };
  const onInt = (): void => onSignal("SIGINT");
  const onTerm = (): void => onSignal("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);

  const results: MutationResult[] = [];
  try {
    for (const mutation of attempted) {
      // Yield to the event loop before writing the next file. Node delivers
      // a signal through the event loop, and everything else in this run is
      // synchronous, so without this pause a SIGINT that arrived while the
      // command was running would sit unhandled until the whole run had
      // finished, and the handler above would never restore anything.
      await new Promise((resolveTick) => setImmediate(resolveTick));
      const original = originals.get(mutation.file);
      if (original === undefined) fail(`internal: no original held for '${mutation.file}'`);
      results.push(
        await runOneMutation(mutation, original, join(repoRoot, mutation.file), {
          writeFile: (path, text) => writeFileSync(path, text),
          runCommand: () => runCommand(command, repoRoot, timeoutMs),
        }),
      );
    }
    // One more pause, so a signal that arrived during the last command is
    // handled while the files are still this run's responsibility.
    await new Promise((resolveTick) => setImmediate(resolveTick));
  } finally {
    restoreAll();
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  }

  const report = {
    command,
    baselineMs: baseline.durationMs,
    timeoutMs,
    filesConsidered: files.map((file) => file.path),
    planned: planned.length,
    attempted: attempted.length,
    results,
  };
  process.stdout.write(args.format === "json" ? formatReportJson(report) : `${formatReportText(report)}\n`);

  // Last safety check: the tree has to be exactly as it was found. A tool
  // that leaves a mutation behind in someone's source is worse than no tool
  // at all, so this is exit 2 whatever the mutations did.
  let after;
  try {
    after = getGitStatus(repoRoot);
  } catch (err) {
    fail(`could not confirm the tree is clean after the run (${(err as Error).message})`);
  }
  const leftBehind = blockingDirtyLines(after.dirtyLines, args.staged);
  if (leftBehind.length > 0) {
    process.stderr.write(`${formatDirtyTreeMessage(leftBehind)}\n`);
    fail("the working tree is dirty after the run; check these paths before trusting anything above");
  }

  process.exit(exitCodeFor(results));
}

main().catch((err: unknown) => {
  process.stderr.write(`mutate: ${(err as Error).message}\n`);
  process.exit(2);
});
