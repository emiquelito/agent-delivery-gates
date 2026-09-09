#!/usr/bin/env node
// CLI entry point for `adg induce`. Runs a declared failure injection twice:
// once with the handling in place, where the check is expected to pass, and
// once with the handling taken away, where the same check is expected to
// fail. A check that passes both ways never measured the handling, so the
// claim it backs is unproven however green the first run looked.
//
// Contract:
//   induce [--dir PATH] [--spec PATH]... [--timeout SECONDS]
//          [--format text|json]
// Exit 0: every spec proven. Exit 1: at least one spec not proven. Exit 2:
// could not run as asked, which includes no specs at all, a malformed spec,
// a spec with no neutralize step, a command that could not be executed, and
// a failing baseline. Exit 3: nothing failed, but at least one spec timed
// out and so was never measured.
//
// This command runs commands the caller wrote. It does not write to any
// source file, so it needs no clean-tree gate and has none; `git checkout`,
// `git stash`, and `git restore` are never run from here.
//
// What it does not do, said plainly here and in --help: it does not read a
// delivery report, it does not know whether a spec describes the failure a
// report means, and it cannot tell whether a spec is honest. It proves that
// one declared check measures one declared handling, and nothing more.

import process from "node:process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnCommand } from "../src/spawn-command.ts";
import {
  exitCodeFor,
  formatReportJson,
  formatReportText,
  keepTail,
  outcomeFor,
  parseSpec,
  runFromSteps,
  unreadableSpecRun,
  type CommandRun,
  type InduceSpec,
  type SpecRun,
  type StepName,
  type StepResult,
} from "../src/induce.ts";

const DEFAULT_DIR = ".adg/induced";
const DEFAULT_TIMEOUT_SECONDS = 120;

/** How much output one command may print before Node kills it. Node's own
 * default is 1 MB, which a verbose suite passes routinely, and the kill
 * that follows looks exactly like a timeout kill. This is the size census
 * uses, so the two commands agree on what counts as too much. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

const USAGE = `Usage: induce [--dir PATH] [--spec PATH]... [--timeout SECONDS]
              [--format text|json]

Runs a declared failure injection twice: once with the handling in place,
where the check must pass, and once with the handling taken away, where the
same check must fail. A check that passes both ways is not measuring the
handling at all: it would pass if the feature produced nothing.

  --dir PATH      read every *.json spec in this directory
                  (default: ${DEFAULT_DIR})
  --spec PATH     run this one spec file; may be repeated. Not combinable
                  with --dir
  --timeout SECONDS  per-command timeout (default: ${DEFAULT_TIMEOUT_SECONDS}). A spec's own
                  "timeout" field overrides it. A command that hits the
                  timeout is reported as timed out and is never counted as
                  a fail. At the timeout, the command's whole process tree
                  is killed, not just the command itself, so a worker
                  process it started cannot outlive it. On Windows that
                  kill is taskkill /t, which walks the same tree by a
                  different name
  --format FORMAT "text" (default) or "json"
  --help          print this message and exit 0

Spec format, one JSON object per file:
  claim        the sentence a delivery report would make (required)
  inject       induces the failure with the handling in place; expected to
               pass (required)
  neutralize   induces the same failure with the handling taken away;
               expected to fail (required)
  baseline     the happy path, run first; expected to pass (optional)
  timeout      per-command timeout for this spec, in seconds (optional)
  cwd          working directory for this spec's commands, resolved from
               the current directory (optional)
Any other field is refused. A spec with no "neutralize" is refused: the
control is not optional, and a run without it proves nothing.

Running a spec runs shell commands:
  Every command in a spec is handed to a shell and runs with the
  privileges of whoever ran this command, on this machine, against these
  files. A spec is a script, not data. Read a spec that came from a
  repository you did not write before you run it, the same way you would
  read a script before running it. Note that "cwd" is not contained to
  the current directory or to the repository, and containing it would buy
  nothing, because a command that can run at all can "cd" wherever it
  likes.

  Specs share one working directory, run in filename order, and are not
  isolated from each other. A spec that leaves a file behind can change
  the verdict of a spec that runs after it, so a spec must clean up after
  itself.

  The environment is inherited from the caller, not cleaned. If a
  variable a spec's neutralize step sets to take the handling away is
  already set in your environment, the inject run is neutralized too, and
  the spec then reports check-does-not-measure against a handling that
  works. The shipped example spec uses ADG_RETRY_DISABLED=1 that way.

A directory entry that is not a *.json file is not read as a spec, so
"retry.JSON", "retry.json.bak" and "retry.jsonc" are not run. Every entry
that was not run is named and counted in the report header, so a
directory where only some specs ran can never read like a clean run.

Verdicts:
  proven                  inject passed, neutralize failed
  handler-did-not-fire    inject did not pass
  check-does-not-measure  inject passed and neutralize passed too
  could-not-run           a command could not be executed, a command was
                          cut off before it could be judged, the baseline
                          was already failing, or the spec was malformed

What this does NOT do:
  It does not read a delivery report, and validate-report does not run a
  spec; the two are separate checks on purpose. It does not know whether
  the spec describes the failure a report means. It cannot tell whether a
  spec is honest: a spec whose neutralize step breaks something unrelated
  will still report "proven". What it observes is narrow: the command
  named as inject exited 0, and the command named as neutralize did not.

  Any neutralize failure counts, whatever caused it. A syntax error, a
  missing file, a runner that collected no tests and a script that exited
  before it reached the check all read as a control that worked. That is
  why a proven spec prints the tail of what its neutralize command said:
  read it, and check that the command failed for the reason the spec
  meant.

  A command that exits 126 or 127 is read as never having run, because a
  neutralize step that was never runnable would otherwise look exactly
  like a control that worked. A command that chooses to exit 127 on its
  own is misread by that rule.

  A command killed by a signal, and a command that printed more than this
  tool will hold, are each reported as themselves, never as a timeout.
  Both leave the step with no verdict.

Exit codes:
  0  every spec proven
  1  at least one spec not proven
  2  could not run as asked: no specs, a malformed spec, a spec with no
     neutralize, a command that could not be executed, a failing baseline,
     or a bad argument
  3  nothing failed, but at least one spec was cut off and never measured:
     a command timed out, was killed by a signal, or printed too much
`;

function fail(message: string): never {
  process.stderr.write(`induce: ${message}\n`);
  process.exit(2);
}

interface ParsedArgs {
  dir?: string;
  specs: string[];
  timeoutSeconds: number;
  format: "text" | "json";
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { specs: [], timeoutSeconds: DEFAULT_TIMEOUT_SECONDS, format: "text", help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        result.help = true;
        break;
      case "--dir":
        result.dir = argv[++i];
        if (result.dir === undefined) fail("--dir needs a path argument");
        break;
      case "--spec":
        {
          const value = argv[++i];
          if (value === undefined) fail("--spec needs a path argument");
          result.specs.push(value);
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
  if (result.dir !== undefined && result.specs.length > 0) {
    fail("specify --dir or --spec, not both");
  }
  return result;
}

/** The spec files to run, in a fixed order, and the names of everything
 * beside them that was not run. A missing directory is exit 2, and so is a
 * directory holding no spec: a run that measured nothing must never report
 * the same as a run that measured everything and found nothing wrong.
 *
 * A near miss such as `retry.JSON`, `retry.json.bak` or `retry.jsonc` is
 * not read as a spec, and used to be dropped without a word, so a
 * directory of four specs could run one and report a clean run. Every
 * entry that was not run is now named and counted in the report header.
 * The exit code is left alone on purpose: a spec directory may hold a
 * README or an editor's leftovers, and refusing to run over one would
 * make the command unusable in an ordinary directory. Naming them is what
 * the principle needs, since it makes silence impossible; refusing is
 * more than it needs. */
function resolveSpecPaths(args: ParsedArgs): { paths: string[]; source: string; skipped: string[] } {
  if (args.specs.length > 0) {
    for (const path of args.specs) {
      let isFile = false;
      try {
        isFile = statSync(resolve(process.cwd(), path)).isFile();
      } catch {
        fail(`could not read the spec at '${path}'`);
      }
      if (!isFile) fail(`'${path}' is not a file`);
    }
    return {
      paths: args.specs.map((path) => resolve(process.cwd(), path)),
      source: args.specs.join(", "),
      skipped: [],
    };
  }

  const dir = resolve(process.cwd(), args.dir ?? DEFAULT_DIR);
  let entries: string[];
  try {
    if (!statSync(dir).isDirectory()) fail(`'${dir}' is not a directory`);
    entries = readdirSync(dir);
  } catch (err) {
    fail(
      `could not read the spec directory '${dir}' (${(err as Error).message}). ` +
        "Write a spec there, or point --dir somewhere else",
    );
  }
  const isSpecFile = (name: string): boolean => {
    if (!name.endsWith(".json")) return false;
    try {
      return statSync(join(dir, name)).isFile();
    } catch {
      return false;
    }
  };
  const specNames = entries.filter(isSpecFile).sort();
  const skipped = entries.filter((name) => !isSpecFile(name)).sort();
  const paths = specNames.map((name) => join(dir, name));
  if (paths.length === 0) {
    const alsoSkipped =
      skipped.length === 0 ? "" : `; entries there that are not *.json spec files: ${skipped.join(", ")}`;
    fail(`no *.json spec files in '${dir}', so there was nothing to run${alsoSkipped}`);
  }
  return { paths, source: dir, skipped };
}

/** Runs one command through a shell, with a timeout, keeping what it
 * printed. A timeout is its own outcome and is never folded into a
 * non-zero exit: a command that was killed partway was never judged, and
 * calling that a fail would credit a control nothing watched.
 *
 * The command runs as the leader of its own process group (see
 * src/spawn-command.ts) and, at the timeout, the whole group is killed,
 * not just the direct child: a command that starts a worker process of
 * its own used to leave that worker running past the timeout, orphaned
 * once the direct child was killed alone.
 *
 * The three ways of being killed are told apart, because each needs a
 * different sentence. Node's read buffer is capped at 64 MB, the same
 * size census uses, so that a verbose suite is not killed for printing;
 * past that the whole tree is killed and the output kept up to that
 * point is reported, not the rest that was never printed. A signal that
 * is not the timeout kill or the output cap, a segfault or an
 * out-of-memory kill, arrives as a null status with a signal set. All
 * three used to be told apart from a single spawnSync call; they still
 * are, just from spawnCommand's own accounting instead of spawnSync's
 * error codes. */
async function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<CommandRun & { stdout: string; stderr: string; failure?: string }> {
  const result = await spawnCommand(command, { cwd, timeoutMs, maxBufferBytes: MAX_OUTPUT_BYTES });
  let failure: string | undefined;
  if (result.outputOverflowed) {
    failure = `printed more than ${Math.round(MAX_OUTPUT_BYTES / (1024 * 1024))} MB and was killed for it`;
  } else if (result.killedBySignal !== null) {
    failure = `killed by ${result.killedBySignal} before it finished`;
  } else if (result.spawnError !== undefined) {
    failure = `could not be run (${result.spawnError})`;
  }
  const run: CommandRun & { stdout: string; stderr: string; failure?: string } = {
    status: result.status,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    outputOverflowed: result.outputOverflowed,
    killedBySignal: result.killedBySignal,
    stdout: keepTail(result.stdout),
    stderr: keepTail(result.stderr),
  };
  if (failure !== undefined) run.failure = failure;
  return run;
}

/** Runs the steps of one spec: baseline first when it is there, then
 * inject, then neutralize. A failing baseline stops the rest: a suite that
 * is already red cannot say what an injection did, so the later steps are
 * recorded as never run instead of being scored. */
async function runSpec(file: string, spec: InduceSpec, defaultTimeoutSeconds: number): Promise<SpecRun> {
  const cwd = resolve(process.cwd(), spec.cwd ?? ".");
  let cwdOk = false;
  try {
    cwdOk = statSync(cwd).isDirectory();
  } catch {
    cwdOk = false;
  }
  if (!cwdOk) return unreadableSpecRun(file, [`cwd '${spec.cwd ?? "."}' is not a directory`]);

  const timeoutMs = Math.round((spec.timeout ?? defaultTimeoutSeconds) * 1000);
  const planned: { step: StepName; command: string }[] = [];
  if (spec.baseline !== undefined) planned.push({ step: "baseline", command: spec.baseline });
  planned.push({ step: "inject", command: spec.inject });
  planned.push({ step: "neutralize", command: spec.neutralize });

  const steps: StepResult[] = [];
  let stopped = false;
  for (const { step, command } of planned) {
    if (stopped) {
      steps.push({ step, command, outcome: "not-run", exitCode: null, durationMs: 0, stdout: "", stderr: "" });
      continue;
    }
    const run = await runCommand(command, cwd, timeoutMs);
    const outcome = outcomeFor(run);
    const result: StepResult = {
      step,
      command,
      outcome,
      exitCode: outcome === "passed" || outcome === "failed" ? run.status : null,
      durationMs: run.durationMs,
      stdout: run.stdout,
      stderr: run.stderr,
    };
    if (run.failure !== undefined) result.failure = run.failure;
    steps.push(result);
    if (step === "baseline" && outcome !== "passed") stopped = true;
  }
  return runFromSteps(file, spec.claim, steps);
}

/** Reported on SIGINT/SIGTERM. induce writes to no file and owns no
 * worktree, so unlike mutate and census it has nothing of its own to put
 * back; it only needs to stop instead of quietly running the rest of the
 * specs against a command spawnCommand already killed. spawnCommand's own
 * listener (see src/spawn-command.ts) kills the command's whole process
 * group before this one runs, because it is registered with
 * prependListener; this one is what actually ends the run. */
function onSignal(signal: string): never {
  process.stderr.write(`\ninduce: interrupted by ${signal}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  const { paths, source, skipped } = resolveSpecPaths(args);
  const runs: SpecRun[] = [];
  for (const path of paths) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      runs.push(unreadableSpecRun(path, [`could not be read (${(err as Error).message})`]));
      continue;
    }
    const parsed = parseSpec(text);
    if (parsed.spec === undefined) {
      runs.push(unreadableSpecRun(path, parsed.problems));
      continue;
    }
    runs.push(await runSpec(path, parsed.spec, args.timeoutSeconds));
  }

  const report = { source, timeoutMs: Math.round(args.timeoutSeconds * 1000), runs, skipped };
  process.stdout.write(args.format === "json" ? formatReportJson(report) : `${formatReportText(report)}\n`);
  process.exit(exitCodeFor(runs));
}

main().catch((err: unknown) => {
  process.stderr.write(`induce: ${(err as Error).message}\n`);
  process.exit(2);
});
