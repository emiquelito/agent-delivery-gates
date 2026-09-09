// Pure core for `adg induce`. Reads a spec that a person or an agent
// wrote, decides whether that spec is well formed, turns the outcomes of
// the commands it declares into a verdict, and formats the report. No I/O,
// no subprocess, no process exit: the CLI in hooks/induce.ts does all of
// that, so the rule that decides what counts as proof lives in one place
// and can be tested without running anything.
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

/** What one command did. */
export type StepOutcome = "passed" | "failed" | "timed-out" | "not-run";

export interface StepResult {
  step: StepName;
  command: string;
  outcome: StepOutcome;
  /** The exit code, or null when the command was killed or never ran. */
  exitCode: number | null;
  durationMs: number;
}

export type Verdict = "proven" | "handler-did-not-fire" | "check-does-not-measure" | "could-not-run";

/** Why a run could not be judged. Kept apart from the verdict because the
 * exit code differs: a timeout leaves the spec unmeasured (exit 3), while
 * a malformed spec or a command that never started means the run could not
 * happen as asked (exit 2). */
export type UnrunReason = "spec-invalid" | "baseline-failed" | "command-not-runnable" | "timeout";

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

export interface CommandRun {
  /** The exit code, or null when the command was killed or never ran. */
  status: number | null;
  timedOut: boolean;
  durationMs: number;
}

export function outcomeFor(run: CommandRun): StepOutcome {
  if (run.timedOut) return "timed-out";
  return run.status === 0 ? "passed" : "failed";
}

export function isNotRunnable(result: StepResult): boolean {
  return result.outcome === "failed" && result.exitCode !== null && NOT_RUNNABLE_EXIT_CODES.includes(result.exitCode);
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
 */
export function verdictFor(steps: StepResult[]): { verdict: Verdict; reason?: UnrunReason } {
  const baseline = findStep(steps, "baseline");
  if (baseline !== undefined && baseline.outcome === "failed") {
    return { verdict: "could-not-run", reason: isNotRunnable(baseline) ? "command-not-runnable" : "baseline-failed" };
  }
  if (baseline !== undefined && baseline.outcome === "timed-out") {
    return { verdict: "could-not-run", reason: "timeout" };
  }

  const inject = findStep(steps, "inject");
  const neutralize = findStep(steps, "neutralize");
  if (inject === undefined || neutralize === undefined) {
    return { verdict: "could-not-run", reason: "spec-invalid" };
  }
  for (const result of [inject, neutralize]) {
    if (result.outcome === "timed-out") return { verdict: "could-not-run", reason: "timeout" };
    if (result.outcome === "not-run") return { verdict: "could-not-run", reason: "command-not-runnable" };
    if (isNotRunnable(result)) return { verdict: "could-not-run", reason: "command-not-runnable" };
  }

  if (inject.outcome !== "passed") return { verdict: "handler-did-not-fire" };
  if (neutralize.outcome === "passed") return { verdict: "check-does-not-measure" };
  return { verdict: "proven" };
}

/** Builds the finished run for one spec from its step results. */
export function runFromSteps(file: string, claim: string, steps: StepResult[]): SpecRun {
  const { verdict, reason } = verdictFor(steps);
  return reason === undefined ? { file, claim, steps, verdict } : { file, claim, steps, verdict, reason };
}

/** The run for a spec file that could not be read at all. */
export function unreadableSpecRun(file: string, problems: string[]): SpecRun {
  return { file, claim: "", steps: [], verdict: "could-not-run", reason: "spec-invalid", problems };
}

/** True when a run was left unmeasured by a timeout, as against a run that
 * could not happen as asked. Only a timeout counts: a timed-out command
 * was never judged, and folding it into a fail would credit a control that
 * nothing watched. */
export function isUnmeasured(run: SpecRun): boolean {
  return run.verdict === "could-not-run" && run.reason === "timeout";
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
  if (runs.some((run) => run.verdict === "could-not-run" && run.reason !== "timeout")) return 2;
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
        : `exit ${result.exitCode ?? "killed"}`;
  return `${result.outcome} (${detail}, ${seconds(result.durationMs)})`;
}

const VERDICT_LINES: Record<Verdict, string> = {
  proven:
    "proven: the failure was induced and the handling fired, and the same check failed once the handling was taken away.",
  "handler-did-not-fire":
    "handler-did-not-fire: the inject run did not pass, so nothing here shows the handling firing.",
  "check-does-not-measure":
    "check-does-not-measure: the check passed with the handling taken away, so it would pass if the handling produced nothing. It is not measuring the handling, and the claim is unproven whatever the inject run did.",
  "could-not-run": "could-not-run: this spec was never judged.",
};

const REASON_LINES: Record<UnrunReason, string> = {
  "spec-invalid": "the spec could not be read.",
  "baseline-failed": "the baseline was already failing, so no later run can say what the injection did.",
  "command-not-runnable": "a command could not be executed at all (exit 126 or 127).",
  timeout: "a command hit the timeout and was killed, so that step has no verdict.",
};

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
}

export function formatReportText(input: ReportInput): string {
  const summary = summarize(input.runs);
  const lines: string[] = [];
  lines.push(`Specs: ${input.source}`);
  lines.push(`Default per-command timeout: ${seconds(input.timeoutMs)}`);
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
    lines.push("Every spec was proven: each failure was induced, each handling fired, and each control failed.");
  }
  lines.push(
    "What this does not tell you: whether the spec describes the failure a report means, and whether the spec is honest.",
  );
  return lines.join("\n");
}

export function formatReportJson(input: ReportInput): string {
  return `${JSON.stringify(
    {
      source: input.source,
      timeoutMs: input.timeoutMs,
      summary: summarize(input.runs),
      runs: input.runs,
    },
    null,
    2,
  )}\n`;
}
