// Tests for src/test-diff-separator.ts, the pure core. Every test asserts
// an observable outcome from separateTestDiff: a signal id, a count, or a
// file's classification. Never an internal value.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyTestPath,
  compileRuleSet,
  DEFAULT_RULES,
  isTestPath,
  separateTestDiff,
  type RuleSet,
  type Signal,
} from "../src/test-diff-separator.ts";

function signalIds(signals: Signal[]): string[] {
  return signals.map((s) => s.id).sort();
}

/** Builds a minimal single-file unified diff, git style, from added/removed line bodies. */
function oneFileDiff(path: string, removed: string[], added: string[]): string {
  const hunk = [
    `diff --git a/${path} b/${path}`,
    `index 1111111..2222222 100644`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${removed.length} +1,${added.length} @@`,
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
  ];
  return hunk.join("\n") + "\n";
}

// --- File classification -----------------------------------------------------

test("a segment named test/tests/__tests__/spec classifies a file as a test, case insensitive", () => {
  assert.equal(isTestPath("tests/foo.ts"), true);
  assert.equal(isTestPath("Test/foo.ts"), true);
  assert.equal(isTestPath("__tests__/foo.ts"), true);
  assert.equal(isTestPath("spec/foo.rb"), true);
  assert.equal(isTestPath("src/tests_helpers/foo.ts"), false); // segment must equal "tests", not contain it
});

test("a basename matching *.test.*, *.spec.*, *_test.*, or test_* classifies a file as a test", () => {
  assert.equal(isTestPath("src/foo.test.ts"), true);
  assert.equal(isTestPath("src/foo.spec.ts"), true);
  assert.equal(isTestPath("src/foo_test.py"), true);
  assert.equal(isTestPath("src/test_foo.py"), true);
  // Path rules are matched case sensitively on purpose. Matching without
  // case turned Contest.java and Latest.java into test files, and case is the
  // only thing that separates those from WidgetTest.java.
  assert.equal(isTestPath("SRC/Foo.TEST.TS"), false);
});

test("a capital T is what separates a test class from an ordinary word", () => {
  for (const p of ["WidgetTest.java", "FooTests.cs", "WidgetTest.php", "FooTests.swift"]) {
    assert.equal(isTestPath(p), true, `${p} should be a test`);
  }
  for (const p of ["Contest.java", "Latest.java", "contest.php", "latest.ts", "protest.rb"]) {
    assert.equal(isTestPath(p), false, `${p} should be source`);
  }
});

test("capitalised test folders are recognised, as Swift and C# name them", () => {
  assert.equal(isTestPath("Tests/WidgetTests.swift"), true);
  assert.equal(isTestPath("Spec/FooSpec.cs"), true);
});

// classifyTestPath compiled its own regex separately from the matcher the
// separator runs, so the two disagreed the moment one of them changed: the
// classifier called Contest.java a test while the separator called it source.
test("classifyTestPath and isTestPath never disagree", () => {
  const paths = [
    "WidgetTest.java", "Contest.java", "latest.ts", "tests/a.test.ts",
    "widget_test.go", "spec/widget_spec.rb", "src/widget.ts",
    "Tests/WidgetTests.swift", "conftest.py", "src/test/java/a/WidgetTest.java",
  ];
  for (const p of paths) {
    assert.equal(classifyTestPath(p).isTest, isTestPath(p), `disagreement on ${p}`);
  }
});

test("an ordinary source path classifies as source", () => {
  assert.equal(isTestPath("src/widget.ts"), false);
  assert.equal(isTestPath("src/contest.ts"), false); // "test" inside a longer basename, not a naming rule
});

test("an extra pattern marks a file as a test in addition to the defaults", () => {
  assert.equal(isTestPath("e2e/checkout.flow.ts", [/\.flow\.ts$/]), true);
  assert.equal(isTestPath("e2e/checkout.flow.ts"), false);
});

// --- Splitting source from test files -----------------------------------------

test("a diff touching both a source and a test file splits into both sections with correct counts", () => {
  const diff =
    oneFileDiff("src/widget.ts", ["return a + b;"], ["return a - b;"]) +
    oneFileDiff("tests/widget.test.ts", ["expect(x).toBe(3);"], ["expect(x).toBe(3);", "// noop"]);
  const result = separateTestDiff(diff);
  assert.deepEqual(
    result.sourceFiles.map((f) => f.path),
    ["src/widget.ts"],
  );
  assert.deepEqual(
    result.testFiles.map((f) => f.path),
    ["tests/widget.test.ts"],
  );
  assert.equal(result.sourceFiles[0].added, 1);
  assert.equal(result.sourceFiles[0].removed, 1);
  assert.equal(result.testFiles[0].added, 2);
  assert.equal(result.testFiles[0].removed, 1);
});

test("a source file with an assertion-looking line produces no signal; signals come from test files only", () => {
  const diff = oneFileDiff("src/widget.ts", ["assert(x > 0);"], []);
  const result = separateTestDiff(diff);
  assert.deepEqual(result.signals, []);
});

// --- assertion-removed ---------------------------------------------------------

test("a deleted assertion with nothing added in its place fires assertion-removed", () => {
  const diff = oneFileDiff("tests/widget.test.ts", ["expect(sum(1, 2)).toBe(3);"], []);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["assertion-removed"]);
});

test("a rewritten assertion, one removed and one added, does not fire assertion-removed", () => {
  const diff = oneFileDiff(
    "tests/widget.test.ts",
    ["expect(sum(1, 2)).toBe(3);"],
    ["expect(sum(1, 2)).toBe(3); // clarified"],
  );
  const result = separateTestDiff(diff);
  assert.deepEqual(result.signals, []);
});

test("assert_equal and self.assertTrue are recognised as assertions through the assert prefix", () => {
  const diff = oneFileDiff("tests/test_widget.py", ["assert_equal(3, sum(1, 2))", "self.assertTrue(ok)"], []);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["assertion-removed", "assertion-removed"]);
});

// --- test-case-removed -----------------------------------------------------------

test("a deleted test( case with nothing added fires test-case-removed", () => {
  const diff = oneFileDiff("tests/widget.test.ts", ["test('adds', () => { doAdd(); });"], []);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["test-case-removed"]);
});

test("a deleted def test_ case fires test-case-removed", () => {
  const diff = oneFileDiff("tests/test_widget.py", ["def test_adds():"], []);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["test-case-removed"]);
});

test("a renamed test case, one removed and one added, does not fire test-case-removed", () => {
  const diff = oneFileDiff("tests/widget.test.ts", ["it('adds numbers', () => {"], ["it('adds two numbers', () => {"]);
  const result = separateTestDiff(diff);
  assert.deepEqual(result.signals, []);
});

// --- skip-added --------------------------------------------------------------

test("an added .skip fires skip-added", () => {
  // Added on its own, with nothing matching removed, so this isolates
  // skip-added from test-case-removed (which "it.skip(" does not match,
  // since it does not contain the literal "it(" token).
  const diff = oneFileDiff("tests/widget.test.ts", [], ["it.skip('adds', () => { doAdd(); });"]);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

test("an added .only fires skip-added, since narrowing to one test hides the rest", () => {
  const diff = oneFileDiff("tests/widget.test.ts", [], ["it.only('adds', () => { doAdd(); });"]);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

test("an added @pytest.mark.skip fires skip-added", () => {
  const diff = oneFileDiff("tests/test_widget.py", [], ["@pytest.mark.skip", "def test_adds():"]);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

test("an ordinary added line with no skip wording does not fire skip-added", () => {
  const diff = oneFileDiff("tests/widget.test.ts", [], ["it('adds', () => { expect(1).toBe(1); });"]);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), []);
});

// --- tolerance-widened ---------------------------------------------------------

test("a changed tolerance line, one removed and one added, fires tolerance-widened", () => {
  const diff = oneFileDiff("tests/widget.test.ts", ["assert.closeTo(x, 3, 0.001);"], ["assert.closeTo(x, 3, 0.5);"]);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["tolerance-widened"]);
});

test("a tolerance line present only as an addition with nothing removed does not fire tolerance-widened", () => {
  const diff = oneFileDiff("tests/widget.test.ts", [], ["assert.closeTo(x, 3, 0.5);"]);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), []);
});

// --- timeout-raised --------------------------------------------------------------

test("a changed timeout line, one removed and one added, fires timeout-raised", () => {
  const diff = oneFileDiff("tests/widget.test.ts", ["}, { timeout: 1000 });"], ["}, { timeout: 30000 });"]);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["timeout-raised"]);
});

test("a timeout line present only as an addition with nothing removed does not fire timeout-raised", () => {
  const diff = oneFileDiff("tests/widget.test.ts", [], ["}, { timeout: 30000 });"]);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), []);
});

// --- Parsing: renames, new/deleted files, binary, empty, headers, counts ---------

test("a rename is classified by its new path", () => {
  const diff = [
    "diff --git a/tests/old_name.test.ts b/tests/new_name.test.ts",
    "similarity index 100%",
    "rename from tests/old_name.test.ts",
    "rename to tests/new_name.test.ts",
    "",
  ].join("\n");
  const result = separateTestDiff(diff);
  assert.deepEqual(
    result.testFiles.map((f) => f.path),
    ["tests/new_name.test.ts"],
  );
});

test("a new test file is classified as a test with its added lines counted", () => {
  const diff = [
    "diff --git a/tests/new.test.ts b/tests/new.test.ts",
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    "+++ b/tests/new.test.ts",
    "@@ -0,0 +1,2 @@",
    "+it('works', () => {",
    "+});",
    "",
  ].join("\n");
  const result = separateTestDiff(diff);
  assert.deepEqual(
    result.testFiles.map((f) => f.path),
    ["tests/new.test.ts"],
  );
  assert.equal(result.testFiles[0].added, 2);
  assert.equal(result.testFiles[0].removed, 0);
});

test("a deleted test file is classified as a test with its removed lines counted", () => {
  const diff = [
    "diff --git a/tests/gone.test.ts b/tests/gone.test.ts",
    "deleted file mode 100644",
    "index 1111111..0000000",
    "--- a/tests/gone.test.ts",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-it('works', () => {",
    "-});",
    "",
  ].join("\n");
  const result = separateTestDiff(diff);
  assert.equal(result.testFiles[0].added, 0);
  assert.equal(result.testFiles[0].removed, 2);
});

test("a binary file section is classified and counted with zero changed lines, no crash", () => {
  const diff = [
    "diff --git a/tests/fixture.png b/tests/fixture.png",
    "index 1111111..2222222 100644",
    "Binary files a/tests/fixture.png and b/tests/fixture.png differ",
    "",
  ].join("\n");
  const result = separateTestDiff(diff);
  assert.deepEqual(
    result.testFiles.map((f) => f.path),
    ["tests/fixture.png"],
  );
  assert.equal(result.testFiles[0].added, 0);
  assert.equal(result.testFiles[0].removed, 0);
});

test("an empty diff produces no files and no signals", () => {
  const result = separateTestDiff("");
  assert.deepEqual(result.sourceFiles, []);
  assert.deepEqual(result.testFiles, []);
  assert.deepEqual(result.signals, []);
});

test("a +++/--- header line is never counted as an added or removed line", () => {
  const diff = oneFileDiff("tests/widget.test.ts", ["it('adds', () => {"], ["it('adds', () => {", "// comment"]);
  const result = separateTestDiff(diff);
  // 1 removed, 2 added: if the "--- a/x" / "+++ b/x" header lines were
  // miscounted as changed lines, these numbers would be off by one each.
  assert.equal(result.testFiles[0].removed, 1);
  assert.equal(result.testFiles[0].added, 2);
});

test("counts add up correctly across several files", () => {
  const diff =
    oneFileDiff("src/a.ts", ["x"], ["y", "z"]) +
    oneFileDiff("src/b.ts", ["p", "q"], []) +
    oneFileDiff("tests/a.test.ts", [], ["it('x', () => {});"]);
  const result = separateTestDiff(diff);
  assert.equal(result.sourceAdded, 2);
  assert.equal(result.sourceRemoved, 3);
  assert.equal(result.testAdded, 1);
  assert.equal(result.testRemoved, 0);
  assert.equal(result.sourceFiles.length, 2);
  assert.equal(result.testFiles.length, 1);
});

test("CRLF line endings in the diff text parse the same as LF", () => {
  const diff = oneFileDiff("tests/widget.test.ts", ["expect(1).toBe(1);"], []).replace(/\n/g, "\r\n");
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["assertion-removed"]);
});

test("a diff with no trailing newline still parses its last line", () => {
  const diff = oneFileDiff("tests/widget.test.ts", ["expect(1).toBe(1);"], []).replace(/\n$/, "");
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["assertion-removed"]);
});

// --- The realistic fixture: the scenario this whole hook exists for -------------

test("the fixture: an agent 'fixes' a bug by deleting two assertions and adding .skip to one test, alongside a source change", () => {
  const diff = [
    "diff --git a/src/calculator.ts b/src/calculator.ts",
    "index 1111111..2222222 100644",
    "--- a/src/calculator.ts",
    "+++ b/src/calculator.ts",
    "@@ -3,3 +3,3 @@",
    "-  return a + b;",
    "+  return a + b; // unrelated tweak, bug not actually fixed",
    "diff --git a/tests/calculator.test.ts b/tests/calculator.test.ts",
    "index 3333333..4444444 100644",
    "--- a/tests/calculator.test.ts",
    "+++ b/tests/calculator.test.ts",
    "@@ -1,10 +1,8 @@",
    " describe('calculator', () => {",
    "   it('adds two positive numbers', () => {",
    "-    expect(add(2, 3)).toBe(5);",
    "-    expect(typeof add(2, 3)).toBe('number');",
    "   });",
    "",
    "-  it('adds two negative numbers', () => {",
    "+  it.skip('adds two negative numbers', () => {",
    "     expect(add(-2, -3)).toBe(-5);",
    "   });",
    " });",
    "",
  ].join("\n");

  const result = separateTestDiff(diff);

  assert.deepEqual(
    result.sourceFiles.map((f) => f.path),
    ["src/calculator.ts"],
  );
  assert.deepEqual(
    result.testFiles.map((f) => f.path),
    ["tests/calculator.test.ts"],
  );

  // Two assertions deleted with nothing added in their place: assertion-removed.
  // The .skip line replaces the plain "it(" opening line, so that line's
  // "it(" token also nets removed: test-case-removed fires alongside
  // skip-added. Both together are the correct, conservative read: an agent
  // that disables a test by rewriting its opening line should trip both.
  assert.deepEqual(signalIds(result.signals), [
    "assertion-removed",
    "assertion-removed",
    "skip-added",
    "test-case-removed",
  ]);
  assert.equal(result.signals.filter((s) => s.id === "assertion-removed").length, 2);
  assert.equal(result.signals.filter((s) => s.id === "test-case-removed").length, 1);
  assert.equal(result.signals.filter((s) => s.id === "skip-added").length, 1);
  assert.equal(result.sourceFiles[0].removed, 1);
  assert.equal(result.sourceFiles[0].added, 1);
});

// The net rule works per file. Merging every test file into one before
// counting would let an addition in one file cancel a deletion in another,
// and that change used to pass the whole suite untouched.
test("a deletion in one test file is not cancelled by an addition in another", () => {
  const diff = [
    "diff --git a/tests/a.test.js b/tests/a.test.js",
    "--- a/tests/a.test.js",
    "+++ b/tests/a.test.js",
    "@@ -1,3 +1,2 @@",
    "-  assert.equal(x, 1);",
    "diff --git a/tests/b.test.js b/tests/b.test.js",
    "--- a/tests/b.test.js",
    "+++ b/tests/b.test.js",
    "@@ -1,2 +1,3 @@",
    "+  assert.equal(y, 2);",
    "+  assert.equal(z, 3);",
    "",
  ].join("\n");
  const result = separateTestDiff(diff);
  assert.ok(signalIds(result.signals).includes("assertion-removed"));
});

// An assertion swapped for a weaker one keeps the line count the same, so the
// net rule cannot see it. These are the cheats the tool exists to catch.
const WEAKENINGS: Array<[string, string]> = [
  ["  assert.equal(x, 5);", "  assert.ok(x);"],
  ["  self.assertEqual(x, 5)", "  self.assertTrue(x)"],
  ["  assert.strictEqual(a, b);", "  assert.equal(a, b);"],
  ["  expect(total).toBe(100);", "  expect(total).toBeTruthy();"],
];
for (const [before, after] of WEAKENINGS) {
  test(`assertion-weakened fires when ${before.trim()} becomes ${after.trim()}`, () => {
    const result = separateTestDiff(oneFileDiff("tests/q.test.js", [before], [after]));
    assert.ok(signalIds(result.signals).includes("assertion-weakened"));
  });
}

test("assertion-weakened fires when the expected value changes and the call does not", () => {
  const result = separateTestDiff(
    oneFileDiff("tests/q.test.js", ["  assert.equal(total, 100);"], ["  assert.equal(total, 0);"]),
  );
  assert.ok(signalIds(result.signals).includes("assertion-weakened"));
});

test("assertion-weakened stays quiet when an assertion is only reformatted", () => {
  const result = separateTestDiff(
    oneFileDiff("tests/q.test.js", ["  assert.equal(total, 100);"], ["  assert.equal(total, 100);"]),
  );
  assert.deepEqual(signalIds(result.signals), []);
});

// A commented-out assertion is gone from the run. Counting the comment as an
// addition made the deletion read as a rewrite.
test("an assertion commented out fires assertion-removed", () => {
  const result = separateTestDiff(
    oneFileDiff("tests/q.test.js", ["  expect(x).toBe(1);"], ["  // expect(x).toBe(1);"]),
  );
  assert.ok(signalIds(result.signals).includes("assertion-removed"));
});

test("a comment-only edit mentioning an assertion fires nothing", () => {
  const result = separateTestDiff(
    oneFileDiff("tests/q.test.js", ["  // TODO: assert this works"], ["  // done"]),
  );
  assert.deepEqual(signalIds(result.signals), []);
});

test("a comment naming it.only does not fire skip-added", () => {
  const result = separateTestDiff(
    oneFileDiff("tests/q.test.js", [], ["  // avoid using it.only() in CI"]),
  );
  assert.deepEqual(signalIds(result.signals), []);
});

// Go's stdlib assertions carry none of the words the pattern looked for.
test("a removed Go t.Errorf fires assertion-removed", () => {
  const result = separateTestDiff(
    oneFileDiff("queue_test.go", ['\tif got != want { t.Errorf("got %d", got) }'], []),
  );
  assert.ok(signalIds(result.signals).includes("assertion-removed"));
});

// Go testify's require. package-call assertions carry none of the standard
// library's words either, and "require." alone (without the "!" the older
// rule expected) would not have matched before this rule was added.
test("a removed Go testify require.NoError fires assertion-removed", () => {
  const result = separateTestDiff(
    oneFileDiff("queue_test.go", ["\trequire.NoError(t, err)"], []),
  );
  assert.ok(signalIds(result.signals).includes("assertion-removed"));
});

// RSpec and Elixir's string-form opener has no parentheses at all, so the
// existing test(/it( rules do not reach it.
test("a deleted RSpec-style it \"...\" do case, with nothing added, fires test-case-removed", () => {
  const diff = oneFileDiff("spec/widget_spec.rb", ['it "adds numbers" do'], []);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["test-case-removed"]);
});

// Node's require.resolve/.cache write "require." the same way but with a
// function name the testify rule's whitelist does not include.
test("Node's require.resolve is not read as a testify assertion", () => {
  const result = separateTestDiff(
    oneFileDiff("tests/widget.test.js", ["const p = require.resolve('./widget');"], []),
  );
  assert.deepEqual(result.signals, []);
});

// Renaming a test out of the naming rules takes it out of the run, and it
// stops being classified as a test at the same moment.
test("a test renamed out of the naming rules fires test-file-declassified", () => {
  const diff = [
    "diff --git a/lib/queue.test.js b/lib/queue.js.bak",
    "similarity index 90%",
    "rename from lib/queue.test.js",
    "rename to lib/queue.js.bak",
    "--- a/lib/queue.test.js",
    "+++ b/lib/queue.js.bak",
    "@@ -1,3 +1,1 @@",
    "-  expect(x).toBe(1);",
    "",
  ].join("\n");
  const result = separateTestDiff(diff);
  assert.ok(signalIds(result.signals).includes("test-file-declassified"));
});

test("a rename that stays a test does not fire test-file-declassified", () => {
  const diff = [
    "diff --git a/tests/queue.test.js b/tests/queue-drain.test.js",
    "similarity index 98%",
    "rename from tests/queue.test.js",
    "rename to tests/queue-drain.test.js",
    "",
  ].join("\n");
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), []);
});

// Severity is part of what a signal reports. Nothing asserted it, so a signal
// could be quietly downgraded and every test would still pass.
test("skip-added reports high severity", () => {
  const result = separateTestDiff(oneFileDiff("tests/q.test.js", [], ["  it.only('a', () => {"]));
  const skip = result.signals.find((s) => s.id === "skip-added");
  assert.equal(skip?.severity, "high");
});

test("tolerance-widened reports medium severity", () => {
  const result = separateTestDiff(
    oneFileDiff("tests/q.test.js", ["  assert.closeTo(x, 3, 0.001);"], ["  assert.closeTo(x, 3, 0.5);"]),
  );
  const tol = result.signals.find((s) => s.id === "tolerance-widened");
  assert.equal(tol?.severity, "medium");
});

// One dropped alternative in a pattern is a whole family of assertions the
// tool stops seeing, and every other test keeps passing.
test("a removed should-style assertion fires assertion-removed", () => {
  const result = separateTestDiff(oneFileDiff("tests/q.test.js", ["  result.should.equal(42);"], []));
  assert.ok(signalIds(result.signals).includes("assertion-removed"));
});

test("a changed epsilon fires tolerance-widened", () => {
  const result = separateTestDiff(
    oneFileDiff("tests/q.test.js", ["  compare(a, b, epsilon = 0.001)"], ["  compare(a, b, epsilon = 0.5)"]),
  );
  assert.ok(signalIds(result.signals).includes("tolerance-widened"));
});

// The findings section ends at the next heading of the same level. Letting it
// run on would fold an unrelated section's rows in as if they were findings.
test("a file is reported under the path it has after the diff, not before", () => {
  const diff = [
    "diff --git a/tests/old.test.js b/tests/new.test.js",
    "similarity index 90%",
    "rename from tests/old.test.js",
    "rename to tests/new.test.js",
    "--- a/tests/old.test.js",
    "+++ b/tests/new.test.js",
    "@@ -1,2 +1,2 @@",
    "-  assert.equal(x, 1);",
    "+  assert.equal(x, 1);",
    "",
  ].join("\n");
  const result = separateTestDiff(diff);
  assert.deepEqual(
    result.testFiles.map((f) => f.path),
    ["tests/new.test.js"],
  );
});

// --- The ecosystem matrix: every default rule this file claims to cover ------
//
// One realistic snippet per language, checked against all four things a
// project adopting this tool with no config at all needs to be true: its
// test path is recognised, its plain source path is not, deleting its
// assertion fires assertion-removed, and adding its skip fires skip-added.

interface LangCase {
  name: string;
  testPath: string;
  sourcePath: string;
  assertionLine: string;
  skipLine: string;
}

const LANGUAGE_MATRIX: LangCase[] = [
  {
    name: "Python",
    testPath: "tests/test_widget.py",
    sourcePath: "src/widget.py",
    assertionLine: "assert add(2, 3) == 5",
    skipLine: "@pytest.mark.skip",
  },
  {
    name: "JavaScript",
    testPath: "tests/widget.test.js",
    sourcePath: "src/widget.js",
    assertionLine: "expect(add(2, 3)).toBe(5);",
    skipLine: "it.skip('adds numbers', () => {});",
  },
  {
    name: "TypeScript",
    testPath: "tests/widget.test.ts",
    sourcePath: "src/widget.ts",
    assertionLine: "expect(add(2, 3)).toBe(5);",
    skipLine: "it.skip('adds numbers', () => {});",
  },
  {
    name: "PHP",
    testPath: "tests/WidgetTest.php",
    sourcePath: "src/Widget.php",
    assertionLine: "$this->assertEquals(5, add(2, 3));",
    skipLine: "$this->markTestSkipped('not ready');",
  },
  {
    name: "Ruby",
    testPath: "spec/widget_spec.rb",
    sourcePath: "lib/widget.rb",
    assertionLine: "expect(add(2, 3)).to eq(5)",
    skipLine: 'skip "not ready"',
  },
  {
    name: "Rust",
    testPath: "tests/widget_test.rs",
    sourcePath: "src/widget.rs",
    assertionLine: "assert_eq!(add(2, 3), 5);",
    skipLine: "#[ignore]",
  },
  {
    name: "Go",
    testPath: "widget_test.go",
    sourcePath: "widget.go",
    assertionLine: 'if got != want { t.Errorf("got %d want %d", got, want) }',
    skipLine: 't.SkipNow()',
  },
  {
    name: "Java",
    testPath: "src/test/java/com/example/WidgetTest.java",
    sourcePath: "src/main/java/com/example/Widget.java",
    assertionLine: "assertEquals(5, add(2, 3));",
    skipLine: '@Disabled("not ready")',
  },
  {
    // Deliberately not under a "test"/"tests" directory segment, so this
    // case exercises the PascalCase-suffix rule on its own, not the segment
    // rule: "Widget.Tests" is not the segment "tests".
    name: "C#",
    testPath: "src/Widget.Tests/WidgetTests.cs",
    sourcePath: "src/Widget/Widget.cs",
    assertionLine: "Assert.AreEqual(5, Add(2, 3));",
    skipLine: '[Fact(Skip = "not ready")]',
  },
  {
    name: "Kotlin",
    testPath: "src/test/kotlin/com/example/WidgetTest.kt",
    sourcePath: "src/main/kotlin/com/example/Widget.kt",
    assertionLine: "assertEquals(5, add(2, 3))",
    skipLine: '@Ignore("not ready")',
  },
];

for (const lang of LANGUAGE_MATRIX) {
  test(`${lang.name}: its usual test path classifies as a test`, () => {
    assert.equal(isTestPath(lang.testPath), true, lang.testPath);
  });

  test(`${lang.name}: a plain source file classifies as source`, () => {
    assert.equal(isTestPath(lang.sourcePath), false, lang.sourcePath);
  });

  test(`${lang.name}: deleting its assertion fires assertion-removed`, () => {
    const diff = oneFileDiff(lang.testPath, [lang.assertionLine], []);
    const result = separateTestDiff(diff);
    assert.ok(
      signalIds(result.signals).includes("assertion-removed"),
      `expected assertion-removed, got ${JSON.stringify(signalIds(result.signals))}`,
    );
  });

  test(`${lang.name}: adding its skip fires skip-added`, () => {
    const diff = oneFileDiff(lang.testPath, [], [lang.skipLine]);
    const result = separateTestDiff(diff);
    assert.ok(
      signalIds(result.signals).includes("skip-added"),
      `expected skip-added, got ${JSON.stringify(signalIds(result.signals))}`,
    );
  });
}

// A file sitting in a directory literally named "spec" is a test by the
// segment rule alone, whatever it contains. This is deliberate, the same
// way "spec/foo.rb" already was before this file broadened anything, and it
// does not depend on the file itself looking like a test.
test("a plain file in a folder named spec is still classified as a test", () => {
  assert.equal(isTestPath("spec/README.md"), true);
});

// --- classifyTestPath: names which rule decided, for --classify -------------

test("classifyTestPath names the matching testPaths fragment for a recognised test path", () => {
  const { isTest, matchedRule } = classifyTestPath("tests/widget.test.ts");
  assert.equal(isTest, true);
  assert.match(matchedRule ?? "", /test/);
});

test("classifyTestPath reports no matched rule for a source path", () => {
  const { isTest, matchedRule } = classifyTestPath("src/widget.ts");
  assert.equal(isTest, false);
  assert.equal(matchedRule, null);
});

// --- RuleSet: add extends, replace discards, everything is configurable -----

test("a rules.testPaths add extends the defaults: both the extra and the built-in rules apply", () => {
  const rules: RuleSet = { ...DEFAULT_RULES, testPaths: [...DEFAULT_RULES.testPaths, "\\.flow\\.ts$"] };
  const diff = oneFileDiff("e2e/checkout.flow.ts", ["expect(x).toBe(1);"], []);
  const result = separateTestDiff(diff, { rules });
  assert.deepEqual(
    result.testFiles.map((f) => f.path),
    ["e2e/checkout.flow.ts"],
  );
  // The built-in "tests/" segment rule still applies alongside the extra one.
  assert.equal(separateTestDiff(oneFileDiff("tests/widget.test.ts", [], [])).testFiles[0]?.path, "tests/widget.test.ts");
});

test("a rules.testPaths replace discards the defaults: an ordinary tests/ path stops counting", () => {
  const rules: RuleSet = { ...DEFAULT_RULES, testPaths: ["\\.flow\\.ts$"] };
  const diff = oneFileDiff("tests/widget.test.ts", ["expect(x).toBe(1);"], []);
  const result = separateTestDiff(diff, { rules });
  assert.deepEqual(
    result.sourceFiles.map((f) => f.path),
    ["tests/widget.test.ts"],
  );
  assert.deepEqual(result.testFiles, []);
});

test("a rules.assertions replace narrows what counts as an assertion", () => {
  const rules: RuleSet = { ...DEFAULT_RULES, assertions: ["\\bcheckThat\\("] };
  // The default \bexpect( no longer applies under replace.
  const diff = oneFileDiff("tests/widget.test.ts", ["expect(x).toBe(1);"], []);
  const result = separateTestDiff(diff, { rules });
  assert.deepEqual(result.signals, []);
});

test("compileRuleSet throws on a malformed regex fragment, naming the bucket", () => {
  const rules: RuleSet = { ...DEFAULT_RULES, skips: ["(unclosed"] };
  assert.throws(() => compileRuleSet(rules), /skips/);
});

test("an empty rules bucket, from replace: [], never matches anything", () => {
  const rules: RuleSet = { ...DEFAULT_RULES, skips: [] };
  const diff = oneFileDiff("tests/widget.test.ts", [], ["it.skip('x', () => {});"]);
  const result = separateTestDiff(diff, { rules });
  assert.deepEqual(result.signals, []);
});

// --- Defect 1: an import line is not an assertion, a test case, or a skip ---

test("a removed ES import of an assertion library does not fire assertion-removed", () => {
  const diff = oneFileDiff("tests/widget.test.ts", ['import assert from "node:assert/strict";'], []);
  const result = separateTestDiff(diff);
  assert.deepEqual(result.signals, []);
});

test("a removed require( line does not fire assertion-removed", () => {
  const diff = oneFileDiff("tests/widget.test.js", ['const assert = require("assert");'], []);
  const result = separateTestDiff(diff);
  assert.deepEqual(result.signals, []);
});

test("a removed Python from x import y line does not fire assertion-removed", () => {
  const diff = oneFileDiff("tests/test_widget.py", ["from unittest import mock"], []);
  const result = separateTestDiff(diff);
  assert.deepEqual(result.signals, []);
});

test("a real removed assertion in the same file as a removed import still fires assertion-removed", () => {
  const diff = oneFileDiff(
    "tests/widget.test.ts",
    ['import assert from "node:assert/strict";', "assert.equal(x, 1);"],
    [],
  );
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["assertion-removed"]);
  assert.equal(result.signals.length, 1);
  assert.equal(result.signals[0].line, "assert.equal(x, 1);");
});

test("an import line added or removed does not fire test-case-removed or skip-added", () => {
  const diff = oneFileDiff(
    "tests/widget.test.ts",
    ['import { test } from "node:test";'],
    ['import { skip } from "node:test";'],
  );
  const result = separateTestDiff(diff);
  assert.deepEqual(result.signals, []);
});

// The import filter has to apply to every signal, not only assertions. These
// two lines are import lines by IMPORT_LINE_RE (a require( call) that also
// happen to contain the literal token a testCases/skips fragment looks for,
// so a filter scoped to assertions alone would still let them through.
test("a require( line containing a test-case-opener token does not fire test-case-removed", () => {
  const diff = oneFileDiff("tests/widget.test.js", ['const { test } = require("node:test"); test('], []);
  const result = separateTestDiff(diff);
  assert.deepEqual(result.signals, []);
});

test("a require( line containing a skip token does not fire skip-added", () => {
  const diff = oneFileDiff("tests/widget.test.js", [], ['const { skip } = require("node:test"); skip(']);
  const result = separateTestDiff(diff);
  assert.deepEqual(result.signals, []);
});

// --- Defect 2: a rename that keeps a file classified as a test can still --
// --- lose the basename convention a runner globs on -------------------------

test("a rename inside a test directory from a matching basename to a non-matching one fires test-file-declassified, saying the runner may not collect it", () => {
  const diff = [
    "diff --git a/tests/refund.test.js b/tests/refund.spec.helper.js",
    "similarity index 90%",
    "rename from tests/refund.test.js",
    "rename to tests/refund.spec.helper.js",
    "",
  ].join("\n");
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["test-file-declassified"]);
  const signal = result.signals[0];
  assert.match(signal.message, /may no longer be collected by the test runner/);
  assert.match(signal.message, /tests stop running while the suite still reports success/);
});

test("a rename from a non-matching basename to a matching one does not fire test-file-declassified", () => {
  const diff = [
    "diff --git a/tests/helper.js b/tests/helper.test.js",
    "similarity index 90%",
    "rename from tests/helper.js",
    "rename to tests/helper.test.js",
    "",
  ].join("\n");
  const result = separateTestDiff(diff);
  assert.deepEqual(result.signals, []);
});

test("a rename between two matching basenames does not fire test-file-declassified", () => {
  const diff = [
    "diff --git a/tests/refund.test.js b/tests/refund.spec.js",
    "similarity index 90%",
    "rename from tests/refund.test.js",
    "rename to tests/refund.spec.js",
    "",
  ].join("\n");
  const result = separateTestDiff(diff);
  assert.deepEqual(result.signals, []);
});

test("a rename out of the test paths entirely still fires test-file-declassified, as before", () => {
  const diff = [
    "diff --git a/tests/refund.test.js b/lib/refund.js.bak",
    "similarity index 90%",
    "rename from tests/refund.test.js",
    "rename to lib/refund.js.bak",
    "",
  ].join("\n");
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["test-file-declassified"]);
});

// The realistic scenario this defect exists for: a source change plus a
// rename that quietly drops a test file out of what the runner collects,
// all in one commit, and no noise from the import line the rename drags in.
test("the fixture: a source change plus a rename out of the runner's naming convention, with an import line in the diff", () => {
  const diff = [
    "diff --git a/src/refund.ts b/src/refund.ts",
    "index 1111111..2222222 100644",
    "--- a/src/refund.ts",
    "+++ b/src/refund.ts",
    "@@ -1,1 +1,1 @@",
    "-export function refund() {}",
    "+export function refund() { return true; }",
    "diff --git a/tests/refund.test.js b/tests/refund.spec.helper.js",
    "similarity index 90%",
    "rename from tests/refund.test.js",
    "rename to tests/refund.spec.helper.js",
    "--- a/tests/refund.test.js",
    "+++ b/tests/refund.spec.helper.js",
    "@@ -1,2 +1,2 @@",
    '-import assert from "node:assert/strict";',
    '+import assert from "node:assert/strict";',
    "",
  ].join("\n");
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["test-file-declassified"]);
});

// --- Rust: tests declared inside an ordinary source file ---------------------
//
// Rust's #[cfg(test)] module lives inside the same file as the code it
// covers, so the path alone reads as source. See src/test-diff-separator.ts's
// own comment ahead of hasRustTestMarker for what this can and cannot catch.

test("a .rs diff removing an assert_eq! from inside a #[cfg(test)] module reports a weakening, and the file still counts as source", () => {
  const diff = oneFileDiff(
    "src/widget.rs",
    [
      "#[cfg(test)]",
      "mod tests {",
      "    #[test]",
      "    fn adds() {",
      "        assert_eq!(add(2, 3), 5);",
      "    }",
      "}",
    ],
    ["#[cfg(test)]", "mod tests {", "    #[test]", "    fn adds() {", "    }", "}"],
  );
  const result = separateTestDiff(diff);
  assert.ok(
    signalIds(result.signals).includes("assertion-removed"),
    `expected assertion-removed, got ${JSON.stringify(signalIds(result.signals))}`,
  );
  assert.deepEqual(
    result.sourceFiles.map((f) => f.path),
    ["src/widget.rs"],
  );
  assert.deepEqual(result.testFiles, []);
});

test("a .rs diff with no test markers at all reports nothing", () => {
  const diff = oneFileDiff("src/widget.rs", ["fn add(a: i32, b: i32) -> i32 {"], ["fn add(a: i64, b: i64) -> i64 {"]);
  const result = separateTestDiff(diff);
  assert.deepEqual(result.signals, []);
  assert.deepEqual(
    result.sourceFiles.map((f) => f.path),
    ["src/widget.rs"],
  );
});

test("a removed assert_eq! in a .rs file under tests/ still behaves as before: reported as a test file, still fires the signal", () => {
  const diff = oneFileDiff("tests/widget_test.rs", ["assert_eq!(add(2, 3), 5);"], []);
  const result = separateTestDiff(diff);
  assert.ok(
    signalIds(result.signals).includes("assertion-removed"),
    `expected assertion-removed, got ${JSON.stringify(signalIds(result.signals))}`,
  );
  assert.deepEqual(
    result.testFiles.map((f) => f.path),
    ["tests/widget_test.rs"],
  );
  assert.deepEqual(result.sourceFiles, []);
});

test("hasRustTestMarker reads a marker reachable only via a context line, not just an added or removed one", () => {
  // "#[test]" sits on a context line (never added or removed); the only
  // changed line is "#[ignore]", which carries no marker word of its own.
  // There is no #[cfg(test)] attribute anywhere, so cfgTestRegionMask
  // finds no region either: only reading context lines in
  // hasRustTestMarker can explain the signal below.
  const diff = diffWithHunk("src/widget.rs", [
    " #[test]",
    " fn applies_discount() {",
    "+    #[ignore]",
    "     let result = discount(120);",
    " }",
  ]);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

test("hasRustTestMarker reads a marker reachable only via a hunk's @@ ... @@ heading", () => {
  // Git fills a hunk heading with the enclosing scope above it; here that
  // text is "#[cfg(test)]", never a line in the diff body itself. As
  // above, no #[cfg(test)] attribute line exists for cfgTestRegionMask to
  // find, so only reading hunkHeadings in hasRustTestMarker explains the
  // signal.
  const diff = [
    "diff --git a/src/widget.rs b/src/widget.rs",
    "index 1111111..2222222 100644",
    "--- a/src/widget.rs",
    "+++ b/src/widget.rs",
    "@@ -1,3 +1,4 @@ #[cfg(test)]",
    " fn applies_discount() {",
    "+    #[ignore]",
    "     let result = discount(120);",
    " }",
    "",
  ].join("\n");
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

// --- Rust: #[cfg(test)] module regions found by brace matching ---------------
//
// These build a single-file diff hunk line by line, each already carrying
// its own "+"/"-"/" " marker, so a fixture can place a change deep inside a
// #[cfg(test)] module while a plain context line (no marker word of its
// own) sits right next to it: the exact case that path/line marker
// scanning alone cannot see, and that the brace-matched region (see
// cfgTestRegionMask in src/test-diff-separator.ts) is there to catch.
function diffWithHunk(path: string, hunkLines: string[]): string {
  let oldCount = 0;
  let newCount = 0;
  for (const line of hunkLines) {
    if (line.startsWith("-")) oldCount++;
    else if (line.startsWith("+")) newCount++;
    else {
      oldCount++;
      newCount++;
    }
  }
  const parts = [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${oldCount} +1,${newCount} @@`,
    ...hunkLines,
    "",
  ];
  return parts.join("\n");
}

test("a skip added inside a #[cfg(test)] module, with no Rust test marker anywhere in the diff, still reports skip-added", () => {
  // #[ignore] carries no #[cfg(test)]/#[test]/::test/assert_eq!/assert_ne!/
  // assert! wording of its own, and the module is opened with the
  // all(test, ...) form, which RUST_TEST_MARKER_RE does not match either
  // (only the plain "#[cfg(test)]" spelling is in that regex). Nothing in
  // this whole diff matches RUST_TEST_MARKER_RE, so only the region (opened
  // by the #[cfg(all(test, ...))]/mod tests { pair) can explain the
  // skip-added signal below; the marker path would report nothing here.
  const diff = diffWithHunk("src/pricing.rs", [
    ' #[cfg(all(test, feature = "flaky"))]',
    " mod tests {",
    "     use super::*;",
    " ",
    "+    #[ignore]",
    "     fn applies_discount() {",
    "         let result = discount(120);",
    "         let expected = 110;",
    "         result == expected",
    "     }",
    " }",
  ]);
  const result = separateTestDiff(diff);
  assert.ok(
    signalIds(result.signals).includes("skip-added"),
    `expected skip-added, got ${JSON.stringify(signalIds(result.signals))}`,
  );
  assert.deepEqual(
    result.sourceFiles.map((f) => f.path),
    ["src/pricing.rs"],
  );
  assert.deepEqual(result.testFiles, []);
});

test("an assertion removed inside a #[cfg(test)] module reports assertion-removed", () => {
  const diff = diffWithHunk("src/pricing.rs", [
    " #[cfg(test)]",
    " mod tests {",
    "     #[test]",
    "     fn applies_discount() {",
    "         let result = discount(120);",
    "-        assert_eq!(result, 110);",
    "     }",
    " }",
  ]);
  const result = separateTestDiff(diff);
  assert.ok(
    signalIds(result.signals).includes("assertion-removed"),
    `expected assertion-removed, got ${JSON.stringify(signalIds(result.signals))}`,
  );
});

test("a change to real source code in the same .rs file, outside the #[cfg(test)] module, reports nothing", () => {
  const diff = diffWithHunk("src/pricing.rs", [
    " fn discount(cents: i64) -> i64 {",
    "-    cents - 10",
    "+    cents - 20",
    " }",
    " ",
    " #[cfg(test)]",
    " mod tests {",
    "     #[test]",
    "     fn applies_discount() {",
    "         assert_eq!(discount(120), 110);",
    "     }",
    " }",
  ]);
  const result = separateTestDiff(diff);
  assert.deepEqual(result.signals, []);
  assert.deepEqual(
    result.sourceFiles.map((f) => f.path),
    ["src/pricing.rs"],
  );
});

test("nested braces inside the test module (a fn, a match, and a closure) do not close the region early", () => {
  // If brace counting were wrong -- stopped early, or never decremented --
  // this change, which sits after several nested `{...}` blocks but still
  // inside the outer `mod tests { ... }`, would be missed.
  const diff = diffWithHunk("src/pricing.rs", [
    " #[cfg(test)]",
    " mod tests {",
    "     fn helper(n: i64) -> i64 {",
    "         match n {",
    "             0 => 0,",
    "             _ => (|x: i64| { x + 1 })(n),",
    "         }",
    "     }",
    " ",
    "     #[test]",
    "     fn applies_discount() {",
    "         let result = discount(120);",
    "-        assert_eq!(result, 100);",
    "+        assert_eq!(result, 110);",
    "     }",
    " }",
  ]);
  const result = separateTestDiff(diff);
  assert.ok(
    signalIds(result.signals).includes("assertion-weakened"),
    `expected assertion-weakened past the nested braces, got ${JSON.stringify(signalIds(result.signals))}`,
  );
});

test("#[cfg(all(test, feature = \"slow\"))] opens a region, same as plain #[cfg(test)]", () => {
  const diff = diffWithHunk("src/pricing.rs", [
    ' #[cfg(all(test, feature = "slow"))]',
    " mod tests {",
    "     fn check(n: i64) {",
    "-        verify(n, 100);",
    "+        verify(n, 110);",
    "     }",
    " }",
  ]);
  const result = separateTestDiff(diff);
  assert.ok(
    signalIds(result.signals).length > 0,
    `expected a signal from inside the all(test, ...) region, got ${JSON.stringify(signalIds(result.signals))}`,
  );
});

test("#[cfg(test)] mod tests; (a declaration, body in another file) opens no region", () => {
  const diff = diffWithHunk("src/pricing.rs", [
    " #[cfg(test)]",
    " mod tests;",
    " ",
    " fn discount(cents: i64) -> i64 {",
    "-    cents - 10",
    "+    cents - 20",
    " }",
  ]);
  const result = separateTestDiff(diff);
  assert.deepEqual(result.signals, []);
});

test("a .rs file with no test module at all behaves exactly as before: no signal", () => {
  const diff = diffWithHunk("src/pricing.rs", [
    " fn discount(cents: i64) -> i64 {",
    "-    cents - 10",
    "+    cents - 20",
    " }",
  ]);
  const result = separateTestDiff(diff);
  assert.deepEqual(result.signals, []);
  assert.deepEqual(
    result.sourceFiles.map((f) => f.path),
    ["src/pricing.rs"],
  );
});

test("cfg(test) region detection never changes the file's added/removed counts, or which half it counts in", () => {
  const diff = diffWithHunk("src/pricing.rs", [
    " #[cfg(test)]",
    " mod tests {",
    "     #[test]",
    "     fn applies_discount() {",
    "         let result = discount(120);",
    "-        assert_eq!(result, 100);",
    "+        assert_eq!(result, 110);",
    "     }",
    " }",
  ]);
  const result = separateTestDiff(diff);
  assert.equal(result.sourceAdded, 1);
  assert.equal(result.sourceRemoved, 1);
  assert.equal(result.testAdded, 0);
  assert.equal(result.testRemoved, 0);
  assert.deepEqual(
    result.sourceFiles.map((f) => ({ path: f.path, added: f.added, removed: f.removed })),
    [{ path: "src/pricing.rs", added: 1, removed: 1 }],
  );
});

test("a single-line block comment holding a stray '}' no longer closes the region early", () => {
  // Reproduction: with the comment line present, the region used to close
  // at the '}' inside "/* a comment with a } inside */", so the change to
  // verify(n, 100) below sat outside the mask and reported nothing.
  // stripRustNoiseForBraceCounting now removes a same-line /* ... */
  // block comment before brace counting runs, so the region should still
  // extend to the module's real closing brace.
  const diff = diffWithHunk("src/pricing.rs", [
    ' #[cfg(all(test, feature = "x"))]',
    " mod tests {",
    "     /* a comment with a } inside */",
    "     fn check(n: i64) {",
    "-        verify(n, 100);",
    "+        verify(n, 110);",
    "     }",
    " }",
  ]);
  const result = separateTestDiff(diff);
  assert.ok(
    signalIds(result.signals).includes("assertion-weakened"),
    `expected assertion-weakened past the one-line block comment, got ${JSON.stringify(signalIds(result.signals))}`,
  );
});

test("known miss: a multi-line block comment holding a stray '}' still closes the region early", () => {
  // stripRustNoiseForBraceCounting only recognises a /* ... */ block
  // comment that opens and closes on the same line; one that spans lines
  // is line-local stripping's stated limit, pinned here as a fact instead
  // of stated only in prose. The '}' on the comment's own line still
  // closes the region before the real change is reached, so this reports
  // nothing.
  const diff = diffWithHunk("src/pricing.rs", [
    ' #[cfg(all(test, feature = "x"))]',
    " mod tests {",
    "     /* a comment",
    "        with a } inside",
    "        that spans lines */",
    "     fn check(n: i64) {",
    "-        verify(n, 100);",
    "+        verify(n, 110);",
    "     }",
    " }",
  ]);
  const result = separateTestDiff(diff);
  assert.deepEqual(result.signals, []);
});

test("known limit: #[cfg(any(test, feature = \"x\"))] opens no region and matches no marker", () => {
  // any(...) means the module also compiles outside test builds, so it is
  // not test-only code; CFG_TEST_ATTR_RE only recognises cfg(test) and a
  // cfg(all(...)) naming test among its conditions, both forms where test
  // is required for the item to compile at all. Pinned here as the
  // unstated limit the banner above now names.
  const diff = diffWithHunk("src/pricing.rs", [
    ' #[cfg(any(test, feature = "x"))]',
    " mod tests {",
    "     fn check(n: i64) {",
    "-        verify(n, 100);",
    "+        verify(n, 110);",
    "     }",
    " }",
  ]);
  const result = separateTestDiff(diff);
  assert.deepEqual(result.signals, []);
});

test("the region closes at its own closing brace: a later, unrelated source change past it reports nothing", () => {
  // The module comes first this time, using the all(test, ...) form so
  // this only goes through the region path, never the marker path (see the
  // skip-added test above for why). If the region's depth counter did not
  // close it at the right brace -- for instance if it never closed at all
  // -- everything after it, including this unrelated later change, would
  // be swept in as test content too and this would wrongly report a
  // skip-added signal for the plain source edit below.
  const diff = diffWithHunk("src/pricing.rs", [
    ' #[cfg(all(test, feature = "flaky"))]',
    " mod tests {",
    "     fn helper(n: i64) -> bool {",
    "         let result = discount(n);",
    "-        result == 100",
    "+        result == 110",
    "     }",
    " }",
    " ",
    " fn unrelated(n: i64) -> i64 {",
    "-    n + 1",
    "+    n.skip(1)",
    " }",
  ]);
  const result = separateTestDiff(diff);
  assert.deepEqual(result.signals, []);
});
