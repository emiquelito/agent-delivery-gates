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
  exitCodeFor,
  formatEvidence,
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
  type SpecRun,
  type StepName,
  type StepOutcome,
  type StepResult,
} from "../src/induce.ts";

function step(name: StepName, outcome: StepOutcome, exitCode: number | null = null): StepResult {
  return { step: name, command: `run-${name}`, outcome, exitCode, durationMs: 100 };
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
    { step: "inject", command: "pytest -k retries", outcome: "passed", exitCode: 0, durationMs: 1200 },
    { step: "neutralize", command: "NO_RETRY=1 pytest -k retries", outcome: "failed", exitCode: 1, durationMs: 900 },
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
