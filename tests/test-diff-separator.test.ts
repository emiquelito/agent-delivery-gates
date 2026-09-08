// Tests for src/test-diff-separator.ts, the pure core. Every test asserts
// an observable outcome from separateTestDiff: a signal id, a count, or a
// file's classification. Never an internal value.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isTestPath, separateTestDiff, type Signal } from "../src/test-diff-separator.ts";

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
  assert.equal(isTestPath("SRC/Foo.TEST.TS"), true);
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
