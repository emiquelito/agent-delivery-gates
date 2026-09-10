// Tests for src/induce.ts, the pure core of `adg induce`: spec validation,
// the verdict rules, the exit-code rule, and the report text. Nothing here
// runs a command or touches a file; tests/induce-cli.test.ts does that
// against real scratch directories.
//
// The rule these tests hold: a check that passes with the handling taken
// away is not measuring the handling, and must never be reported as proof.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  combinedOutput,
  exitCodeFor,
  formatEvidence,
  formatSkipped,
  keepTail,
  outputTail,
  TAIL_MAX_CHARS,
  TAIL_MAX_LINES,
  formatReportJson,
  formatReportText,
  isNotRunnable,
  isUnmeasured,
  outcomeFor,
  parseSpec,
  runFromSteps,
  summarize,
  unreadableSpecRun,
  validateSpec,
  verdictFor,
  WINDOWS_COMMAND_NOT_FOUND_MESSAGE,
  type SpecRun,
  type StepName,
  type StepOutcome,
  type StepResult,
} from "../src/induce.ts";

function step(
  name: StepName,
  outcome: StepOutcome,
  exitCode: number | null = null,
  output: { stdout?: string; stderr?: string; failure?: string } = {},
): StepResult {
  const result: StepResult = {
    step: name,
    command: `run-${name}`,
    outcome,
    exitCode,
    durationMs: 100,
    stdout: output.stdout ?? "",
    stderr: output.stderr ?? "",
  };
  if (output.failure !== undefined) result.failure = output.failure;
  return result;
}

function runWith(steps: StepResult[]): SpecRun {
  return runFromSteps("spec.json", "the retry path is handled", steps);
}

// --- spec validation ----------------------------------------------------------

test("a complete spec parses, keeping every field", () => {
  const parsed = parseSpec(
    JSON.stringify({
      claim: "the retry path is handled",
      inject: "run-inject",
      neutralize: "run-neutralize",
      baseline: "run-baseline",
      timeout: 30,
      cwd: "sub",
    }),
  );
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(parsed.spec, {
    claim: "the retry path is handled",
    inject: "run-inject",
    neutralize: "run-neutralize",
    baseline: "run-baseline",
    timeout: 30,
    cwd: "sub",
  });
});

test("a spec with no neutralize is refused, and the message says why the control is not optional", () => {
  const parsed = parseSpec(JSON.stringify({ claim: "c", inject: "run-inject" }));
  assert.equal(parsed.spec, undefined);
  assert.equal(parsed.problems.length, 1);
  assert.match(parsed.problems[0], /missing 'neutralize'/);
  assert.match(parsed.problems[0], /not optional/);
});

test("a spec with no inject, and one with no claim, are each refused", () => {
  assert.equal(parseSpec(JSON.stringify({ claim: "c", neutralize: "n" })).spec, undefined);
  assert.equal(parseSpec(JSON.stringify({ inject: "i", neutralize: "n" })).spec, undefined);
});

test("an unknown field is refused, and the message names it and lists the known fields", () => {
  const parsed = parseSpec(JSON.stringify({ claim: "c", inject: "i", neutralize: "n", injects: "typo" }));
  assert.equal(parsed.spec, undefined);
  assert.match(parsed.problems[0], /unknown field 'injects'/);
  assert.match(parsed.problems[0], /neutralize/);
});

test("malformed JSON is refused, not thrown", () => {
  const parsed = parseSpec("{ not json");
  assert.equal(parsed.spec, undefined);
  assert.match(parsed.problems[0], /not valid JSON/);
});

test("a spec that is an array, a string, or null is refused", () => {
  for (const text of ["[]", '"a spec"', "null", "7"]) {
    const parsed = parseSpec(text);
    assert.equal(parsed.spec, undefined, text);
    assert.match(parsed.problems[0], /must be a JSON object/);
  }
});

test("an empty command string is refused", () => {
  const parsed = parseSpec(JSON.stringify({ claim: "c", inject: "  ", neutralize: "n" }));
  assert.equal(parsed.spec, undefined);
  assert.match(parsed.problems.join("\n"), /'inject' must be a non-empty string/);
});

test("a non-numeric or negative timeout is refused", () => {
  for (const timeout of ["30", 0, -1]) {
    const parsed = validateSpec({ claim: "c", inject: "i", neutralize: "n", timeout });
    assert.equal(parsed.spec, undefined, String(timeout));
    assert.match(parsed.problems.join("\n"), /'timeout' must be a positive number/);
  }
});

test("every problem in one spec is reported, not just the first", () => {
  const parsed = validateSpec({ inject: 3, nope: true });
  assert.ok(parsed.problems.length >= 3, parsed.problems.join("; "));
});

// --- outcomes -----------------------------------------------------------------

test("outcomeFor: exit 0 passed, non-zero failed, a timeout its own outcome", () => {
  assert.equal(outcomeFor({ status: 0, timedOut: false, durationMs: 1 }), "passed");
  assert.equal(outcomeFor({ status: 1, timedOut: false, durationMs: 1 }), "failed");
  assert.equal(outcomeFor({ status: null, timedOut: true, durationMs: 1 }), "timed-out");
  // A killed command that also hit the timeout stays a timeout, never a fail.
  assert.equal(outcomeFor({ status: 137, timedOut: true, durationMs: 1 }), "timed-out");
});

test("exit 126 and 127 read as a command that never ran, any other non-zero does not", () => {
  assert.equal(isNotRunnable(step("neutralize", "failed", 127)), true);
  assert.equal(isNotRunnable(step("neutralize", "failed", 126)), true);
  assert.equal(isNotRunnable(step("neutralize", "failed", 1)), false);
  assert.equal(isNotRunnable(step("neutralize", "passed", 0)), false);
});

// --- Windows: a missing command is exit 1, not 126/127 (reviewer finding 3) ---
//
// cmd.exe, which Node's shell:true spawns on Windows, reports a command
// that does not exist with plain exit code 1 -- indistinguishable by exit
// code alone from an ordinary command that ran and failed on purpose. On
// Windows CI, `induce`'s own could-not-run test proved this directly: a
// neutralize step naming a nonexistent command came back "failed (exit 1)"
// and the whole spec was reported "proven" instead of "could-not-run",
// which is exactly the false robustness claim this tool exists to catch.
// `platform` is injected so this is exercised here, without a Windows
// host; see the induce report for what still needs confirming on one.

const WINDOWS_NOT_FOUND_STDERR =
  "'definitely-not-a-real-command-here' is not recognized as an internal or external command,\r\n" +
  "operable program or batch file.\r\n";

test("on win32, exit 1 with cmd.exe's not-recognized text reads as a command that never ran", () => {
  assert.equal(
    isNotRunnable(step("neutralize", "failed", 1, { stderr: WINDOWS_NOT_FOUND_STDERR }), "win32"),
    true,
  );
});

test("on win32, exit 1 without that text is an ordinary failure, not a command that never ran", () => {
  // An exit 1 a command chose on purpose must not be misread as never
  // having run at all: that would hide a real handler-did-not-fire or
  // check-does-not-measure finding behind could-not-run instead.
  assert.equal(isNotRunnable(step("neutralize", "failed", 1, { stderr: "assertion failed\n" }), "win32"), false);
  assert.equal(isNotRunnable(step("neutralize", "failed", 1)), false);
});

test("the win32 not-recognized text is never trusted off win32", () => {
  assert.equal(
    isNotRunnable(step("neutralize", "failed", 1, { stderr: WINDOWS_NOT_FOUND_STDERR }), "linux"),
    false,
  );
});

test("reproduces the Windows CI transcript: a missing neutralize command must not read as proven", () => {
  // Taken verbatim from the captured win-clean.txt CI log for
  // tests/induce-cli.test.ts:218, where these same steps, on real
  // Windows, were reported "proven" instead of "could-not-run".
  const steps: StepResult[] = [
    step("inject", "passed", 0),
    step("neutralize", "failed", 1, { stderr: WINDOWS_NOT_FOUND_STDERR }),
  ];
  const run = runFromSteps("retry.json", "a 503 is retried and never comes back as a quote", steps, "win32");
  assert.equal(run.verdict, "could-not-run");
  assert.equal(run.reason, "command-not-runnable");
  assert.notEqual(run.verdict, "proven");
});

test("WINDOWS_COMMAND_NOT_FOUND_MESSAGE matches the exact text cmd.exe printed on CI", () => {
  assert.match(WINDOWS_NOT_FOUND_STDERR, WINDOWS_COMMAND_NOT_FOUND_MESSAGE);
});

// --- reviewer finding 1: WINDOWS_COMMAND_NOT_FOUND_MESSAGE is English only ---
//
// A non-English Windows prints the same "not found" banner in its own
// language, and the hardcoded English pattern above never matches it, so
// on most of the world's Windows installations a neutralize step for a
// command that does not exist would still read as a control that ran.
// isNotRunnable's `notFoundTemplate` parameter is the fix: the caller
// (hooks/induce.ts's calibrateNotFoundTemplate) spawns a command guaranteed
// not to exist through the same shell every step runs through, and hands
// back whatever THIS machine's shell actually printed. These tests stand
// in for that machine by handing isNotRunnable a template captured from a
// simulated non-English (French) shell directly, without ever touching
// WINDOWS_COMMAND_NOT_FOUND_MESSAGE, and confirm the verdict comes out
// right from that alone.

// What a French cmd.exe prints for a missing command, and the template
// calibrateNotFoundTemplate would extract from it (the text right after
// the command's own name).
const FRENCH_NOT_FOUND_STDERR =
  "'une-commande-imaginaire' n'est pas reconnu en tant que commande interne\r\n" +
  "ou externe, un programme exécutable ou un fichier de commandes.\r\n";
const FRENCH_NOT_FOUND_TEMPLATE = "n'est pas reconnu en tant que commande interne";

test("a calibrated non-English template matches a failure with that machine's own text, not the English literal", () => {
  // The hardcoded English pattern never matches this text at all: proof
  // that only the calibrated template is doing the work below.
  assert.doesNotMatch(FRENCH_NOT_FOUND_STDERR, WINDOWS_COMMAND_NOT_FOUND_MESSAGE);

  const result = step("neutralize", "failed", 1, { stderr: FRENCH_NOT_FOUND_STDERR });
  assert.equal(isNotRunnable(result, "win32"), false, "without a template, the English fallback correctly misses it");
  assert.equal(isNotRunnable(result, "win32", FRENCH_NOT_FOUND_TEMPLATE), true);
});

test("a calibrated template produces could-not-run, not proven, for a simulated non-English shell", () => {
  const steps: StepResult[] = [
    step("inject", "passed", 0),
    step("neutralize", "failed", 1, { stderr: FRENCH_NOT_FOUND_STDERR }),
  ];
  const run = runFromSteps(
    "retry.json",
    "a 503 is retried and never comes back as a quote",
    steps,
    "win32",
    FRENCH_NOT_FOUND_TEMPLATE,
  );
  assert.equal(run.verdict, "could-not-run");
  assert.equal(run.reason, "command-not-runnable");
  assert.notEqual(run.verdict, "proven");
});

test("a calibrated template is never trusted off win32, the same as the English fallback", () => {
  assert.equal(
    isNotRunnable(
      step("neutralize", "failed", 1, { stderr: FRENCH_NOT_FOUND_STDERR }),
      "linux",
      FRENCH_NOT_FOUND_TEMPLATE,
    ),
    false,
  );
});

// --- reviewer finding 2: a quoted phrase inside a real failure must not read
// as the shell's own banner --------------------------------------------------
//
// isNotRunnable used to match WINDOWS_COMMAND_NOT_FOUND_MESSAGE against the
// step's whole combined output, with nothing requiring the text to be the
// shell's own banner and not merely a substring anywhere in the buffer. A
// step that actually ran and actually failed, and whose own output happens
// to quote this exact phrase (an assertion message, a captured sub-process
// log), was misread as a command that never ran -- hiding the real finding
// behind a false could-not-run, the opposite error and just as wrong. The
// fix anchors the match to the step's first output line, which is where a
// shell's own "not found" banner always is, and nowhere a quoted copy of it
// deeper in a real failure's own output can reach.

test("a real failure that quotes the not-recognized phrase in its own output is not read as a command that never ran", () => {
  // The reviewer's reproduction, verbatim: a step that ran, failed, and
  // whose stderr quotes the exact phrase, but not as the shell's own first
  // line -- it is the second line of an assertion failure's own message.
  const result: StepResult = {
    step: "neutralize",
    command: "npm test",
    outcome: "failed",
    exitCode: 1,
    durationMs: 100,
    stdout: "",
    stderr:
      "AssertionError: expected error handler to catch\n" +
      "  Actual stderr from subprocess: 'foo' is not recognized as an internal or external command, operable program or batch file.\n" +
      "  at test (suite.test.js:42)\n",
  };
  assert.equal(isNotRunnable(result, "win32"), false);
});

test("the same quoted-phrase case is not read as could-not-run through verdictFor either", () => {
  const steps: StepResult[] = [
    step("inject", "passed", 0),
    {
      step: "neutralize",
      command: "npm test",
      outcome: "failed",
      exitCode: 1,
      durationMs: 100,
      stdout: "",
      stderr:
        "AssertionError: expected error handler to catch\n" +
        "  Actual stderr from subprocess: 'foo' is not recognized as an internal or external command, operable program or batch file.\n" +
        "  at test (suite.test.js:42)\n",
    },
  ];
  const run = runFromSteps("retry.json", "a 503 is retried and never comes back as a quote", steps, "win32");
  // A step that ran and failed on purpose, with the assertion quoting a
  // subprocess's own not-found text, is a real finding: the handler
  // neither proved itself nor was ever shown to have not run.
  assert.notEqual(run.verdict, "could-not-run");
  assert.equal(run.verdict, "proven");
});

// --- the four verdicts --------------------------------------------------------

test("proven: inject passed and neutralize failed", () => {
  const run = runWith([step("inject", "passed", 0), step("neutralize", "failed", 1)]);
  assert.equal(run.verdict, "proven");
  assert.equal(run.reason, undefined);
});

test("handler-did-not-fire: inject failed", () => {
  const run = runWith([step("inject", "failed", 1), step("neutralize", "failed", 1)]);
  assert.equal(run.verdict, "handler-did-not-fire");
});

test("check-does-not-measure: inject passed and neutralize passed too", () => {
  const run = runWith([step("inject", "passed", 0), step("neutralize", "passed", 0)]);
  assert.equal(run.verdict, "check-does-not-measure");
});

test("could-not-run: a step timed out, and the reason is the timeout", () => {
  const injectTimeout = runWith([step("inject", "timed-out"), step("neutralize", "failed", 1)]);
  assert.equal(injectTimeout.verdict, "could-not-run");
  assert.equal(injectTimeout.reason, "timeout");
  const neutralizeTimeout = runWith([step("inject", "passed", 0), step("neutralize", "timed-out")]);
  assert.equal(neutralizeTimeout.verdict, "could-not-run");
  assert.equal(neutralizeTimeout.reason, "timeout");
});

test("a timed-out inject is never scored as a fail, and a timed-out neutralize never as proof", () => {
  assert.notEqual(runWith([step("inject", "timed-out"), step("neutralize", "failed", 1)]).verdict, "handler-did-not-fire");
  assert.notEqual(runWith([step("inject", "passed", 0), step("neutralize", "timed-out")]).verdict, "proven");
});

test("could-not-run: a failing baseline stops the run before anything is judged", () => {
  const run = runWith([
    step("baseline", "failed", 1),
    step("inject", "not-run"),
    step("neutralize", "not-run"),
  ]);
  assert.equal(run.verdict, "could-not-run");
  assert.equal(run.reason, "baseline-failed");
});

test("a passing baseline does not change a verdict", () => {
  const run = runWith([step("baseline", "passed", 0), step("inject", "passed", 0), step("neutralize", "failed", 1)]);
  assert.equal(run.verdict, "proven");
});

test("could-not-run: a neutralize command that could not be executed is not a control that worked", () => {
  const run = runWith([step("inject", "passed", 0), step("neutralize", "failed", 127)]);
  assert.equal(run.verdict, "could-not-run");
  assert.equal(run.reason, "command-not-runnable");
});

test("could-not-run: a missing step, which a valid spec can never produce", () => {
  const run = runWith([step("inject", "passed", 0)]);
  assert.equal(run.verdict, "could-not-run");
  assert.equal(run.reason, "spec-invalid");
});

test("verdictFor is the one decision: it agrees with runFromSteps", () => {
  const steps = [step("inject", "passed", 0), step("neutralize", "passed", 0)];
  assert.equal(verdictFor(steps).verdict, runWith(steps).verdict);
});

// --- exit codes ---------------------------------------------------------------

const proven = runWith([step("inject", "passed", 0), step("neutralize", "failed", 1)]);
const notMeasuring = runWith([step("inject", "passed", 0), step("neutralize", "passed", 0)]);
const didNotFire = runWith([step("inject", "failed", 1), step("neutralize", "failed", 1)]);
const timedOut = runWith([step("inject", "passed", 0), step("neutralize", "timed-out")]);
const invalid = unreadableSpecRun("bad.json", ["missing 'neutralize'"]);

test("exit 0: every spec proven", () => {
  assert.equal(exitCodeFor([proven, proven]), 0);
});

test("exit 1: a spec whose check does not measure the handling", () => {
  assert.equal(exitCodeFor([proven, notMeasuring]), 1);
});

test("exit 1: a spec whose handler did not fire", () => {
  assert.equal(exitCodeFor([proven, didNotFire]), 1);
});

test("exit 2: a malformed spec, whatever the other specs did", () => {
  assert.equal(exitCodeFor([proven, invalid]), 2);
  assert.equal(exitCodeFor([notMeasuring, invalid]), 2);
  assert.equal(exitCodeFor([timedOut, invalid]), 2);
});

test("exit 2: no specs at all is never a pass", () => {
  assert.equal(exitCodeFor([]), 2);
});

test("exit 3: nothing failed, but a spec timed out and was never measured", () => {
  assert.equal(exitCodeFor([proven, timedOut]), 3);
  assert.equal(exitCodeFor([timedOut]), 3);
});

test("exit 1 wins over exit 3: a finding is reported over an unmeasured spec", () => {
  assert.equal(exitCodeFor([timedOut, notMeasuring]), 1);
  assert.equal(exitCodeFor([timedOut, didNotFire]), 1);
});

test("one spec failing among several passing gives exit 1, and the rest keep their verdicts", () => {
  const runs = [proven, proven, didNotFire, proven];
  assert.equal(exitCodeFor(runs), 1);
  assert.deepEqual(summarize(runs), {
    proven: 3,
    "handler-did-not-fire": 1,
    "check-does-not-measure": 0,
    "could-not-run": 0,
  });
});

test("isUnmeasured counts a timeout and nothing else", () => {
  assert.equal(isUnmeasured(timedOut), true);
  assert.equal(isUnmeasured(invalid), false);
  assert.equal(isUnmeasured(proven), false);
});

// --- reporting ----------------------------------------------------------------

test("the evidence block names the claim, the spec file, and both commands", () => {
  const run = runFromSteps("specs/retry.json", "the retry path is handled", [
    {
      step: "inject",
      command: "pytest -k retries",
      outcome: "passed",
      exitCode: 0,
      durationMs: 1200,
      stdout: "1 passed\n",
      stderr: "",
    },
    {
      step: "neutralize",
      command: "NO_RETRY=1 pytest -k retries",
      outcome: "failed",
      exitCode: 1,
      durationMs: 900,
      stdout: "assert 0 == 3\n1 failed\n",
      stderr: "",
    },
  ]);
  const text = formatEvidence(run);
  assert.match(text, /Claim: the retry path is handled/);
  assert.match(text, /Spec: specs\/retry\.json/);
  assert.match(text, /inject\s+pytest -k retries/);
  assert.match(text, /neutralize\s+NO_RETRY=1 pytest -k retries/);
  assert.match(text, /passed \(exit 0, 1\.2s\)/);
  assert.match(text, /failed \(exit 1, 0\.9s\)/);
  assert.match(text, /Verdict: proven/);
});

test("the report says plainly what a check that passes both ways means", () => {
  const text = formatReportText({ source: ".adg/induced", timeoutMs: 120_000, runs: [notMeasuring] });
  assert.match(text, /check-does-not-measure/);
  assert.match(text, /would pass if the handling produced nothing/);
  assert.match(text, /pass if the feature produced nothing/);
});

test("the report never claims more than the tool checks", () => {
  const text = formatReportText({ source: ".adg/induced", timeoutMs: 120_000, runs: [proven] });
  assert.match(text, /does not tell you/);
  assert.match(text, /whether the spec is honest/);
});

test("a malformed spec's problems reach the report", () => {
  const text = formatReportText({ source: ".adg/induced", timeoutMs: 120_000, runs: [invalid] });
  assert.match(text, /Problem: missing 'neutralize'/);
  assert.match(text, /could-not-run/);
});

test("json output parses, and carries the verdict and both commands", () => {
  const parsed = JSON.parse(
    formatReportJson({ source: ".adg/induced", timeoutMs: 120_000, runs: [proven, notMeasuring] }),
  ) as { summary: Record<string, number>; runs: SpecRun[] };
  assert.equal(parsed.summary.proven, 1);
  assert.equal(parsed.summary["check-does-not-measure"], 1);
  assert.equal(parsed.runs[0].verdict, "proven");
  assert.equal(parsed.runs[0].steps.length, 2);
  assert.equal(parsed.runs[1].steps[1].step, "neutralize");
});

// --- a command cut off before it could be judged ------------------------------
//
// Three different endings, three different sentences. Reporting a signal
// kill or an overflow as a timeout tells the reader to raise a timeout that
// had nothing to do with it, so each keeps its own outcome and its own
// reason. All three leave the spec unmeasured, never failed.

test("outcomeFor tells a timeout, an overflow and a signal kill apart", () => {
  assert.equal(
    outcomeFor({ status: null, timedOut: false, durationMs: 1, outputOverflowed: true, killedBySignal: "SIGTERM" }),
    "output-overflow",
  );
  assert.equal(
    outcomeFor({ status: null, timedOut: false, durationMs: 1, outputOverflowed: false, killedBySignal: "SIGKILL" }),
    "killed",
  );
  // A timeout wins over both: the timeout kill carries a signal of its own.
  assert.equal(
    outcomeFor({ status: null, timedOut: true, durationMs: 1, outputOverflowed: true, killedBySignal: "SIGKILL" }),
    "timed-out",
  );
  // Nothing killed it, so an ordinary exit code is read as usual.
  assert.equal(outcomeFor({ status: 1, timedOut: false, durationMs: 1, killedBySignal: null }), "failed");
});

test("could-not-run: a signal-killed step is reported as killed, never as a timeout", () => {
  for (const which of ["inject", "neutralize"] as const) {
    const steps =
      which === "inject"
        ? [step("inject", "killed", null, { failure: "killed by SIGSEGV before it finished" }), step("neutralize", "failed", 1)]
        : [step("inject", "passed", 0), step("neutralize", "killed", null, { failure: "killed by SIGSEGV before it finished" })];
    const run = runWith(steps);
    assert.equal(run.verdict, "could-not-run", which);
    assert.equal(run.reason, "killed-by-signal", which);
    assert.equal(isUnmeasured(run), true, which);
  }
});

test("could-not-run: a step that printed too much is reported as an overflow, never as a timeout", () => {
  const run = runWith([step("inject", "passed", 0), step("neutralize", "output-overflow")]);
  assert.equal(run.verdict, "could-not-run");
  assert.equal(run.reason, "output-overflow");
  assert.equal(isUnmeasured(run), true);
});

test("a signal-killed or overflowing step is exit 3, and its own sentence reaches the report", () => {
  const killed = runWith([step("inject", "passed", 0), step("neutralize", "killed", null, { failure: "killed by SIGSEGV before it finished" })]);
  const overflowed = runWith([step("inject", "passed", 0), step("neutralize", "output-overflow", null, { failure: "printed more than 64 MB and was killed for it" })]);
  assert.equal(exitCodeFor([killed]), 3);
  assert.equal(exitCodeFor([overflowed]), 3);
  const killedText = formatReportText({ source: "s", timeoutMs: 120_000, runs: [killed] });
  assert.match(killedText, /killed by SIGSEGV before it finished/);
  assert.match(killedText, /killed by a signal before it finished/);
  assert.doesNotMatch(killedText, /hit the timeout/);
  const overflowText = formatReportText({ source: "s", timeoutMs: 120_000, runs: [overflowed] });
  assert.match(overflowText, /printed more output than this tool will hold/);
  assert.doesNotMatch(overflowText, /hit the timeout/);
});

// M11: without the branch that reads a cut-off baseline, a baseline that
// timed out is read as a command that could not be executed, which turns
// exit 3 into exit 2 and blames the wrong thing.
test("could-not-run: a baseline that timed out keeps the timeout reason and exit 3", () => {
  const run = runWith([
    step("baseline", "timed-out"),
    step("inject", "not-run"),
    step("neutralize", "not-run"),
  ]);
  assert.equal(run.verdict, "could-not-run");
  assert.equal(run.reason, "timeout");
  assert.equal(exitCodeFor([run]), 3);
  assert.match(formatReportText({ source: "s", timeoutMs: 1000, runs: [run] }), /hit the timeout/);
});

test("could-not-run: a baseline killed by a signal, and one that printed too much, keep their own reasons", () => {
  const killed = runWith([step("baseline", "killed"), step("inject", "not-run"), step("neutralize", "not-run")]);
  assert.equal(killed.reason, "killed-by-signal");
  assert.equal(exitCodeFor([killed]), 3);
  const overflowed = runWith([
    step("baseline", "output-overflow"),
    step("inject", "not-run"),
    step("neutralize", "not-run"),
  ]);
  assert.equal(overflowed.reason, "output-overflow");
  assert.equal(exitCodeFor([overflowed]), 3);
});

// M13: without the branch that reads a step that never ran, a stopped
// inject is scored as an inject that did not pass, which reports
// handler-did-not-fire against a handling nothing ever exercised.
test("could-not-run: a step that never ran is not an inject that failed", () => {
  const run = runWith([step("inject", "not-run"), step("neutralize", "not-run")]);
  assert.equal(run.verdict, "could-not-run");
  assert.equal(run.reason, "command-not-runnable");
  assert.notEqual(run.verdict, "handler-did-not-fire");
  assert.equal(exitCodeFor([run]), 2);
});

// --- the output a proven verdict rests on -------------------------------------

test("keepTail keeps the end, and short text untouched", () => {
  assert.equal(keepTail("short", 100), "short");
  assert.equal(keepTail("abcdef", 3), "def");
});

test("outputTail keeps the last lines, cut to the character limit, and drops nothing else", () => {
  const many = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
  const tail = outputTail(many);
  assert.equal(tail.split("\n").length, TAIL_MAX_LINES);
  assert.match(tail, /line 60$/);
  assert.doesNotMatch(tail, /line 40\b/);
  assert.ok(outputTail("x".repeat(TAIL_MAX_CHARS * 2)).length <= TAIL_MAX_CHARS);
  assert.equal(outputTail("   \n\n"), "");
});

test("combinedOutput reads a runner that prints to either stream", () => {
  assert.equal(combinedOutput(step("neutralize", "failed", 1, { stderr: "SyntaxError\n" })), "SyntaxError\n");
  assert.equal(combinedOutput(step("neutralize", "failed", 1, { stdout: "1 failed\n" })), "1 failed\n");
  assert.equal(
    combinedOutput(step("neutralize", "failed", 1, { stdout: "out", stderr: "err" })),
    "out\nerr",
  );
  assert.equal(combinedOutput(step("neutralize", "failed", 1)), "");
});

test("a proven spec prints the tail of what the neutralize command said, labelled a tail", () => {
  const run = runWith([
    step("inject", "passed", 0, { stdout: "ok\n" }),
    step("neutralize", "failed", 1, { stderr: 'File "check.py", line 3\n    def (\nSyntaxError: invalid syntax\n' }),
  ]);
  const text = formatEvidence(run);
  assert.match(text, /SyntaxError: invalid syntax/);
  assert.match(text, /tail/);
  assert.match(text, new RegExp(`last ${TAIL_MAX_LINES} lines`));
  assert.match(text, /Nothing here checks why it failed/);
});

test("a proven spec whose neutralize command printed nothing says so", () => {
  const run = runWith([step("inject", "passed", 0), step("neutralize", "failed", 1)]);
  assert.match(formatEvidence(run), /nothing was printed/);
});

test("a proven spec prints at most the tail, never the whole run", () => {
  const noisy = Array.from({ length: 500 }, (_, i) => `noise ${i}`).join("\n");
  const run = runWith([step("inject", "passed", 0), step("neutralize", "failed", 1, { stdout: noisy })]);
  const text = formatEvidence(run);
  assert.doesNotMatch(text, /noise 0\b/);
  assert.match(text, /noise 499/);
});

test("json output carries what each command printed", () => {
  const run = runWith([
    step("inject", "passed", 0, { stdout: "no quote written\n" }),
    step("neutralize", "failed", 1, { stderr: "SyntaxError: invalid syntax\n" }),
  ]);
  const parsed = JSON.parse(formatReportJson({ source: "s", timeoutMs: 120_000, runs: [run] })) as {
    runs: { steps: { stdout: string; stderr: string }[] }[];
  };
  assert.equal(parsed.runs[0].steps[0].stdout, "no quote written\n");
  assert.equal(parsed.runs[0].steps[1].stderr, "SyntaxError: invalid syntax\n");
});

// --- the verdict claims only what was observed --------------------------------

test("the proven verdict line claims two exit codes and nothing more", () => {
  const text = formatEvidence(runWith([step("inject", "passed", 0), step("neutralize", "failed", 1)]));
  assert.match(text, /Verdict: proven: the inject command passed and the neutralize command failed\./);
  assert.doesNotMatch(text, /the handling fired/);
});

test("the summary line for an all-proven run claims two exit codes and nothing more", () => {
  const text = formatReportText({
    source: "s",
    timeoutMs: 120_000,
    runs: [runWith([step("inject", "passed", 0), step("neutralize", "failed", 1)])],
  });
  assert.match(text, /Every spec: the inject command passed and the neutralize command failed\./);
  assert.doesNotMatch(text, /each handling fired/);
  assert.doesNotMatch(text, /each control failed/);
  assert.match(text, /why the neutralize command failed/);
});

// --- entries that were not run ------------------------------------------------

test("formatSkipped names and counts every entry that was not run", () => {
  assert.equal(formatSkipped(undefined), "");
  assert.equal(formatSkipped([]), "");
  const one = formatSkipped(["b-second.JSON"]);
  assert.match(one, /1 entry/);
  assert.match(one, /b-second\.JSON/);
  const three = formatSkipped(["b-second.JSON", "c-third.json.bak", "d-fourth.jsonc"]);
  assert.match(three, /3 entries/);
  for (const name of ["b-second.JSON", "c-third.json.bak", "d-fourth.jsonc"]) {
    assert.ok(three.includes(name), name);
  }
});

test("a skipped entry reaches the report header even when every spec that ran was proven", () => {
  const text = formatReportText({
    source: "specs",
    timeoutMs: 120_000,
    runs: [runWith([step("inject", "passed", 0), step("neutralize", "failed", 1)])],
    skipped: ["b-second.JSON"],
  });
  assert.match(text, /Not run: 1 entry/);
  assert.match(text, /b-second\.JSON/);
});

test("json output carries the entries that were not run", () => {
  const parsed = JSON.parse(
    formatReportJson({ source: "specs", timeoutMs: 120_000, runs: [], skipped: ["c-third.json.bak"] }),
  ) as { skipped: string[] };
  assert.deepEqual(parsed.skipped, ["c-third.json.bak"]);
});
