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
  parseJUnit,
  parseResults,
  parseTap,
  testKey,
  type ReportInput,
  type TestRecord,
} from "../src/census.ts";

function pass(name: string, file = ""): TestRecord {
  return { file, name, outcome: "pass" };
}
function fail_(name: string, file = ""): TestRecord {
  return { file, name, outcome: "fail" };
}

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
      <skipped type="pytest.skip" message="not today"/>
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
    flakesDropped: 0,
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

test("the text report says how many disagreements were dropped as flaky", () => {
  const text = formatReportText(reportInput({ flakesDropped: 2 }));
  assert.match(text, /2 finding\(s\) did not hold on a second run/);
  assert.match(text, /truly flaky still produces noise/);
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
