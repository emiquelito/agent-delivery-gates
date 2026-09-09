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
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  exitCodeFor,
  formatReportJson,
  formatReportText,
  outcomeFor,
  parseSpec,
  runFromSteps,
  unreadableSpecRun,
  type InduceSpec,
  type SpecRun,
  type StepName,
  type StepResult,
} from "../src/induce.ts";

const DEFAULT_DIR = ".adg/induced";
const DEFAULT_TIMEOUT_SECONDS = 120;

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
                  a fail
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

Verdicts:
  proven                  inject passed, neutralize failed
  handler-did-not-fire    inject did not pass
  check-does-not-measure  inject passed and neutralize passed too
  could-not-run           a command could not be executed, a command timed
                          out, the baseline was already failing, or the
                          spec was malformed

What this does NOT do:
  It does not read a delivery report, and validate-report does not run a
  spec; the two are separate checks on purpose. It does not know whether
  the spec describes the failure a report means. It cannot tell whether a
  spec is honest: a spec whose neutralize step breaks something unrelated
  will still report "proven". What it proves is narrow and real: the check
  named here fails when the handling named here is taken away.

  A command that exits 126 or 127 is read as never having run, because a
  neutralize step that was never runnable would otherwise look exactly
  like a control that worked. A command that chooses to exit 127 on its
  own is misread by that rule.

Exit codes:
  0  every spec proven
  1  at least one spec not proven
  2  could not run as asked: no specs, a malformed spec, a spec with no
     neutralize, a command that could not be executed, a failing baseline,
     or a bad argument
  3  nothing failed, but at least one spec timed out and was never measured
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

/** The spec files to run, in a fixed order. A missing directory is exit 2,
 * and so is a directory holding no spec: a run that measured nothing must
 * never report the same as a run that measured everything and found
 * nothing wrong. */
function resolveSpecPaths(args: ParsedArgs): { paths: string[]; source: string } {
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
    return { paths: args.specs.map((path) => resolve(process.cwd(), path)), source: args.specs.join(", ") };
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
  const paths = entries
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => join(dir, name));
  if (paths.length === 0) fail(`no *.json spec files in '${dir}', so there was nothing to run`);
  return { paths, source: dir };
}

/** Runs one command through a shell, with a timeout. A timeout is its own
 * outcome and is never folded into a non-zero exit: a command that was
 * killed partway was never judged, and calling that a fail would credit a
 * control nothing watched. */
function runCommand(command: string, cwd: string, timeoutMs: number): {
  status: number | null;
  timedOut: boolean;
  durationMs: number;
} {
  const started = Date.now();
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  const durationMs = Date.now() - started;
  const timedOut =
    (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" ||
    (result.status === null && result.signal !== null);
  return { status: result.status, timedOut, durationMs };
}

/** Runs the steps of one spec: baseline first when it is there, then
 * inject, then neutralize. A failing baseline stops the rest: a suite that
 * is already red cannot say what an injection did, so the later steps are
 * recorded as never run instead of being scored. */
function runSpec(file: string, spec: InduceSpec, defaultTimeoutSeconds: number): SpecRun {
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
      steps.push({ step, command, outcome: "not-run", exitCode: null, durationMs: 0 });
      continue;
    }
    const run = runCommand(command, cwd, timeoutMs);
    const outcome = outcomeFor(run);
    steps.push({
      step,
      command,
      outcome,
      exitCode: run.timedOut ? null : run.status,
      durationMs: run.durationMs,
    });
    if (step === "baseline" && outcome !== "passed") stopped = true;
  }
  return runFromSteps(file, spec.claim, steps);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const { paths, source } = resolveSpecPaths(args);
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
    runs.push(runSpec(path, parsed.spec, args.timeoutSeconds));
  }

  const report = { source, timeoutMs: Math.round(args.timeoutSeconds * 1000), runs };
  process.stdout.write(args.format === "json" ? formatReportJson(report) : `${formatReportText(report)}\n`);
  process.exit(exitCodeFor(runs));
}

main();
