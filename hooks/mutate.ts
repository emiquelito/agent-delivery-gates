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
// Exit 0: nothing survived. Exit 1: at least one mutation survived. Exit 2:
// could not run as asked, which includes a dirty working tree, a baseline
// run that was already failing, no command to run, and a tree left dirty
// afterwards. A run that could not happen must never read the same as a run
// that happened and found nothing.
//
// This tool writes to the caller's own source files, so the safety rules
// come first and are not optional:
//   - it refuses to start on a dirty working tree, using the same check
//     hooks/pre-mutation-clean-tree.ts uses, so there is always a committed
//     copy to compare against;
//   - it holds every original in memory and restores it in a finally block,
//     on SIGINT, and on SIGTERM;
//   - it checks the tree is clean again at the end and fails loudly if not.

import process from "node:process";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  applyMutation,
  exitCodeFor,
  formatReportJson,
  formatReportText,
  planMutations,
  selectMutablePaths,
  type Mutation,
  type MutationResult,
  type SourceFile,
  type Verdict,
} from "../src/mutate.ts";
import { formatDirtyTreeMessage, getGitStatus, resolveRepoRoot } from "../src/clean-tree-gate.ts";

const DEFAULT_MAX = 25;

const USAGE = `Usage: mutate [--rev REV] [--range A..B] [--staged] [--paths PATH...]
              [--command CMD] [--max N] [--timeout SECONDS] [--format text|json]

Breaks source code in known ways, one break per run of the command, and
reports which breaks the command did not notice. A surviving break means no
test read that line closely enough to fail.

  --rev REV       mutate the source files changed by that commit (default: HEAD)
  --range A..B    mutate the source files changed across that range
  --staged        mutate the source files in the staged diff
  --paths PATH... mutate exactly these files
  --command CMD   the command to run after each break (default: "npm test",
                  used only when package.json has a test script)
  --max N         attempt at most N mutations (default: ${DEFAULT_MAX}); each one
                  runs the whole command
  --timeout SECONDS  per-mutation timeout (default: three times the baseline
                  run plus ten seconds). The command is killed at the
                  timeout, but a process the command itself started can
                  outlive it, so a timed-out mutation is worth a look.
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

Exit codes:
  0  no mutation survived
  1  at least one mutation survived
  2  could not run as asked: a dirty working tree, a baseline run that was
     already failing, no command to run, nothing to mutate, a bad argument,
     or a tree left dirty afterwards
`;

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
    return args.paths.map((path) => toRepoRelative(path, repoRoot));
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
  const absolute = resolve(process.cwd(), path);
  const rootWithSep = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`;
  if (absolute !== repoRoot && !absolute.startsWith(rootWithSep)) {
    fail(`'${path}' is outside the repository at ${repoRoot}`);
  }
  return absolute.slice(rootWithSep.length);
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

interface CommandRun {
  status: number | null;
  timedOut: boolean;
  durationMs: number;
}

/** Runs the command through a shell in the repository root, with an
 * optional timeout in milliseconds. A timeout is reported as its own
 * outcome, never folded into a non-zero exit: a mutation that hung was
 * never judged, and calling that a kill would credit the suite with a
 * catch it did not make. */
function runCommand(command: string, repoRoot: string, timeoutMs?: number): CommandRun {
  const started = Date.now();
  const result = spawnSync(command, {
    cwd: repoRoot,
    shell: true,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  const durationMs = Date.now() - started;
  const timedOut =
    timeoutMs !== undefined &&
    ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" ||
      (result.status === null && result.signal !== null));
  return { status: result.status, timedOut, durationMs };
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

  // Safety first: no mutation ever runs against work that is not committed.
  // This is the same check hooks/pre-mutation-clean-tree.ts runs, from the
  // same module, because a second copy of it would be a second chance to
  // get it wrong.
  let status;
  try {
    status = getGitStatus(repoRoot);
  } catch (err) {
    fail((err as Error).message);
  }
  if (!status.clean) {
    process.stderr.write(`${formatDirtyTreeMessage(status.dirtyLines)}\n`);
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
  // mutation did, so this is a hard stop, not a warning.
  const baseline = runCommand(command, repoRoot);
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
      results.push(runOneMutation(mutation, originals, repoRoot, command, timeoutMs));
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
  if (!after.clean) {
    process.stderr.write(`${formatDirtyTreeMessage(after.dirtyLines)}\n`);
    fail("the working tree is dirty after the run; check these paths before trusting anything above");
  }

  process.exit(exitCodeFor(results));
}

/** Applies one mutation, runs the command, and always puts the file back,
 * whatever the command did and whatever threw. */
function runOneMutation(
  mutation: Mutation,
  originals: Map<string, string>,
  repoRoot: string,
  command: string,
  timeoutMs: number,
): MutationResult {
  const original = originals.get(mutation.file);
  if (original === undefined) fail(`internal: no original held for '${mutation.file}'`);
  const absolute = join(repoRoot, mutation.file);
  const mutated = applyMutation(original, mutation);
  if (mutated === original) {
    return { mutation, verdict: "skipped", durationMs: 0, exitCode: null };
  }
  try {
    writeFileSync(absolute, mutated);
    const run = runCommand(command, repoRoot, timeoutMs);
    const verdict: Verdict = run.timedOut ? "timeout" : run.status === 0 ? "survived" : "killed";
    return { mutation, verdict, durationMs: run.durationMs, exitCode: run.timedOut ? null : run.status };
  } finally {
    writeFileSync(absolute, original);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`mutate: ${(err as Error).message}\n`);
  process.exit(2);
});
