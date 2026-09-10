// Pure core for `adg induce`. Reads a spec that a person or an agent
// wrote, decides whether that spec is well formed, turns the outcomes of
// the commands it declares into a verdict, and formats the report. No I/O,
// no subprocess, no process exit: the CLI in hooks/induce.ts does all of
// that, so the rule that decides what counts as proof lives in one place
// and can be tested without running anything. The one exception is
// `isNotRunnable`'s `platform` default, which reads `process.platform` --
// not I/O, just which command-not-found convention applies -- and every
// caller can override it, so a test exercises the Windows branch without
// needing a Windows host. `isNotRunnable` also takes an optional
// `notFoundTemplate`, the shell's own not-found text as captured on the
// machine actually running; capturing it is I/O and lives in
// hooks/induce.ts's calibrateNotFoundTemplate, not here.
//
// The check this carries, from rules/induced-failure-required.json: a
// robustness claim needs evidence that the specific failure was made to
// happen AND that the handling fired in response. That record ends with a
// negative control, written as a question: "Ask whether the check would
// still pass if the feature produced nothing; if so, it is checking the
// wrong thing." This module makes that question mechanical. A spec says
// how to induce the failure and how to take the handling away. Running the
// check with the handling present should pass. Running the same check with
// the handling gone should fail. When it passes both ways, the check never
// measured the handling at all, and the claim is unproven however green
// the first run looked.
//
// A spec with no neutralize step is refused. The control is not optional:
// without it a run proves nothing, and a tool that reported "proven" from
// the inject step alone would be the exact failure this project exists to
// catch.

import process from "node:process";

/** The steps a spec can declare, in the order they are run. */
export type StepName = "baseline" | "inject" | "neutralize";

export const STEP_ORDER: readonly StepName[] = ["baseline", "inject", "neutralize"];

/** Every field a spec file may carry. Anything else is refused: a
 * misspelled field that was quietly ignored would leave the author
 * believing a step ran that never did. */
export const KNOWN_SPEC_FIELDS: readonly string[] = [
  "claim",
  "inject",
  "neutralize",
  "baseline",
  "timeout",
  "cwd",
];

export interface InduceSpec {
  /** The sentence a delivery report would make about this handling. */
  claim: string;
  /** Induces the failure with the handling in place. Expected to pass. */
  inject: string;
  /** Induces the same failure with the handling taken away. Expected to
   * fail. A pass here is the finding worth having. */
  neutralize: string;
  /** Optional: the happy path, run first. */
  baseline?: string;
  /** Optional per-command timeout for this spec, in seconds. */
  timeout?: number;
  /** Optional working directory for every command in this spec. */
  cwd?: string;
}

/** What one command did.
 *
 * "timed-out", "killed" and "output-overflow" are three different ways for
 * a command to end without a verdict, and they are kept apart because the
 * sentence printed under each one is different. Reporting a segfault or a
 * command that printed too much as a timeout tells the reader to raise the
 * timeout, which fixes neither. */
export type StepOutcome = "passed" | "failed" | "timed-out" | "killed" | "output-overflow" | "not-run";

export interface StepResult {
  step: StepName;
  command: string;
  outcome: StepOutcome;
  /** The exit code, or null when the command was killed or never ran. */
  exitCode: number | null;
  durationMs: number;
  /** What the command printed, kept so the report can show why a control
   * failed. Trimmed to the last KEPT_OUTPUT_CHARS of each stream: any
   * failure worth reading names itself at the end. */
  stdout: string;
  stderr: string;
  /** How the command ended, when it ended without a verdict: the signal
   * that killed it, or why it could not be finished. Absent otherwise. */
  failure?: string;
}

/** How much of each stream is kept per step. Node is given a 64 MB read
 * buffer so that a verbose suite is not killed part way; what is kept for
 * the report is much smaller, because a report nobody can read is not
 * evidence. */
export const KEPT_OUTPUT_CHARS = 64 * 1024;

/** How much of the kept output the text report prints under a verdict:
 * the last TAIL_MAX_LINES lines, cut to TAIL_MAX_CHARS if those lines are
 * long. Whichever is smaller wins. */
export const TAIL_MAX_LINES = 20;
export const TAIL_MAX_CHARS = 2048;

/** The last `maxChars` characters of `text`. */
export function keepTail(text: string, maxChars: number = KEPT_OUTPUT_CHARS): string {
  return text.length <= maxChars ? text : text.slice(text.length - maxChars);
}

/** The tail a report prints: the last TAIL_MAX_LINES lines, then cut to
 * TAIL_MAX_CHARS. Never the whole output, and always labelled as a tail
 * where it is printed, so nobody reads it as the complete run. */
export function outputTail(text: string): string {
  const trimmed = text.replace(/\s+$/, "");
  if (trimmed === "") return "";
  const lines = trimmed.split("\n");
  const kept = lines.length <= TAIL_MAX_LINES ? lines : lines.slice(lines.length - TAIL_MAX_LINES);
  return keepTail(kept.join("\n"), TAIL_MAX_CHARS);
}

export type Verdict = "proven" | "handler-did-not-fire" | "check-does-not-measure" | "could-not-run";

/** Why a run could not be judged. Kept apart from the verdict because the
 * exit code differs: a timeout leaves the spec unmeasured (exit 3), while
 * a malformed spec or a command that never started means the run could not
 * happen as asked (exit 2). */
export type UnrunReason =
  | "spec-invalid"
  | "baseline-failed"
  | "command-not-runnable"
  | "timeout"
  | "killed-by-signal"
  | "output-overflow";

/** The outcomes that leave a step with no verdict, and the reason each one
 * gets. A step in this table was neither a pass nor a fail: the command
 * ran and was cut off, so scoring it either way would credit or blame a
 * control that nothing watched. */
const UNJUDGED_REASONS: Partial<Record<StepOutcome, UnrunReason>> = {
  "timed-out": "timeout",
  killed: "killed-by-signal",
  "output-overflow": "output-overflow",
};

export function unjudgedReason(outcome: StepOutcome): UnrunReason | undefined {
  return UNJUDGED_REASONS[outcome];
}

export interface SpecRun {
  /** Path of the spec file, as the caller named it. */
  file: string;
  /** The claim from the spec, or an empty string when the spec was
   * unreadable. */
  claim: string;
  steps: StepResult[];
  verdict: Verdict;
  reason?: UnrunReason;
  /** Everything wrong with the spec file, when it could not be read. */
  problems?: string[];
}

// --- reading a spec -----------------------------------------------------------

export interface ParsedSpec {
  spec?: InduceSpec;
  problems: string[];
}

/**
 * Checks one already-parsed JSON value against the spec format and returns
 * the spec, or every problem with it. Every problem is collected, not just
 * the first: an author fixing one field at a time, one run at a time, is
 * how a spec ends up half written.
 */
export function validateSpec(value: unknown): ParsedSpec {
  const problems: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { problems: ["the spec must be a JSON object"] };
  }
  const raw = value as Record<string, unknown>;

  for (const key of Object.keys(raw)) {
    if (!KNOWN_SPEC_FIELDS.includes(key)) {
      problems.push(`unknown field '${key}'; known fields are ${KNOWN_SPEC_FIELDS.join(", ")}`);
    }
  }

  for (const key of ["claim", "inject", "neutralize"] as const) {
    const field = raw[key];
    if (field === undefined) {
      problems.push(
        key === "neutralize"
          ? "missing 'neutralize': the control is not optional, and a run without it proves nothing"
          : `missing '${key}'`,
      );
      continue;
    }
    if (typeof field !== "string" || field.trim() === "") {
      problems.push(`'${key}' must be a non-empty string`);
    }
  }

  if (raw.baseline !== undefined && (typeof raw.baseline !== "string" || raw.baseline.trim() === "")) {
    problems.push("'baseline' must be a non-empty string when it is given");
  }
  if (raw.cwd !== undefined && (typeof raw.cwd !== "string" || raw.cwd.trim() === "")) {
    problems.push("'cwd' must be a non-empty string when it is given");
  }
  if (raw.timeout !== undefined) {
    if (typeof raw.timeout !== "number" || !Number.isFinite(raw.timeout) || raw.timeout <= 0) {
      problems.push("'timeout' must be a positive number of seconds when it is given");
    }
  }

  if (problems.length > 0) return { problems };

  const spec: InduceSpec = {
    claim: (raw.claim as string).trim(),
    inject: raw.inject as string,
    neutralize: raw.neutralize as string,
  };
  if (raw.baseline !== undefined) spec.baseline = raw.baseline as string;
  if (raw.timeout !== undefined) spec.timeout = raw.timeout as number;
  if (raw.cwd !== undefined) spec.cwd = raw.cwd as string;
  return { spec, problems: [] };
}

/** Parses spec text and checks it. Bad JSON is a problem like any other:
 * a spec that cannot be read must never look like a spec that passed. */
export function parseSpec(text: string): ParsedSpec {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { problems: [`not valid JSON (${(err as Error).message})`] };
  }
  return validateSpec(value);
}

// --- turning outcomes into a verdict ------------------------------------------

/** A shell exit code that means the command itself never ran: 127 is
 * "command not found", 126 is "found but not executable". Reading either
 * as a plain failure is what would let a neutralize step that was never
 * runnable report as the control working. The one thing this cannot tell
 * apart is a command that chooses to exit 127 on its own. */
export const NOT_RUNNABLE_EXIT_CODES: readonly number[] = [126, 127];

/** What cmd.exe prints, in English, when the command named does not exist
 * as a builtin, an alias, or an executable on PATH: "'x' is not recognized
 * as an internal or external command, operable program or batch file."
 * Windows CI confirmed this directly: a neutralize step naming a command
 * that does not exist came back exit 1 with exactly this text on stderr,
 * where the same spec on POSIX comes back 127 (see NOT_RUNNABLE_EXIT_CODES
 * above). cmd.exe is what Node's shell:true spawns on Windows (see
 * src/spawn-command.ts), and it reports "not found" with plain exit code
 * 1, the same code an ordinary failing command uses, so exit code alone
 * cannot tell the two apart there the way 126/127 does on POSIX.
 *
 * This text is locale-dependent -- a non-English Windows prints the same
 * message in its own language, and this pattern will not match it -- so it
 * is used only as a fallback. The primary check is `isNotRunnable`'s
 * `notFoundTemplate` parameter: the message this machine's own shell
 * actually printed, captured once by spawning a command guaranteed not to
 * exist through the same shell mechanism (see hooks/induce.ts's
 * calibrateNotFoundTemplate) and reused for the rest of the run. This
 * constant is what is matched against instead when there is no calibrated
 * text to use, because the calibration was never needed yet or because the
 * calibration spawn itself failed. */
export const WINDOWS_COMMAND_NOT_FOUND_MESSAGE = /is not recognized as an internal or external command/i;

/** The first line of `result`'s combined output, with leading blank lines
 * and whitespace stripped. A missing-command banner is the first thing a
 * shell prints for a command it never started, before anything else could
 * run; requiring the match to be here, not merely present somewhere in the
 * buffer, is what keeps a quoted copy of the phrase inside a real failure
 * (an assertion message, a captured sub-process log) from being read as
 * the shell's own banner. See isNotRunnable. */
function firstOutputLine(result: StepResult): string {
  return combinedOutput(result).replace(/^\s+/, "").split("\n", 1)[0] ?? "";
}

export interface CommandRun {
  /** The exit code, or null when the command was killed or never ran. */
  status: number | null;
  timedOut: boolean;
  durationMs: number;
  /** True when the command printed more than the read buffer would hold
   * and was killed for it. Node reports that as ENOBUFS, and the output
   * kept up to that point is a cut-off run, not a finished one. */
  outputOverflowed?: boolean;
  /** The signal that killed the command, when something other than the
   * timeout killed it: a segfault, an out-of-memory kill, a command that
   * signals itself. Null or absent when nothing did. */
  killedBySignal?: string | null;
}

/**
 * The outcome of one command. The three ways of ending without a verdict
 * are told apart here and nowhere else. Order matters: a run that hit the
 * timeout is a timeout even though a signal killed it, and an overflow
 * kill also carries a signal, so the signal branch is asked last.
 */
export function outcomeFor(run: CommandRun): StepOutcome {
  if (run.timedOut) return "timed-out";
  if (run.outputOverflowed === true) return "output-overflow";
  if (run.killedBySignal !== undefined && run.killedBySignal !== null) return "killed";
  return run.status === 0 ? "passed" : "failed";
}

/**
 * Whether `result` is a command that never ran at all, as against one that
 * ran and failed on purpose. `platform` defaults to the real
 * `process.platform` so ordinary callers need not pass it; tests pass it
 * explicitly to exercise the Windows branch on any host, since it can only
 * ever be reached there in practice.
 *
 * `notFoundTemplate`, when given, is the exact not-found text this
 * machine's own shell was seen to print, from hooks/induce.ts's
 * calibrateNotFoundTemplate; when absent (calibration was never run, or it
 * failed), WINDOWS_COMMAND_NOT_FOUND_MESSAGE's English text is used
 * instead. Either way the match is required at the start of the step's
 * output, not merely somewhere inside it: a step that ran and failed on
 * purpose can legitimately quote or log this exact phrase deep in its own
 * output (a test asserting on a captured sub-process failure, say), and
 * matching anywhere in the buffer would misread that real failure as a
 * command that never ran, hiding the actual finding behind a false
 * could-not-run. The shell's own banner is always the first thing printed
 * for a command it never started, so anchoring to the first line tells the
 * two apart.
 */
export function isNotRunnable(
  result: StepResult,
  platform: NodeJS.Platform = process.platform,
  notFoundTemplate?: string,
): boolean {
  if (result.outcome !== "failed" || result.exitCode === null) return false;
  if (NOT_RUNNABLE_EXIT_CODES.includes(result.exitCode)) return true;
  if (platform !== "win32" || result.exitCode !== 1) return false;
  const firstLine = firstOutputLine(result).toLowerCase();
  return notFoundTemplate !== undefined
    ? firstLine.includes(notFoundTemplate.toLowerCase())
    : WINDOWS_COMMAND_NOT_FOUND_MESSAGE.test(firstLine);
}

function findStep(steps: StepResult[], step: StepName): StepResult | undefined {
  return steps.find((result) => result.step === step);
}

/**
 * The verdict for one spec, from what its commands did.
 *
 *   proven                  inject passed, neutralize failed
 *   handler-did-not-fire    inject failed
 *   check-does-not-measure  inject passed and neutralize passed too
 *   could-not-run           a step timed out, never ran, was never
 *                           runnable, or the baseline was already failing
 *
 * check-does-not-measure is the finding this command exists for. The check
 * came back green with the handling taken away, so it would come back
 * green if the handling produced nothing at all, and it says nothing about
 * whether the handling works.
 *
 * `platform` and `notFoundTemplate` are threaded through to
 * `isNotRunnable` and default the same way; see that function for why.
 */
export function verdictFor(
  steps: StepResult[],
  platform: NodeJS.Platform = process.platform,
  notFoundTemplate?: string,
): { verdict: Verdict; reason?: UnrunReason } {
  const baseline = findStep(steps, "baseline");
  if (baseline !== undefined && baseline.outcome === "failed") {
    return {
      verdict: "could-not-run",
      reason: isNotRunnable(baseline, platform, notFoundTemplate) ? "command-not-runnable" : "baseline-failed",
    };
  }
  if (baseline !== undefined && unjudgedReason(baseline.outcome) !== undefined) {
    return { verdict: "could-not-run", reason: unjudgedReason(baseline.outcome) };
  }

  const inject = findStep(steps, "inject");
  const neutralize = findStep(steps, "neutralize");
  if (inject === undefined || neutralize === undefined) {
    return { verdict: "could-not-run", reason: "spec-invalid" };
  }
  for (const result of [inject, neutralize]) {
    const unjudged = unjudgedReason(result.outcome);
    if (unjudged !== undefined) return { verdict: "could-not-run", reason: unjudged };
    if (result.outcome === "not-run") return { verdict: "could-not-run", reason: "command-not-runnable" };
    if (isNotRunnable(result, platform, notFoundTemplate)) {
      return { verdict: "could-not-run", reason: "command-not-runnable" };
    }
  }

  if (inject.outcome !== "passed") return { verdict: "handler-did-not-fire" };
  if (neutralize.outcome === "passed") return { verdict: "check-does-not-measure" };
  return { verdict: "proven" };
}

/** Builds the finished run for one spec from its step results. `platform`
 * and `notFoundTemplate` are passed through to `verdictFor`; see
 * `isNotRunnable` for why they exist and what they default to. */
export function runFromSteps(
  file: string,
  claim: string,
  steps: StepResult[],
  platform: NodeJS.Platform = process.platform,
  notFoundTemplate?: string,
): SpecRun {
  const { verdict, reason } = verdictFor(steps, platform, notFoundTemplate);
  return reason === undefined ? { file, claim, steps, verdict } : { file, claim, steps, verdict, reason };
}

/** The run for a spec file that could not be read at all. */
export function unreadableSpecRun(file: string, problems: string[]): SpecRun {
  return { file, claim: "", steps: [], verdict: "could-not-run", reason: "spec-invalid", problems };
}

/** The reasons that mean a command ran and was cut off before it could be
 * judged, as against a run that could not happen as asked at all. */
const UNMEASURED_REASONS: readonly UnrunReason[] = ["timeout", "killed-by-signal", "output-overflow"];

/** True when a run was left unmeasured by a command that was cut off, as
 * against a run that could not happen as asked. Only a cut-off command
 * counts: it was never judged, and folding it into a fail would credit a
 * control that nothing watched. */
export function isUnmeasured(run: SpecRun): boolean {
  return run.verdict === "could-not-run" && run.reason !== undefined && UNMEASURED_REASONS.includes(run.reason);
}

export function isFinding(run: SpecRun): boolean {
  return run.verdict === "handler-did-not-fire" || run.verdict === "check-does-not-measure";
}

/**
 * Exit code for a finished set of runs:
 *   0  every spec proven
 *   1  at least one spec not proven: the handling did not fire, or the
 *      check does not measure it
 *   2  could not run as asked: no specs at all, a malformed spec, a spec
 *      with no neutralize, a command that was never runnable, or a
 *      baseline that was already failing
 *   3  nothing failed, but at least one spec timed out and so was never
 *      measured
 * Exit 2 wins over everything: a run that could not happen must never read
 * like a run that happened and found nothing. Exit 1 wins over exit 3 for
 * the same reason mutate does it that way: a real finding is the more
 * useful thing to report.
 */
export function exitCodeFor(runs: SpecRun[]): 0 | 1 | 2 | 3 {
  if (runs.length === 0) return 2;
  if (runs.some((run) => run.verdict === "could-not-run" && !isUnmeasured(run))) return 2;
  if (runs.some(isFinding)) return 1;
  if (runs.some(isUnmeasured)) return 3;
  return 0;
}

// --- reporting ----------------------------------------------------------------

export interface RunSummary {
  proven: number;
  "handler-did-not-fire": number;
  "check-does-not-measure": number;
  "could-not-run": number;
}

export function summarize(runs: SpecRun[]): RunSummary {
  const summary: RunSummary = {
    proven: 0,
    "handler-did-not-fire": 0,
    "check-does-not-measure": 0,
    "could-not-run": 0,
  };
  for (const run of runs) summary[run.verdict]++;
  return summary;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function describeStep(result: StepResult): string {
  const detail =
    result.outcome === "timed-out"
      ? "timed out"
      : result.outcome === "not-run"
        ? "never ran"
        : result.outcome === "killed"
          ? (result.failure ?? "killed by a signal")
          : result.outcome === "output-overflow"
            ? (result.failure ?? "printed more output than this tool will hold")
            : `exit ${result.exitCode ?? "killed"}`;
  return `${result.outcome} (${detail}, ${seconds(result.durationMs)})`;
}

/** What each verdict says, held to what the tool watched. The tool ran two
 * commands and read two exit codes: it did not watch a handling fire, and
 * it does not know why the neutralize command failed. Every line here says
 * only what was observed; the "What this does not tell you" line in the
 * report carries the reading of it. */
const VERDICT_LINES: Record<Verdict, string> = {
  proven: "proven: the inject command passed and the neutralize command failed.",
  "handler-did-not-fire":
    "handler-did-not-fire: the inject command did not pass, so nothing here shows the handling firing.",
  "check-does-not-measure":
    "check-does-not-measure: the neutralize command passed, so the check passes with the handling taken away and would pass if the handling produced nothing. It is not measuring the handling, and the claim is unproven whatever the inject command did.",
  "could-not-run": "could-not-run: this spec was never judged.",
};

const REASON_LINES: Record<UnrunReason, string> = {
  "spec-invalid": "the spec could not be read.",
  "baseline-failed": "the baseline was already failing, so no later run can say what the injection did.",
  "command-not-runnable": "a command could not be executed at all (exit 126 or 127).",
  timeout: "a command hit the timeout and was killed, so that step has no verdict.",
  "killed-by-signal": "a command was killed by a signal before it finished, so that step has no verdict.",
  "output-overflow":
    "a command printed more output than this tool will hold and was killed for it, so that step has no verdict.",
};

/** The label on the tail printed under a proven verdict. */
export const NEUTRALIZE_TAIL_HEADING = `Neutralize output, tail (last ${TAIL_MAX_LINES} lines, at most ${TAIL_MAX_CHARS} characters).`;

/** Both streams of one step, in the order a terminal would have shown
 * them, with an empty stream contributing nothing. A runner that prints
 * its reason to stderr and a runner that prints it to stdout both have to
 * read back the same way. */
export function combinedOutput(result: StepResult): string {
  return [result.stdout, result.stderr].filter((text) => text.trim() !== "").join("\n");
}

/**
 * The evidence block for one proven spec: the claim, both commands, and
 * what each one did. This is text a delivery report can cite.
 * `validate-report` asks a robustness claim to point at a commit, a path,
 * or a command; the inject command named here is that command. The two
 * checks stay apart on purpose: `induce` never reads a report, and
 * `validate-report` never runs a spec.
 */
export function formatEvidence(run: SpecRun): string {
  const lines: string[] = [];
  lines.push(`Claim: ${run.claim}`);
  lines.push(`Spec: ${run.file}`);
  for (const step of STEP_ORDER) {
    const result = findStep(run.steps, step);
    if (result === undefined) continue;
    const label = step === "inject" ? "inject     " : step === "neutralize" ? "neutralize " : "baseline   ";
    lines.push(`  ${label}${result.command}`);
    lines.push(`    ${describeStep(result)}`);
  }
  lines.push(`  Verdict: ${VERDICT_LINES[run.verdict]}`);
  if (run.reason !== undefined) lines.push(`  Why: ${REASON_LINES[run.reason]}`);
  // A proven verdict rests entirely on the neutralize command failing, and
  // any failure at all counts: a syntax error, a missing file, a runner
  // collecting no tests. None of those measure the handling, and the exit
  // code alone cannot tell them from a control that worked. Printing what
  // the command said is what lets a reader see which one this was.
  if (run.verdict === "proven") {
    const neutralize = findStep(run.steps, "neutralize");
    const tail = neutralize === undefined ? "" : outputTail(combinedOutput(neutralize));
    if (tail === "") {
      lines.push("  Neutralize output: nothing was printed, so this block shows no reason it failed.");
    } else {
      lines.push(`  ${NEUTRALIZE_TAIL_HEADING}`);
      lines.push("  Nothing here checks why it failed, so read it:");
      for (const line of tail.split("\n")) lines.push(`    | ${line}`);
    }
  }
  if (run.problems !== undefined && run.problems.length > 0) {
    for (const problem of run.problems) lines.push(`  Problem: ${problem}`);
  }
  return lines.join("\n");
}

export interface ReportInput {
  /** Where the specs came from, for the header line. */
  source: string;
  /** The default per-command timeout, in milliseconds. */
  timeoutMs: number;
  runs: SpecRun[];
  /** Entries found beside the specs that were not run, named so that a
   * near miss such as `retry.JSON` or `retry.json.bak` cannot be dropped
   * in silence. A run that measured less than the directory holds must
   * never read like a run that measured all of it. */
  skipped?: string[];
}

/** The header line naming what was not run, or an empty string when
 * everything in the directory was. */
export function formatSkipped(skipped: readonly string[] | undefined): string {
  if (skipped === undefined || skipped.length === 0) return "";
  const count = skipped.length;
  return (
    `Not run: ${count} ${count === 1 ? "entry" : "entries"} beside the specs ` +
    `${count === 1 ? "is" : "are"} not a *.json spec file (${skipped.join(", ")})`
  );
}

export function formatReportText(input: ReportInput): string {
  const summary = summarize(input.runs);
  const lines: string[] = [];
  lines.push(`Specs: ${input.source}`);
  lines.push(`Default per-command timeout: ${seconds(input.timeoutMs)}`);
  const skipped = formatSkipped(input.skipped);
  if (skipped !== "") lines.push(skipped);
  lines.push(
    `proven ${summary.proven}, handler-did-not-fire ${summary["handler-did-not-fire"]}, ` +
      `check-does-not-measure ${summary["check-does-not-measure"]}, could-not-run ${summary["could-not-run"]}`,
  );
  for (const run of input.runs) {
    lines.push("");
    lines.push(formatEvidence(run));
  }
  lines.push("");
  if (input.runs.length === 0) {
    lines.push("No spec was run, so nothing was proven.");
  } else if (summary["check-does-not-measure"] > 0) {
    lines.push(
      "At least one check passed with the handling taken away. That check would pass if the feature produced nothing.",
    );
  } else if (summary["handler-did-not-fire"] > 0) {
    lines.push("At least one inject run did not pass, so the handling was never seen to fire.");
  } else if (summary["could-not-run"] > 0) {
    lines.push("At least one spec was never judged, so nothing above covers it.");
  } else {
    lines.push("Every spec: the inject command passed and the neutralize command failed.");
  }
  lines.push(
    "What this does not tell you: whether the spec describes the failure a report means, " +
      "why the neutralize command failed, and whether the spec is honest.",
  );
  return lines.join("\n");
}

export function formatReportJson(input: ReportInput): string {
  return `${JSON.stringify(
    {
      source: input.source,
      timeoutMs: input.timeoutMs,
      skipped: input.skipped ?? [],
      summary: summarize(input.runs),
      runs: input.runs,
    },
    null,
    2,
  )}\n`;
}
