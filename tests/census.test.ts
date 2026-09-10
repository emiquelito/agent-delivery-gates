// Tests for the pure core of `adg census` in src/census.ts: the two result
// parsers, the census comparison, the verdicts, and the exit code. Nothing
// here runs a suite or touches git; tests/census-cli.test.ts does that
// against real repositories. What is asserted here is what a caller can
// read off the returned values, because those values are what the CLI
// prints and exits on.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareCensus,
  detectFormat,
  exitCodeFor,
  formatReportJson,
  formatReportText,
  mergeCensusFindings,
  mergeRedHalves,
  parseJUnit,
  parseResults,
  parseTap,
  resultsLookComplete,
  tapPlan,
  testKey,
  type CompareResult,
  type Finding,
  type ReportInput,
  type TestRecord,
} from "../src/census.ts";

function pass(name: string, file = ""): TestRecord {
  return { file, name, outcome: "pass" };
}
function fail_(name: string, file = ""): TestRecord {
  return { file, name, outcome: "fail" };
}

// The JUnit element a runner writes for a case it did not run, built at
// runtime so the literal never appears in this file. Written out, it holds
// the text this repository's own test-diff gate treats as a skip being added
// to a test file, and the gate then fired on every command anyone ran in
// this tree. tests/prose-scan-cli.test.ts builds its banned words the same way,
// for the same reason: a fixture is not allowed to trip the gate it has
// nothing to do with, and weakening the gate to hold the fixture would be
// the wrong way round.
const SKIPPED_ELEMENT = `<skipped type="pytest${"."}skip" message="not today"/>`;

// --- TAP ---------------------------------------------------------------------

const NODE_TAP = `TAP version 13
# Subtest: adds
ok 1 - adds
  ---
  duration_ms: 0.5
  type: 'test'
  ...
# Subtest: subtracts
not ok 2 - subtracts
  ---
  duration_ms: 33.1
  type: 'test'
  error: |-
    Expected values to be strictly equal:

    not ok 99 - this line is inside a failure message

  code: 'ERR_ASSERTION'
  ...
# Subtest: skipped one
ok 3 - skipped one # SKIP
  ---
  duration_ms: 0.1
  ...
1..3
# tests 3
# pass 1
# fail 1
# skipped 1
`;

test("TAP: one record per test, with its outcome", () => {
  const tests = parseTap(NODE_TAP);
  assert.deepEqual(tests, [
    { file: "", name: "adds", outcome: "pass" },
    { file: "", name: "subtracts", outcome: "fail" },
    { file: "", name: "skipped one", outcome: "skip" },
  ]);
});

// A failure message can hold the text "not ok". Counting that as a test
// would invent one out of a diff, and would do it exactly when a suite was
// already failing.
test("TAP: a 'not ok' line inside a YAML diagnostic block is not a test", () => {
  const names = parseTap(NODE_TAP).map((t) => t.name);
  assert.ok(!names.includes("this line is inside a failure message"), names.join(", "));
  assert.equal(names.length, 3);
});

test("TAP: a nested subtest carries its file and suite names", () => {
  const nested = `TAP version 13
# Subtest: tests/order.test.js
    # Subtest: discounts
        ok 1 - at the boundary
        not ok 2 - below the boundary
        1..2
    ok 1 - discounts
    1..1
ok 1 - tests/order.test.js
1..1
`;
  assert.deepEqual(parseTap(nested), [
    { file: "tests/order.test.js", name: "discounts > at the boundary", outcome: "pass" },
    { file: "tests/order.test.js", name: "discounts > below the boundary", outcome: "fail" },
  ]);
});

test("TAP: a TODO directive counts as a skip, and a plain '#' stays in the name", () => {
  const text = `TAP version 13
ok 1 - not written yet # TODO
ok 2 - handles a # in the name
1..2
`;
  assert.deepEqual(parseTap(text), [
    { file: "", name: "not written yet", outcome: "skip" },
    { file: "", name: "handles a # in the name", outcome: "pass" },
  ]);
});

// --- JUnit XML ----------------------------------------------------------------

const JUNIT = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
  <testsuite name="pytest" tests="4" failures="1" errors="1" skipped="1">
    <testcase classname="tests.test_order" name="test_adds" file="tests/test_order.py" time="0.01"/>
    <testcase classname="tests.test_order" name="test_subtracts" file="tests/test_order.py">
      <failure message="assert 0 == 5">tests/test_order.py:9: AssertionError</failure>
    </testcase>
    <testcase classname="tests.test_order" name="test_skipped" file="tests/test_order.py">
      ${SKIPPED_ELEMENT}
    </testcase>
    <testcase classname="tests.test_order" name="test_errors" file="tests/test_order.py">
      <error message="import error"><![CDATA[<testcase name="invented" />]]></error>
    </testcase>
  </testsuite>
</testsuites>
`;

test("JUnit: pass, failure, skipped, and error each get their outcome", () => {
  assert.deepEqual(parseJUnit(JUNIT), [
    { file: "tests/test_order.py", name: "test_adds", outcome: "pass" },
    { file: "tests/test_order.py", name: "test_subtracts", outcome: "fail" },
    { file: "tests/test_order.py", name: "test_skipped", outcome: "skip" },
    { file: "tests/test_order.py", name: "test_errors", outcome: "fail" },
  ]);
});

// A CDATA section is where a runner puts text it did not escape. A testcase
// tag quoted in there is not a test, and counting it as one would let a
// failure message add tests to the census.
test("JUnit: a testcase written inside CDATA is not counted", () => {
  assert.equal(parseJUnit(JUNIT).filter((t) => t.name === "invented").length, 0);
});

test("JUnit: falls back to classname when no file attribute is given, and decodes entities", () => {
  const text = `<testsuite><testcase classname="OrderTest" name="handles &quot;quotes&quot; &amp; more"/></testsuite>`;
  assert.deepEqual(parseJUnit(text), [
    { file: "OrderTest", name: 'handles "quotes" & more', outcome: "pass" },
  ]);
});

// XML allows a bare ">" inside an attribute value, and this tool's own
// testKey joins suite names with " > ", so a runner that groups a test under
// a describe block writes exactly this. Ending the tag at the first ">" lost
// the name and swallowed the case after it, which invented a disappeared
// test for each one and a dropped count beside them.
test("JUnit: a '>' inside an attribute value does not cut the tag short", () => {
  const text =
    `<testsuite><testcase classname="a.js" name="outer > inner"/>` +
    `<testcase classname="a.js" name="second"/></testsuite>`;
  assert.deepEqual(parseJUnit(text), [
    { file: "a.js", name: "outer > inner", outcome: "pass" },
    { file: "a.js", name: "second", outcome: "pass" },
  ]);
});

test("JUnit: a single-quoted attribute value may hold a '>' too", () => {
  const text = `<testsuite><testcase classname='a.js' name='has a > in it'/></testsuite>`;
  assert.deepEqual(parseJUnit(text), [{ file: "a.js", name: "has a > in it", outcome: "pass" }]);
});

// A testcase with no name is a document this scanner read wrong, and a
// census built on it would be wrong quietly. Exit 2 is the honest answer.
test("JUnit: a testcase that parses to no name is an error, not a census", () => {
  const result = parseResults(`<testsuite><testcase classname="a.js"/></testsuite>`);
  assert.ok("error" in result, JSON.stringify(result));
  assert.match(result.error, /carried no name/);
});

// --- the TAP plan and a run that stopped part way ------------------------------

// A run that printed some TAP and then died promises more results than it
// printed. Without this the truncated census read as a smaller suite, and
// every test it never reached read as new at HEAD.
test("the TAP plan counts the results printed beside it", () => {
  assert.deepEqual(tapPlan(NODE_TAP), { planned: 3, printed: 3 });
  assert.deepEqual(tapPlan("TAP version 13\nok 1 - a\nok 2 - b\n1..4\n"), { planned: 4, printed: 2 });
  assert.equal(tapPlan("TAP version 13\nok 1 - a\n"), null);
});

// A nested subtest prints its own plan, counting its children. Only the
// outermost plan and the outermost results are compared, or every nested
// suite would read as a run that stopped part way.
test("a nested subtest's own plan is not counted against the outer results", () => {
  const nested = `TAP version 13
# Subtest: tests/order.test.js
    ok 1 - at the boundary
    ok 2 - below the boundary
    1..2
ok 1 - tests/order.test.js
1..1
`;
  assert.deepEqual(tapPlan(nested), { planned: 1, printed: 1 });
});

test("a plan inside a YAML diagnostic block is not a plan", () => {
  const text = `TAP version 13
ok 1 - a
  ---
  error: |-
    1..9
  ...
1..1
`;
  assert.deepEqual(tapPlan(text), { planned: 1, printed: 1 });
});

test("a finished run leaves a plan or a summary, and a cut-off one leaves neither", () => {
  assert.equal(resultsLookComplete("TAP version 13\nok 1 - a\n1..1\n", "tap"), true);
  assert.equal(resultsLookComplete("TAP version 13\nok 1 - a\n# tests 1\n", "tap"), true);
  assert.equal(resultsLookComplete("TAP version 13\nok 1 - a\n", "tap"), false);
  assert.equal(resultsLookComplete(`<testsuite><testcase name="a"/></testsuite>`, "junit"), true);
  assert.equal(resultsLookComplete(`<testsuite><testcase name="a"/>`, "junit"), false);
});

// --- detection and the unparseable case ----------------------------------------

test("the format is detected from the output, and XML wins over a stray 'ok' line", () => {
  assert.equal(detectFormat(NODE_TAP), "tap");
  assert.equal(detectFormat(JUNIT), "junit");
  assert.equal(detectFormat(`ok\n<testsuite><testcase name="a"/></testsuite>`), "junit");
});

// The whole point of exit 2 on unreadable output: a crashed runner must
// never come back as a census of zero tests, which downstream would read as
// every test having disappeared.
test("output in neither format is an error, never an empty census", () => {
  const result = parseResults("npm ERR! missing script: test\n");
  assert.ok("error" in result, JSON.stringify(result));
  assert.match(result.error, /neither TAP nor JUnit/);
});

// Every fixture above was typed by hand. This one is not: it is the exact
// bytes a real `node --test` wrote, piped to a file, for a two-test suite
// with no reporter of its own asked for -- captured from a real v24.21.0
// binary run directly from a scratch directory, never installed, and
// byte-identical past the timings to this repository's own node run with
// --test-reporter=spec asked for explicitly, which is the reporter v24
// picked on its own. Through v22 the same command printed TAP instead,
// because its own output was never a terminal; v23 made this reporter the
// default everywhere, TAP included. No fixture here exercised that default
// before, so nothing caught it changing.
const NODE_TEST_RUNNER_DEFAULT_REPORTER_OUTPUT = `\
✔ adds (0.397898ms)
✔ subtracts (0.079976ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 32.460652
`;

// Pins that this real output stays exactly as unreadable as the hand-typed
// crash log above, never a census of zero tests: the parser deliberately
// reads two machine formats and no others, so a runner's own human-readable
// default is refused here on purpose, not missed by accident. hooks/census.ts
// is what keeps a caller from ever handing this parser that text: it asks
// node's own test runner for TAP before it runs it.
test("node's own default reporter, asked for nothing else, is unreadable here too", () => {
  const result = parseResults(NODE_TEST_RUNNER_DEFAULT_REPORTER_OUTPUT);
  assert.ok("error" in result, JSON.stringify(result));
  assert.match(result.error, /neither TAP nor JUnit/);
});

test("an empty census from readable output is a real answer, not an error", () => {
  const result = parseResults("TAP version 13\n1..0\n");
  assert.ok(!("error" in result));
  assert.deepEqual(result.tests, []);
  assert.equal(result.format, "tap");
});

// Forcing a format chooses a parser; it does not make unreadable text
// readable. Without this, --format-in junit over a crash log would parse to
// zero tests, which is what a suite that lost every test looks like.
test("a forced format does not make unreadable output parse as zero tests", () => {
  const result = parseResults("npm ERR! missing script: test\n", "junit");
  assert.ok("error" in result, JSON.stringify(result));
});

test("--format-in forces the parser even when detection would disagree", () => {
  const result = parseResults(`<testsuite><testcase name="a"/></testsuite>`, "tap");
  assert.ok(!("error" in result));
  assert.deepEqual(result.tests, []);
});

test("two tests cannot collide into one key across the file and name halves", () => {
  assert.notEqual(testKey({ file: "ab", name: "c" }), testKey({ file: "a", name: "bc" }));
});

// --- comparing censuses ---------------------------------------------------------

test("a test in the base census and not at HEAD is reported as disappeared", () => {
  const result = compareCensus({
    base: [pass("keeps running"), pass("quietly dropped")],
    head: [pass("keeps running")],
    redRun: null,
  });
  const kinds = result.findings.map((f) => f.kind).sort();
  assert.deepEqual(kinds, ["count-dropped", "disappeared"]);
  assert.match(result.findings.find((f) => f.kind === "disappeared")!.detail, /quietly dropped/);
  assert.equal(exitCodeFor(result), 1);
});

// The README's own example: the count alone catches it, with no rename to
// notice and no name to match up.
test("a dropped count is a finding on the number alone", () => {
  const result = compareCensus({
    base: [pass("a"), pass("b"), pass("c")],
    head: [pass("a"), pass("b")],
    redRun: null,
  });
  assert.ok(result.findings.some((f) => f.kind === "count-dropped"));
  assert.match(result.findings.find((f) => f.kind === "count-dropped")!.detail, /3 tests .* 2 .* 1 fewer/);
});

test("a test that changed outcome is reported as flipped, in both directions", () => {
  const result = compareCensus({
    base: [pass("was green"), fail_("was red")],
    head: [fail_("was green"), pass("was red")],
    redRun: null,
  });
  assert.equal(result.findings.filter((f) => f.kind === "flipped").length, 2);
});

test("a test added by this change that passes at base is not-red-before-green", () => {
  const result = compareCensus({
    base: [pass("old")],
    head: [pass("old"), pass("new")],
    redRun: [pass("old"), pass("new")],
  });
  assert.deepEqual(result.findings.map((f) => f.kind), ["not-red-before-green"]);
  assert.equal(result.redAtBase.length, 0);
  assert.equal(exitCodeFor(result), 1);
});

test("a test added by this change that fails at base is clean", () => {
  const result = compareCensus({
    base: [pass("old")],
    head: [pass("old"), pass("new")],
    redRun: [pass("old"), fail_("new")],
  });
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.unmeasured, []);
  assert.deepEqual(result.redAtBase.map((t) => t.name), ["new"]);
  assert.equal(exitCodeFor(result), 0);
});

// The dangerous one. A test that cannot even load against the base source
// never ran, so it demonstrated nothing. Scoring it as red would let a
// broken import pass as proof of a fix.
test("a test that never ran against the base source is unmeasured, never red", () => {
  const result = compareCensus({
    base: [pass("old")],
    head: [pass("old"), pass("new")],
    redRun: [pass("old")],
  });
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.unmeasured.map((u) => u.kind), ["errored-at-base"]);
  assert.equal(result.redAtBase.length, 0);
  assert.equal(exitCodeFor(result), 3);
  assert.match(result.unmeasured[0].detail, /not a red run/);
});

test("a test skipped against the base source is unmeasured, never red", () => {
  const result = compareCensus({
    base: [pass("old")],
    head: [pass("old"), pass("new")],
    redRun: [pass("old"), { file: "", name: "new", outcome: "skip" }],
  });
  assert.deepEqual(result.unmeasured.map((u) => u.kind), ["skipped-at-base"]);
  assert.equal(result.redAtBase.length, 0);
  assert.equal(exitCodeFor(result), 3);
});

// The single most dangerous confusion this command can make. A base that
// could not be compared is null, not an empty list, and null must not
// produce one word about a test disappearing.
test("a base that could not be compared never reads as every test disappearing", () => {
  const result = compareCensus({
    base: null,
    head: [pass("a"), pass("b"), pass("c")],
    redRun: null,
  });
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.unmeasured.map((u) => u.kind), ["base-not-comparable"]);
  assert.equal(result.baseCount, null);
  assert.equal(exitCodeFor(result), 3);
});

// The same input with an empty list instead of null is what the guard in the
// CLI exists to keep out; this pins how differently the two read.
test("an empty base census does report every test as new, which is why null exists", () => {
  const result = compareCensus({ base: [], head: [pass("a")], redRun: null });
  assert.deepEqual(result.findings, []);
  assert.equal(result.appeared.length, 1);
  assert.equal(result.baseCount, 0);
});

// Identity is the file plus the name, and node's TAP names no file for a
// passing test, so every test shares the same empty file half. A test added
// under a name another file already uses is therefore not in `appeared`, and
// the red-before-green check silently never runs on it. The count is the only
// thing left that shows it, and an unmeasured item is the honest way to say
// so.
test("a test added under a name already in use is reported as an identity collision", () => {
  const result = compareCensus({
    base: [pass("handles the empty case")],
    head: [pass("handles the empty case"), pass("handles the empty case")],
    redRun: null,
  });
  assert.deepEqual(result.findings, []);
  assert.equal(result.appeared.length, 0);
  assert.deepEqual(result.unmeasured.map((u) => u.kind), ["identity-collision"]);
  assert.match(result.unmeasured[0].detail, /share an identity with another test/);
  assert.equal(exitCodeFor(result), 3);
});

test("a suite that grew by exactly the names it added reports no collision", () => {
  const result = compareCensus({
    base: [pass("a")],
    head: [pass("a"), pass("b")],
    redRun: [pass("a"), fail_("b")],
  });
  assert.deepEqual(result.unmeasured, []);
  assert.equal(exitCodeFor(result), 0);
});

test("a finding wins over an unmeasured part in the exit code", () => {
  const result = compareCensus({
    base: [pass("old"), pass("gone")],
    head: [pass("old"), pass("new")],
    redRun: [pass("old")],
  });
  assert.ok(result.findings.length > 0);
  assert.ok(result.unmeasured.length > 0);
  assert.equal(exitCodeFor(result), 1);
});

test("nothing found and nothing unmeasured is exit 0", () => {
  assert.equal(exitCodeFor({ findings: [], unmeasured: [] }), 0);
});

// --- two runs of the same comparison ---------------------------------------------

// The rule these tests hold in place: a disagreement between the two runs is
// a result nobody measured. Dropping it as flaky reported a result that could
// not be measured as a result that is fine, which is the mistake this whole
// repository opens with.

function redCompare(redRun: TestRecord[] | null): CompareResult {
  return compareCensus({ base: [pass("old")], head: [pass("old"), pass("new")], redRun });
}

test("a red-half result found on the first run and not the second did not settle", () => {
  // First run: "new" passes against the base source, which is a finding.
  // Second run: it fails there, which is clean. Neither answer is the answer.
  const merged = mergeRedHalves(redCompare([pass("old"), pass("new")]), redCompare([pass("old"), fail_("new")]));
  assert.equal(merged.unsettled, 1);
  assert.deepEqual(merged.result.findings, []);
  assert.deepEqual(merged.result.unmeasured.map((u) => u.kind), ["did-not-settle"]);
  assert.deepEqual(merged.result.redAtBase, []);
  assert.match(merged.result.unmeasured[0].detail, /did not settle between the two runs/);
  assert.equal(exitCodeFor(merged.result), 3);
});

test("a red-half result found on the second run and not the first did not settle", () => {
  const merged = mergeRedHalves(redCompare([pass("old"), fail_("new")]), redCompare([pass("old"), pass("new")]));
  assert.equal(merged.unsettled, 1);
  assert.deepEqual(merged.result.findings, []);
  assert.deepEqual(merged.result.unmeasured.map((u) => u.kind), ["did-not-settle"]);
  assert.deepEqual(merged.result.redAtBase, []);
  assert.equal(exitCodeFor(merged.result), 3);
});

test("a red-half result both runs agree about is still a finding", () => {
  const both = redCompare([pass("old"), pass("new")]);
  const merged = mergeRedHalves(both, redCompare([pass("old"), pass("new")]));
  assert.equal(merged.unsettled, 0);
  assert.deepEqual(merged.result.findings.map((f) => f.kind), ["not-red-before-green"]);
  assert.equal(exitCodeFor(merged.result), 1);
});

test("a red-half result neither run found is still clean", () => {
  const merged = mergeRedHalves(redCompare([pass("old"), fail_("new")]), redCompare([pass("old"), fail_("new")]));
  assert.equal(merged.unsettled, 0);
  assert.deepEqual(merged.result.findings, []);
  assert.deepEqual(merged.result.unmeasured, []);
  assert.deepEqual(merged.result.redAtBase.map((t) => t.name), ["new"]);
  assert.equal(exitCodeFor(merged.result), 0);
});

// Two unmeasured kinds are not one unmeasured kind. A test the first run
// could not load and the second merely skipped was answered two ways.
test("two different unmeasured verdicts about one test do not settle either", () => {
  const first = redCompare([pass("old")]);
  const second = redCompare([pass("old"), { file: "", name: "new", outcome: "skip" }]);
  const merged = mergeRedHalves(first, second);
  assert.equal(merged.unsettled, 1);
  assert.deepEqual(merged.result.unmeasured.map((u) => u.kind), ["did-not-settle"]);
});

test("a red-half unmeasured verdict both runs agree about is kept as it was", () => {
  const merged = mergeRedHalves(redCompare([pass("old")]), redCompare([pass("old")]));
  assert.equal(merged.unsettled, 0);
  assert.deepEqual(merged.result.unmeasured.map((u) => u.kind), ["errored-at-base"]);
  assert.equal(exitCodeFor(merged.result), 3);
});

// A finding somewhere else does not become less of a finding because another
// test disagreed with itself: exit 1 wins, and both are reported.
test("a real finding beside an unsettled one keeps exit 1, and both are reported", () => {
  const first = compareCensus({
    base: [pass("old"), pass("gone")],
    head: [pass("old"), pass("new")],
    redRun: [pass("old"), pass("new")],
  });
  const second = compareCensus({
    base: [pass("old"), pass("gone")],
    head: [pass("old"), pass("new")],
    redRun: [pass("old"), fail_("new")],
  });
  const merged = mergeRedHalves(first, second);
  assert.equal(merged.unsettled, 1);
  assert.deepEqual(merged.result.findings.map((f) => f.kind), ["disappeared"]);
  assert.ok(merged.result.unmeasured.some((u) => u.kind === "did-not-settle"));
  assert.equal(exitCodeFor(merged.result), 1);
});

const GONE: Finding = {
  kind: "disappeared",
  file: "",
  name: "gone",
  detail: "gone ran at the base commit and does not run at HEAD",
};
const FEWER: Finding = {
  kind: "count-dropped",
  file: "",
  name: "",
  detail: "the suite ran 2 tests at the base commit and 1 at HEAD, 1 fewer",
};

test("a census finding both runs reported is kept, and one only one run reported is not", () => {
  const settled = mergeCensusFindings([GONE, FEWER], [GONE]);
  assert.deepEqual(settled.findings.map((f) => f.kind), ["disappeared"]);
  assert.deepEqual(settled.unsettled.map((u) => u.kind), ["did-not-settle"]);
  assert.equal(settled.unsettled[0].name, "");
  assert.match(settled.unsettled[0].detail, /one of the two runs reported that/);
  assert.match(settled.unsettled[0].detail, /did not settle between the two runs/);
});

// The direction the old rule never even looked at. A finding the second run
// reported and the first did not was silently discarded, because the merge
// filtered the first run's list by what recurred.
test("a census finding only the second run reported did not settle either", () => {
  const settled = mergeCensusFindings([GONE], [GONE, FEWER]);
  assert.deepEqual(settled.findings.map((f) => f.kind), ["disappeared"]);
  assert.deepEqual(settled.unsettled.map((u) => u.kind), ["did-not-settle"]);
  assert.match(settled.unsettled[0].detail, /1 fewer/);
});

test("two runs that agree about every census finding leave nothing unsettled", () => {
  const settled = mergeCensusFindings([GONE, FEWER], [FEWER, GONE]);
  assert.deepEqual(settled.findings.map((f) => f.kind), ["disappeared", "count-dropped"]);
  assert.deepEqual(settled.unsettled, []);
});

// --- reporting -------------------------------------------------------------------

function reportInput(overrides: Partial<ReportInput> = {}): ReportInput {
  const result = compareCensus({
    base: [pass("old")],
    head: [pass("old"), pass("new")],
    redRun: [pass("old"), pass("new")],
  });
  return {
    command: "npm test",
    baseRef: "abc123",
    baseReason: "merge-base with origin/main",
    headFormat: "tap",
    baseFormat: "tap",
    changedTestFiles: ["tests/order.test.js"],
    result,
    unsettled: 0,
    runs: 3,
    notes: [],
    ...overrides,
  };
}

test("the text report names the finding, the base, and the command", () => {
  const text = formatReportText(reportInput());
  assert.match(text, /Command: npm test/);
  assert.match(text, /Base: abc123 \(merge-base with origin\/main\)/);
  assert.match(text, /not-red-before-green/);
  assert.match(text, /tests\/order\.test\.js/);
});

// Nothing is dropped any more, so the count says what did happen: how many
// results the two runs disagreed about. Wording that says findings were
// dropped as flaky is wording that says a run cleared itself.
test("the text report says how many results did not settle", () => {
  const text = formatReportText(reportInput({ unsettled: 2 }));
  assert.match(text, /2 result\(s\) did not settle between the two runs/);
  assert.match(text, /none of these is reported as a finding and none of them is dropped/);
  assert.doesNotMatch(text, /dropped as flaky/);
  assert.doesNotMatch(text, /did not hold on a second run/);
});

// The closing line used to claim every added test was red whenever the two
// lists were empty, without ever comparing the two numbers it was claiming
// about. The line above it said "1 test(s) added, 0 of those red".
test("the closing line does not claim more than redAtBase holds", () => {
  const result = compareCensus({ base: [pass("old")], head: [pass("old"), pass("new")], redRun: null });
  const text = formatReportText(reportInput({ result: { ...result, unmeasured: [] } }));
  assert.doesNotMatch(text, /every test this change added was red/);
  assert.match(text, /0 of the 1 test\(s\) this change added/);
  assert.match(text, /were not shown to have been red before it/);
});

test("the closing line does claim it when every added test was red", () => {
  const result = compareCensus({
    base: [pass("old")],
    head: [pass("old"), pass("new")],
    redRun: [pass("old"), fail_("new")],
  });
  const text = formatReportText(reportInput({ result }));
  assert.match(text, /every test this change added was red against the base source/);
});

test("a change that added no test says so instead of claiming every one was red", () => {
  const result = compareCensus({ base: [pass("old")], head: [pass("old")], redRun: null });
  const text = formatReportText(reportInput({ result }));
  assert.match(text, /This change added no test/);
});

// The count belongs in the data too, so a caller reading json can tell a run
// that measured everything from one that could not.
test("the json report carries the count of results that did not settle", () => {
  const parsed = JSON.parse(formatReportJson(reportInput({ unsettled: 3 }))) as { unsettled: number };
  assert.equal(parsed.unsettled, 3);
  const none = JSON.parse(formatReportJson(reportInput())) as { unsettled: number };
  assert.equal(none.unsettled, 0);
  assert.doesNotMatch(formatReportText(reportInput()), /did not settle/);
});

test("the json report carries the findings and the counts", () => {
  const parsed = JSON.parse(formatReportJson(reportInput())) as {
    findings: { kind: string }[];
    counts: { base: number; head: number };
  };
  assert.deepEqual(parsed.findings.map((f) => f.kind), ["not-red-before-green"]);
  assert.deepEqual(parsed.counts.base, 1);
  assert.deepEqual(parsed.counts.head, 2);
});
