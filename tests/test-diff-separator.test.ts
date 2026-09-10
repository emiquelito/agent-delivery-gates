// Tests for src/test-diff-separator.ts, the pure core. Every test asserts
// an observable outcome from separateTestDiff: a signal id, a count, or a
// file's classification. Never an internal value.
//
// adg-test-diff: fixtures
// This file holds diff text written to look like a weakening, so the
// detector can be run against it; the signals it trips are never real.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyTestPath,
  compileRuleSet,
  DEFAULT_RULES,
  FIXTURE_MARKER,
  hasFixtureMarker,
  isTestPath,
  separateTestDiff,
  separateTestDiffWarmed,
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

// Finding 8, and every narrowing since: this rule was rewritten three times
// to describe a disabling call precisely enough to exclude some false
// positive ("Skip" chained to an unclosed "[", then to a bare quote, then
// to a closed set of value forms; the receiver allowlist and the
// string-argument requirement on the JS/TS side went through the same
// churn). A reviewer running the real gate, not the regex, found a real
// disabling call each narrowing missed. This bucket runs against TEST
// FILES ONLY (see "Weakening signals, run against test files only" in
// src/test-diff-separator.ts), which flips the calculation: a false
// positive here costs a human one dismissible warning, while a false
// negative is this product failing at its one job. So the fragments below
// are deliberately wide and accept the occasional ordinary variable or
// pagination call that happens to share the word "skip". See the ".Skip(20)
// pagination call now fires skip-added (accepted noise)" test further down
// for the trade recorded on purpose.

test("a variable named skip now fires skip-added too -- accepted noise, not a bug", () => {
  // Deliberate false positive: "skip = ..." on an ordinary variable, in a
  // test file, is indistinguishable from xUnit's "Skip = ..." attribute
  // value without anchoring to the value's own form, and every such anchor tried
  // so far missed a real disabling call. This is the trade: do not narrow
  // this back to make this case quiet again.
  const diff = oneFileDiff("tests/widget.test.ts", [], ['const skip = new Set(["a.ts", "b.ts"]);']);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

test("an added [Fact(Skip = \"reason\")] still fires skip-added", () => {
  const diff = oneFileDiff("tests/WidgetTests.cs", [], ['[Fact(Skip = "not ready yet")]']);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

test("an added [Fact(Skip = \"reason\")] fires skip-added across its spacing variants", () => {
  for (const line of ['[Fact(Skip = "not ready")]', '[Fact(Skip="not ready")]', '[Fact(Skip  =  "not ready")]']) {
    const diff = oneFileDiff("tests/WidgetTests.cs", [], [line]);
    const result = separateTestDiff(diff);
    assert.deepEqual(signalIds(result.signals), ["skip-added"], `expected skip-added for: ${line}`);
  }
});

test("an added [Theory(Skip = \"reason\")] still fires skip-added", () => {
  const diff = oneFileDiff("tests/WidgetTests.cs", [], ['[Theory(Skip = "not ready")]']);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

// Finding 1: the bracket anchor above required an unclosed "[" earlier on
// the SAME diff line, which a reviewer found misses ordinary style. Each
// case below is one of the reproductions the reviewer ran through the real
// gate, not the regex alone.

test("a multi-line attribute with Skip on its own continuation line still fires skip-added", () => {
  // The "[" that opens the attribute list sits on a different diff line
  // than "Skip = ", and this bucket masks and tests one diff line at a
  // time (see the per-line limit named on maskDiffLine in
  // src/test-diff-separator.ts), so no single line here ever holds both.
  const diff = oneFileDiff(
    "tests/WidgetTests.cs",
    [],
    ["[Theory(", '  DisplayName = "x",', '  Skip = "flaky")]'],
  );
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

test("an array-typed argument earlier in the attribute list still lets Skip fire", () => {
  // "new[]" closes a real "]" earlier on the line, which the old bracket
  // anchor read as closing the whole attribute class before "Skip =" was
  // ever reached.
  const diff = oneFileDiff("tests/WidgetTests.cs", [], ['[Theory(Data = new[] {1,2}, Skip = "x")]']);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

test("a closing bracket inside an unrelated string argument does not hide a later Skip", () => {
  const diff = oneFileDiff(
    "tests/WidgetTests.cs",
    [],
    ['[Fact(DisplayName = "note: see appendix]", Skip = "x")]'],
  );
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

// Finding 2, and the widening that followed: "\.skip\(" was once anchored
// to a small allowlist of test-declaration identifiers specifically to
// exclude C# LINQ's ".Skip(n)" pagination and the JS Iterator Helpers
// ".skip(n)" method. That anchor, and every later one tried in its place,
// kept getting defeated by an ordinary way of writing a disabled test (see
// the comment above the skips bucket in src/test-diff-separator.ts). Since
// this bucket only ever runs against test files, the two tests below now
// record the accepted trade on purpose: pagination inside a test file is
// uncommon, and when it happens the cost is one warning a human dismisses
// in seconds, which is cheaper than the silent miss the old anchor kept
// reopening. Do not narrow ".skip\(" back to make these quiet again.

test("C# LINQ's .Skip(20) pagination call fires skip-added (accepted noise, not a bug)", () => {
  const diff = oneFileDiff(
    "tests/WidgetTests.cs",
    [],
    ["var page = items.OrderBy(x => x.Id).Skip(20).Take(10).ToList();"],
  );
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

test("the JS Iterator Helpers .skip(5) method fires skip-added (accepted noise, not a bug)", () => {
  const diff = oneFileDiff("tests/widget.test.ts", [], ["const rest = iter.skip(5);"]);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

test("test.describe.skip (Playwright's nested form) still fires skip-added", () => {
  const diff = oneFileDiff("tests/widget.test.ts", [], ["test.describe.skip('flaky group', () => {});"]);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

// A reviewer running the real gate, not the regex alone, reproduced three
// ordinary xUnit forms that the value-anchored "Skip = " fragment above (at
// the time, "Skip\s*=\s*[\"']", requiring a bare quote right after "=")
// let through: an interpolated string, a verbatim string, and a reference
// to a named constant. All three were caught by the version before that.
// The fragment now accepts every one of those value forms; see its own
// comment in src/test-diff-separator.ts for how it still keeps out "const
// skip = new Set(...)".

test("[Fact(Skip = $\"...\")] with an interpolated reason still fires skip-added", () => {
  const diff = oneFileDiff(
    "tests/WidgetTests.cs",
    [],
    ['[Fact(Skip = $"flaky on {Environment.MachineName}")]'],
  );
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

test("[Fact(Skip = @\"...\")] with a verbatim reason still fires skip-added", () => {
  const diff = oneFileDiff("tests/WidgetTests.cs", [], ['[Fact(Skip = @"flaky, see JIRA-123")]']);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

test("[Fact(Skip = SkipReasons.Flaky)] with a named-constant reason still fires skip-added", () => {
  const diff = oneFileDiff("tests/WidgetTests.cs", [], ['[Fact(Skip = SkipReasons.Flaky)]']);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

test("[Fact(Skip = $@\"...\")] and [Fact(Skip = @$\"...\")], the combined interpolated-verbatim forms, still fire skip-added", () => {
  for (const line of ['[Fact(Skip = $@"flaky {Env.Name}")]', '[Fact(Skip = @$"flaky {Env.Name}")]']) {
    const diff = oneFileDiff("tests/WidgetTests.cs", [], [line]);
    const result = separateTestDiff(diff);
    assert.deepEqual(signalIds(result.signals), ["skip-added"], `expected skip-added for: ${line}`);
  }
});

// The ".skip(" fragment no longer anchors on the receiver or on the
// argument's form at all: any identifier (or none, or a bracket-accessed
// one) chained with ".skip(" fires, whatever the call's arguments are.
// This closes every escape a reviewer reproduced across three rounds of
// narrowing: a differently-named or aliased runner, a reason given as a
// named constant instead of a string literal, optional chaining on the
// receiver, and a receiver reached through bracket/computed access.

test("a custom runner's own .skip(reason) call fires skip-added", () => {
  const diff = oneFileDiff("tests/widget.test.ts", [], ["myCustomRunner.skip('flaky', () => {});"]);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

test("a test function imported under an alias, calling .skip(reason), fires skip-added", () => {
  const diff = oneFileDiff("tests/widget.test.ts", [], ["t.skip('adds numbers', () => {});"]);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

test("a custom runner's .skip(reason) still fires when the reason is a template literal", () => {
  const diff = oneFileDiff("tests/widget.test.ts", [], ["myCustomRunner.skip(`flaky`, () => {});"]);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

test("a bare .skip() with no argument at all fires skip-added", () => {
  // A reviewer reproduced this against the real gate: "runner.skip();"
  // returned exit 0 and "Signals: none found" under the old
  // string-argument-anchored fragment, since a disabling call was assumed
  // to always carry a reason. It does not have to.
  const diff = oneFileDiff("tests/widget.test.ts", [], ["runner.skip();"]);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

test("a skip reason given as a named constant, not a string literal, fires skip-added", () => {
  // Reproduced against the real gate: "run.skip(FLAKY_REASON, () => {...})"
  // escaped the old fragment, which required the first argument to open
  // with a quote or backtick.
  const diff = oneFileDiff("tests/widget.test.ts", [], ["run.skip(FLAKY_REASON, () => { doStuff(); });"]);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

test("optional chaining on the receiver still fires skip-added", () => {
  // Reproduced against the real gate: "it?.skip('flaky');" escaped the old
  // receiver allowlist, since the "?" broke the adjacency the allowlist
  // depended on even for one of its own six names.
  const diff = oneFileDiff("tests/widget.test.ts", [], ["it?.skip('flaky');"]);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

test("a receiver reached through bracket access now fires skip-added", () => {
  // Reproduced against the real gate: "runners['custom'].skip('flaky',
  // () => {});" escaped every earlier version of this fragment, since none
  // of them required an identifier immediately before the "."; dropping
  // the receiver anchor entirely closes this along with the others above.
  const diff = oneFileDiff("tests/widget.test.ts", [], ["runners['custom'].skip('flaky', () => {});"]);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

test("Mocha's argument-less this.skip() inside a test body fires skip-added", () => {
  const diff = oneFileDiff(
    "tests/widget.test.ts",
    [],
    ['test("flaky one", function() {', "  this.skip();", "  doStuff();", "});"],
  );
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

// Known gap, found while widening this rule and not fixed here: a skip
// call reached through a computed/bracket property name on the CALL
// itself, not just the receiver, still escapes. No literal ".skip(" ever
// appears on such a line, and every fragment in this bucket runs against
// the string-masked line (see maskNonCode in src/code-mask.ts), which
// blanks the word "skip" along with the rest of the string literal's
// contents before any regex here ever sees it. See the comment on the
// ".skip(" fragment in src/test-diff-separator.ts for the full reasoning.
test("a skip call reached through a computed property name on the call itself still escapes (known gap)", () => {
  const diff = oneFileDiff("tests/widget.test.ts", [], ["runner['skip']('flaky');"]);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), []);
});

// Finding 2: RSpec's modern colon-metadata spelling for disabling an
// example or a whole group ("skip: true", "skip: \"flaky\"", "pending:
// true") produced no signal at all before this fragment existed; only the
// obsolete hash-rocket spelling was ever caught, and only by accident (see
// the next test below).

test("RSpec's it \"...\", skip: true do fires skip-added", () => {
  const diff = oneFileDiff("spec/widget_spec.rb", [], ['it "adds numbers", skip: true do']);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

test("RSpec's it \"...\", skip: \"flaky\" do (a reason, not just a boolean) fires skip-added", () => {
  const diff = oneFileDiff("spec/widget_spec.rb", [], ['it "adds numbers", skip: "flaky" do']);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

test("RSpec's context \"...\", skip: true do (a whole group, not just one example) fires skip-added", () => {
  const diff = oneFileDiff("spec/widget_spec.rb", [], ['context "when discounted", skip: true do']);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

test("RSpec's pending: true metadata fires skip-added", () => {
  const diff = oneFileDiff("spec/widget_spec.rb", [], ['it "adds numbers", pending: true do']);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

test("RSpec's obsolete hash-rocket spelling (:skip => true) still fires skip-added, incidentally, through the equals-value fragment", () => {
  // Finding 2 named this as the ONLY spelling that worked before the fix:
  // "=>" contains a literal "=", so "\\bskip\\s*=\\s*\\S" (written for
  // xUnit's Skip = "reason") matches it by coincidence, not by design.
  // Recorded here as a permanent regression test so this does not go
  // unnoticed if that fragment is ever narrowed.
  const diff = oneFileDiff("spec/widget_spec.rb", [], ['it "adds numbers", :skip => true do']);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

// Finding 3: NUnit's and MSTest's [Ignore] attribute almost always carries
// a reason string in real code; the bare, argument-less form the old
// fragment required essentially never appears, so this fragment likely
// never fired on an actual disable before this fix.

test("NUnit's [Ignore(\"reason\")] (the form real code actually uses) fires skip-added", () => {
  const diff = oneFileDiff("tests/WidgetTests.cs", [], ['[Ignore("not ready yet")]']);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

test("the bare NUnit/MSTest [Ignore] (no reason) still fires skip-added", () => {
  const diff = oneFileDiff("tests/WidgetTests.cs", [], ["[Ignore]"]);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

test("MSTest's [Ignore(\"reason\")] fires skip-added -- same fragment, same fix, checked directly per the adjudication", () => {
  const diff = oneFileDiff("MyProject.Tests/WidgetTests.cs", [], ['[Ignore("flaky on CI")]']);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

test("[Ignore\\b does not widen into an unrelated [IgnoreAttribute] identifier", () => {
  // Guards the word-boundary anchor chosen for the Finding 3 fix: a
  // custom attribute literally named IgnoreAttribute (used with or without
  // the "Attribute" suffix trimmed, as C# allows) is a different
  // identifier from "Ignore", not a wider spelling of it.
  const diff = oneFileDiff("tests/WidgetTests.cs", [], ["[IgnoreAttribute]"]);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), []);
});

// Finding 3's own audit, run against the gate: JUnit's @Disabled("reason")
// and @Ignore("reason"), and xUnit's [Fact(Skip = "reason")], never had
// this problem -- both already fire, unchanged by this fix. The
// language-matrix cases for Java and C# above (skipLine:
// '@Disabled("not ready")', '[Fact(Skip = "not ready")]') already exercise
// this; these two make the audit's own finding explicit, not just implicit
// in a shared fixture.

test("JUnit's @Ignore(\"reason\") (the JUnit 4 spelling) already fires skip-added, unaffected by the NUnit/MSTest fix", () => {
  const diff = oneFileDiff("src/test/java/com/example/WidgetTest.java", [], ['@Ignore("not ready")']);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

test("xUnit's [Fact(Skip = \"reason\")] already fires skip-added, unaffected by the NUnit/MSTest fix", () => {
  const diff = oneFileDiff("tests/WidgetTests.cs", [], ['[Fact(Skip = "not ready")]']);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

// Finding 4: the code comment above "\\bskip\\s*=\\s*\\S" described the
// accepted noise as "an assignment or a pagination call", but the same
// fragment fires on a comparison too, since it does not distinguish one
// "=" from a run of them. No behaviour change; this locks in the real
// behaviour the comment now describes.

test("a comparison, not an assignment, still fires skip-added (Finding 4: the comment was imprecise, not the behaviour)", () => {
  const diff = oneFileDiff("tests/widget.test.ts", [], ["if (skip == true) { return; }"]);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

// --- Hunted while widening this rule: gaps found with no prior coverage -----

test("Playwright's test.fixme() fires skip-added -- a real disabling call with no coverage before this fix", () => {
  const diff = oneFileDiff("tests/widget.test.ts", [], ["test.fixme();"]);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

test("Playwright's nested test.describe.fixme(...) fires skip-added", () => {
  const diff = oneFileDiff("tests/widget.test.ts", [], ["test.describe.fixme('flaky group', () => {});"]);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

test("Python unittest's imperative self.skipTest(...) fires skip-added -- no decorator, so the @unittest.skip fragments never saw it", () => {
  const diff = oneFileDiff("tests/test_widget.py", [], ['        self.skipTest("not ready")']);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

test("Swift's throw XCTSkip(\"reason\") fires skip-added -- XCTest has no per-test skip attribute at all", () => {
  const diff = oneFileDiff("Tests/WidgetTests.swift", [], ['        throw XCTSkip("not ready on this platform")']);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

test("Elixir's @tag :skip fires skip-added", () => {
  const diff = oneFileDiff("test/widget_test.exs", [], ["  @tag :skip"]);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

test("Elixir's @moduletag :skip (the whole-file form) fires skip-added", () => {
  const diff = oneFileDiff("test/widget_test.exs", [], ["@moduletag :skip"]);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

// --- Six more gaps, each reproduced through the real gate by a reviewer,
// closed here. Every "before" behaviour named in these comments was
// confirmed by running the prior commit's separateTestDiff against the same
// fixture, not assumed.

// Vitest's (and Jest's) conditional skip, ranked first because it was the
// worst of the six: an unconditional "test('name', fn)" turned into
// "test.skipIf(cond)('name', fn)" produced no skip-added at all before this
// fix, AND the removed unconditional line, with nothing left to offset it in
// the testCases count, was reported as test-case-removed -- the wrong kind
// of change, confirmed against the prior commit.

test("Vitest's test.skipIf(cond)(...) fires skip-added, not test-case-removed", () => {
  const diff = oneFileDiff(
    "tests/widget.test.ts",
    ["test('adds', () => { doAdd(); });"],
    ["test.skipIf(isCI)('adds', () => { doAdd(); });"],
  );
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

test("Vitest's describe.skipIf(cond)(...) fires skip-added, not test-case-removed", () => {
  const diff = oneFileDiff(
    "tests/widget.test.ts",
    ["describe('suite', () => {"],
    ["describe.skipIf(isCI)('suite', () => {"],
  );
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

// Jest's and Vitest's chained table form: confirmed producing no signal at
// all before this fix, since "skip" was followed by ".each(", not "(",
// which the plain ".skip(" fragment requires directly.

test("Jest's/Vitest's test.skip.each([...])(...) fires skip-added", () => {
  const diff = oneFileDiff(
    "tests/widget.test.ts",
    [],
    ["test.skip.each([[1, 2, 3]])('adds %i and %i', (a, b, exp) => { doAdd(a, b, exp); });"],
  );
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

test("it.skip.each([...])(...) fires skip-added too", () => {
  const diff = oneFileDiff("tests/widget.test.ts", [], ["it.skip.each([[1, 2]])('adds %i', (a, b) => {});"]);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

// TestNG's declarative disable: no separate skip attribute exists, so a
// test is disabled by setting "enabled = false" on @Test itself. Confirmed
// producing no signal at all before this fix; no fragment in this bucket
// covered this form.

test("TestNG's @Test(enabled = false) fires skip-added", () => {
  const diff = oneFileDiff("src/test/java/com/example/WidgetTest.java", [], ["@Test(enabled = false)"]);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

test("an ordinary @Test(dataProvider = \"x\") with no enabled attribute does not fire skip-added", () => {
  // Guards the anchor chosen for the TestNG fix: it is scoped to "@Test("
  // plus "enabled = false" on the same line, not a bare "enabled = false"
  // anywhere in a test file, which would collide with ordinary feature-flag
  // or mock-config code.
  const diff = oneFileDiff("src/test/java/com/example/WidgetTest.java", [], ['@Test(dataProvider = "x")']);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), []);
});

// R's testthat skip family: an underscore always sits between "skip" and
// the call's parenthesis, which the bare-call fragment above
// ("(?<!\\.)\\bskip\\(") does not allow for, so each of these produced no
// signal before this fix.

test("R testthat's skip_if(cond) fires skip-added", () => {
  const diff = oneFileDiff("tests/testthat/test-widget.R", [], ["skip_if(is_offline())"]);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

test("R testthat's skip_on_cran() fires skip-added", () => {
  const diff = oneFileDiff("tests/testthat/test-widget.R", [], ["skip_on_cran()"]);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

test("R testthat's skip_on_os(\"windows\") fires skip-added", () => {
  const diff = oneFileDiff("tests/testthat/test-widget.R", [], ['skip_on_os("windows")']);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

// NUnit's imperative, mid-test disable: "Assert.Ignore(...)" is called from
// inside the test body, distinct from the "[Ignore]" attribute already
// covered above. Confirmed producing no signal at all before this fix.

test("NUnit's Assert.Ignore(\"reason\") fires skip-added", () => {
  const diff = oneFileDiff("tests/WidgetTests.cs", [], ['Assert.Ignore("not ready yet");']);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

// Deno's object-form test opener carries its disable as an "ignore: true"
// option, not a separate call. Confirmed producing no signal at all before
// this fix; no fragment named "ignore" at all.

test("Deno's Deno.test({ ignore: true, ... }) fires skip-added", () => {
  const diff = oneFileDiff(
    "widget_test.ts",
    [],
    ["Deno.test({", '  name: "adds",', "  ignore: true,", "  fn() { doAdd(); },", "});"],
  );
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

// --- Reviewer findings against the six-gap fix above ------------------------
//
// An independent reviewer found three more problems in the commit above,
// two of them misses in exact forms that commit claimed to have closed.
// Each "before" behaviour named below was confirmed by running the prior
// commit's separateTestDiff against the same fixture.

// Finding 1: Deno's own documentation shows "ignore" set conditionally, not
// just as a literal "true" -- confirmed producing no signal at all before
// this fix, since the old fragment required the literal word.

test("Deno's Deno.test({ ignore: <conditional expression>, ... }) fires skip-added", () => {
  const diff = oneFileDiff(
    "widget_test.ts",
    [],
    [
      "Deno.test({",
      '  name: "example",',
      '  ignore: Deno.build.os === "windows",',
      "  fn() { doAdd(); },",
      "});",
    ],
  );
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

test("Deno's Deno.test({ ignore: <plain variable>, ... }) fires skip-added", () => {
  const diff = oneFileDiff(
    "widget_test.ts",
    [],
    ["Deno.test({", '  name: "example",', "  ignore: isCI,", "  fn() { doAdd(); },", "});"],
  );
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

// Finding 2: Jest and Vitest also support a tagged-template form of the
// chained table opener, in place of the array form the fragment already
// covered. Confirmed missing for both the "test" and "describe" spellings,
// and not disclosed by the builder's tests, which only covered the array
// form.

test("Jest's/Vitest's test.skip.each`...` (tagged-template form) fires skip-added", () => {
  const diff = oneFileDiff(
    "tests/widget.test.ts",
    [],
    ["test.skip.each`a | b", '${1} | ${2}`("adds %i and %i", (a, b) => { doAdd(a, b); });'],
  );
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

test("describe.skip.each`...` (tagged-template form) fires skip-added too", () => {
  const diff = oneFileDiff(
    "tests/widget.test.ts",
    [],
    ["describe.skip.each`a | b", '${1} | ${2}`("adds", () => {});'],
  );
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

// Finding 3, a confirmed regression, NOT fixed here -- the reviewer found
// no local fix exists without per-test pairing, which this file's
// one-line-at-a-time model cannot do, and recommended naming the trade
// instead of redesigning the counting. See the comments on the testCases
// bucket's "\\b(?:test|it|describe)\\.skipIf\\(" fragment and on
// netRemovalSignal in src/test-diff-separator.ts for the mechanism.
//
// This test pins the CURRENT (undesirable) behaviour on purpose: a real
// test is deleted, and in the same file, in the same diff, an unrelated
// test gains a conditional skip. The added skipIf line's own testCases
// match balances the file's removed-vs-added totals, so the real
// deletion goes unreported. This is a known gap, not a bug -- if this
// assertion ever starts failing because someone "fixed" the counting to
// be per-line, this test's expectation should change to reflect the fix
// its own comments say was intentionally deferred; it should not be
// treated as proof the fix broke something.

test("known gap: an added conditional skip can silently cancel an unrelated real test-case-removed", () => {
  const diff = oneFileDiff(
    "tests/widget.test.ts",
    ["test('subtracts', () => { doSubtract(); });"],
    ["test.skipIf(isCI)('adds', () => { doAdd(); });"],
  );
  const result = separateTestDiff(diff);
  // The deleted "subtracts" test case is real and unrelated to the skip
  // added for "adds", yet no test-case-removed signal fires for it: the
  // testCases bucket's file-wide net count sees one match removed
  // ("test('subtracts', ...)") and one added ("test.skipIf(isCI)('adds',
  // ...)"), and treats them as balanced.
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
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

// --- anchored fragments: false positives cleared, true positives kept -------
//
// A full audit of every weakening rule ran against the real gate and found
// four confirmed false positives on ordinary code, each a bare English word
// or a common standard-library method name: "\bverify\(", "\btest\(",
// "\bshould\b", and "\bdelta\b". Every pattern below is anchored the way
// most fragments in this file already are, and every group first proves the
// false positive is gone, then proves the real weakening it exists to catch
// still fires, in each form a reviewer would recognise as a live framework's
// own syntax -- not a redundant restatement, an independent reproduction.

// "\bshould\b" -> "\.should\b": an ordinary variable named "should" no
// longer reads as an assertion.
test("a plain variable named should does not fire assertion-removed", () => {
  const result = separateTestDiff(
    oneFileDiff("tests/q.test.js", ["  const should = computeExpectation();"], []),
  );
  assert.deepEqual(signalIds(result.signals), []);
});

// Old-style RSpec's dot-chained form, distinct from Chai's ".should.equal"
// already pinned above: same anchor, a different assertion-library user.
test("RSpec's old-style .should matcher still fires assertion-removed", () => {
  const result = separateTestDiff(
    oneFileDiff("spec/widget_spec.rb", ["  person.should.have_valid_email"], []),
  );
  assert.ok(signalIds(result.signals).includes("assertion-removed"));
});

// Finding 1 (confirmed regression): the receiver-only anchor "\.should\b"
// caught Chai and old-style RSpec but dropped should.js, a real BDD
// assertion library with no receiver at all -- "should(value).equal(x)".
// A reviewer built a block with two such assertions, removed one, and got
// no signal; this reproduces that case as a permanent test, through the
// real gate, asserting the signal id, never the regex.
test("should.js's receiverless should(value).equal(x) still fires assertion-removed", () => {
  const diff = diffWithHunk("tests/widget.test.js", [
    "-  should(sum(1, 2)).equal(3);",
    "   should(sum(2, 2)).equal(4);",
  ]);
  const result = separateTestDiff(diff);
  assert.ok(
    signalIds(result.signals).includes("assertion-removed"),
    `expected assertion-removed for should.js, got ${JSON.stringify(signalIds(result.signals))}`,
  );
});

// "\bverify\(" -> a receiver-qualified or a receiverless-but-chained call:
// ordinary domain code calling a function that happens to be named verify no
// longer reads as a mock assertion.
test("an ordinary domain call to verify( does not fire assertion-removed", () => {
  const result = separateTestDiff(
    oneFileDiff("tests/q.test.js", ["  await verify(user.verificationToken);"], []),
  );
  assert.deepEqual(signalIds(result.signals), []);
});

test("verify() with a mock-style assignment but no receiver or chain does not fire assertion-removed", () => {
  // The accepted residual gap named in src/test-diff-separator.ts: a
  // receiverless, unchained call is syntactically identical to the ordinary
  // domain call above, so this one is a documented miss, not a bug -- pinned
  // here as a fact instead of only stated in prose.
  const result = separateTestDiff(oneFileDiff("tests/WidgetTest.java", ["    verify(mockList);"], []));
  assert.deepEqual(signalIds(result.signals), []);
});

test("Mockito/ts-mockito's receiverless, chained verify(mock).method() still fires assertion-removed", () => {
  const result = separateTestDiff(
    oneFileDiff("tests/WidgetTest.java", ["    verify(mockedList).size();"], []),
  );
  assert.ok(signalIds(result.signals).includes("assertion-removed"));
});

test("Moq's receiver-qualified mock.Verify(...) still fires assertion-removed", () => {
  const result = separateTestDiff(
    oneFileDiff("tests/WidgetTests.cs", ["        mock.Verify(x => x.Foo());"], []),
  );
  assert.ok(signalIds(result.signals).includes("assertion-removed"));
});

test("PHP Prophecy's arrow-qualified $prophecy->verify() still fires assertion-removed", () => {
  const result = separateTestDiff(
    oneFileDiff("tests/WidgetTest.php", ["        $prophecy->verify();"], []),
  );
  assert.ok(signalIds(result.signals).includes("assertion-removed"));
});

// "\btest\(" -> a following string or template-literal opener: the standard
// JS/TS RegExp.prototype.test method call no longer reads as a test case.
test("regex.test(input) does not fire test-case-removed", () => {
  const result = separateTestDiff(oneFileDiff("tests/q.test.js", ["  const ok = regex.test(input);"], []));
  assert.deepEqual(signalIds(result.signals), []);
});

test("a deleted template-literal-named test( case still fires test-case-removed", () => {
  const result = separateTestDiff(
    oneFileDiff("tests/widget.test.ts", ["test(`adds ${1} and ${2}`, () => { doAdd(); });"], []),
  );
  assert.ok(signalIds(result.signals).includes("test-case-removed"));
});

// Finding 2 (confirmed regression): the string-literal-only anchor
// "\btest\(\s*[\"'`]" caught Jest/Mocha's "test('name', fn)" but dropped
// Deno's object form, "Deno.test({ name, fn })", which opens with "{" and
// no quote at all. A reviewer removed one of two such test cases and got
// no signal -- hidden in casual testing because a body with an assertion
// call is caught incidentally by the assertions bucket; this case's body
// is a plain helper call on purpose, so nothing but test-case-removed can
// explain the signal.
test("Deno.test({ name, fn }), the object form, still fires test-case-removed", () => {
  const diff = diffWithHunk("tests/widget_test.ts", [
    "-Deno.test({",
    "-  name: \"adds\",",
    "-  fn() {",
    "-    checkAdd();",
    "-  },",
    "-});",
    " Deno.test({",
    "   name: \"subtracts\",",
    "   fn() {",
    "     checkSubtract();",
    "   },",
    " });",
  ]);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["test-case-removed"]);
});

// "\bdelta\b" -> a following ":" or "=" and a numeral: an ordinary
// position-difference variable no longer reads as a loosened tolerance.
test("an ordinary delta variable, changed on both sides, does not fire tolerance-widened", () => {
  const result = separateTestDiff(
    oneFileDiff(
      "tests/q.test.js",
      ["  const delta = nextPos - prevPos;"],
      ["  const delta = nextPos2 - prevPos2;"],
    ),
  );
  assert.deepEqual(signalIds(result.signals), []);
});

test("Python's assertAlmostEqual(..., delta=N) keyword argument still fires tolerance-widened", () => {
  const result = separateTestDiff(
    oneFileDiff(
      "tests/test_widget.py",
      ["self.assertAlmostEqual(want, got, delta=0.01)"],
      ["self.assertAlmostEqual(want, got, delta=0.5)"],
    ),
  );
  assert.ok(signalIds(result.signals).includes("tolerance-widened"));
});

test("an options object's { delta: N } property still fires tolerance-widened", () => {
  const result = separateTestDiff(
    oneFileDiff(
      "tests/q.test.js",
      ["  expect(result).to.be.approximately(5, { delta: 0.001 });"],
      ["  expect(result).to.be.approximately(5, { delta: 0.5 });"],
    ),
  );
  assert.ok(signalIds(result.signals).includes("tolerance-widened"));
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

// Two fragments can each be a perfectly valid regex alone -- the config
// loader's own per-fragment validation would pass both -- and still collide
// once compileRuleSet joins every fragment in a bucket into one alternation.
// A JS engine's own duplicate-name rule used to be strict enough to catch
// this by throwing; that stopped being reliable once the engine started
// permitting a shared name across alternation branches it judges mutually
// exclusive, and what counts as "mutually exclusive" is the engine's call,
// not this project's. compileRuleSet now runs this check itself, ahead of
// ever asking the engine to compile the joined pattern, so the result does
// not depend on which engine version is running it: pinned here as a fact
// the test can fail against, not left resting on prose alone.
test("compileRuleSet rejects two fragments in the same bucket sharing a capture group name", () => {
  const rules: RuleSet = { ...DEFAULT_RULES, skips: ["(?<dup>paused)", "(?<dup>halted)"] };
  assert.throws(() => compileRuleSet(rules), /duplicate capture group name "dup"/);
});

test("the duplicate-capture-group message names the bucket and the group, not a raw engine error", () => {
  const rules: RuleSet = { ...DEFAULT_RULES, tolerance: ["(?<reason>slower)", "(?<reason>faster)"] };
  assert.throws(() => compileRuleSet(rules), (err: unknown) => {
    const message = (err as Error).message;
    assert.match(message, /"reason"/, `expected the group name in the message: ${message}`);
    assert.match(message, /tolerance/, `expected the bucket name in the message: ${message}`);
    assert.doesNotMatch(message, /^\s*at\s/m, `expected a message, not a stack trace: ${message}`);
    return true;
  });
});

test("the same capture group name in two DIFFERENT buckets is not a collision", () => {
  // Each bucket compiles to its own separate RegExp (see compileRuleSet),
  // so a name repeated across buckets never lands in the same alternation
  // and never collides, however the engine treats it.
  const rules: RuleSet = { ...DEFAULT_RULES, skips: ["(?<flag>paused)"], tolerance: ["(?<flag>loose)"] };
  assert.doesNotThrow(() => compileRuleSet(rules));
});

test("a capture group name repeated in one fragment's own alternation is flagged by our own check, not left to the engine", () => {
  // (?<n>a)|(?<n>b) inside a SINGLE fragment string used to be an invalid
  // regex on its own, on every engine: two branches of one alternation
  // declaring the same name twice. That stopped being reliable once the
  // engine started permitting a shared name across alternation branches it
  // judges mutually exclusive, which now includes this single-fragment
  // case too. compileRuleSet no longer depends on the engine to catch this;
  // it flags the repeat itself, ahead of ever compiling the joined
  // pattern, so the result does not depend on which engine version runs it.
  const rules: RuleSet = { ...DEFAULT_RULES, skips: ["(?<n>a)|(?<n>b)"] };
  assert.throws(() => compileRuleSet(rules), /duplicate capture group name "n"/);
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

// Finding 3: no behaviour change here, only a sharpened comment on
// cfgTestRegionMask -- but the comment now claims a wider blast radius than
// before, so it earns a test pinning the actual behaviour as fact. When a
// #[cfg(test)] region opens but its closing brace sits outside the diff
// (the module's own body is far below the hunk's context window), the
// region is never marked closed, and every later hunk in the SAME FILE's
// diff -- not just the rest of the opening hunk -- reads as test content.
// Here that sweeps in an actually separate, unrelated production function
// forty-plus lines later, in its own hunk, and reports its removed
// assert! as a weakening. This is the accepted, pre-existing gap the
// comment above cfgTestRegionMask now describes; it is not fixed here.
test("an unclosed #[cfg(test)] region sweeps in an unrelated assertion from a later, separate hunk (accepted gap, not a bug)", () => {
  const diff = [
    "diff --git a/src/pricing.rs b/src/pricing.rs",
    "index 1111111..2222222 100644",
    "--- a/src/pricing.rs",
    "+++ b/src/pricing.rs",
    "@@ -10,3 +10,3 @@",
    " #[cfg(test)]",
    " mod tests {",
    "-    fn helper_stub() {}",
    "+    fn helper_stub_v2() {}",
    "@@ -60,3 +60,3 @@",
    " fn compute_price(x: i32) -> i32 {",
    "-    assert!(x > 0);",
    "+    // assert removed here, in a totally unrelated function",
    " }",
    "",
  ].join("\n");
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["assertion-removed"]);
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
    "-        assert_eq!(n, 100);",
    "+        assert_eq!(n, 110);",
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
  // assert_eq!(n, 100) below sat outside the mask and reported nothing.
  // stripRustNoiseForBraceCounting now removes a same-line /* ... */
  // block comment before brace counting runs, so the region should still
  // extend to the module's real closing brace.
  const diff = diffWithHunk("src/pricing.rs", [
    ' #[cfg(all(test, feature = "x"))]',
    " mod tests {",
    "     /* a comment with a } inside */",
    "     fn check(n: i64) {",
    "-        assert_eq!(n, 100);",
    "+        assert_eq!(n, 110);",
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
    "-        assert_eq!(n, 100);",
    "+        assert_eq!(n, 110);",
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
    "-        assert_eq!(n, 100);",
    "+        assert_eq!(n, 110);",
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

// --- Finding 1: the skips bucket's premise (test files only) is false for Rust ---
//
// hasRustTestMarker fires on an actual test-declaring attribute
// (#[cfg(test)], #[test], or #[whatever::test]) ANYWHERE in a .rs file's
// diff, including a context line, and when it fires the WHOLE file's diff
// runs through every check in signalsForTestFile -- not only the
// #[cfg(test)] region itself. RUST_TEST_MARKER_RE used to also treat a
// bare assert!/assert_eq!/assert_ne! call as such a marker, and a reviewer
// reproduced a false skip-added on production Rust code from exactly
// that: a .rs file classified as SOURCE, carrying an ordinary
// Iterator::skip call, fired skip-added solely because an unrelated
// assert! elsewhere in the same file made hasRustTestMarker true. That
// specific trigger is gone now that the marker is narrowed to attribute
// forms only (a bare assert! with no attribute marker falls through to
// cfgTestRegionMask instead, which scans only the test module's own
// region -- see the tests below this section). But the whole-file scan
// itself is not gone: a real #[cfg(test)] module elsewhere in the file
// still makes hasRustTestMarker true and still sends the WHOLE file's
// diff through this bucket, ordinary source code included, so the
// exclusion below still matters. See RUST_EXCLUDED_SKIP_FRAGMENTS
// in src/test-diff-separator.ts for the fix and its own reasoning.

test("Finding 1's reproduction: an ordinary items.skip(n) in Rust source no longer fires skip-added, even though a real #[cfg(test)] module elsewhere makes the whole file's diff get scanned", () => {
  const diff = diffWithHunk("src/pricing.rs", [
    " #[cfg(test)]",
    " mod other_tests {}",
    " ",
    " fn first_n(items: &[i64], n: usize) -> Vec<i64> {",
    "-    items.to_vec()",
    "+    items.iter().skip(n).cloned().collect()",
    " }",
  ]);
  const result = separateTestDiff(diff);
  assert.deepEqual(result.signals, []);
  assert.deepEqual(
    result.sourceFiles.map((f) => f.path),
    ["src/pricing.rs"],
  );
});

test("a struct-literal 'skip:' field in Rust source no longer fires skip-added under the same whole-file scan", () => {
  // Rust's field-init shorthand uses a bare colon, the same form RSpec's
  // "skip: true" metadata now deliberately fires on (Finding 2) -- and
  // this is exactly why that new fragment is excluded for .rs too, not
  // only the pre-existing ".skip(" one.
  const diff = diffWithHunk("src/pricing.rs", [
    " #[cfg(test)]",
    " mod other_tests {}",
    " ",
    "+struct Query { skip: bool, limit: i64 }",
  ]);
  const result = separateTestDiff(diff);
  assert.deepEqual(result.signals, []);
});

test("the assignment form 'skip = ...' in Rust source no longer fires skip-added under the same whole-file scan", () => {
  // The half the original exclusion missed: "let skip = offset + 1;" in a
  // pagination helper, reported skip-added with "confirm this test was not
  // disabled to reach green" -- plainly wrong for a plain local binding.
  const diff = diffWithHunk("src/pricing.rs", [
    " #[cfg(test)]",
    " mod other_tests {}",
    " ",
    "+fn paginate(offset: i64) -> i64 {",
    "+    let skip = offset + 1;",
    "+    skip",
    "+}",
  ]);
  const result = separateTestDiff(diff);
  assert.deepEqual(result.signals, []);
});

test("a struct-literal 'ignore:' field in Rust source no longer fires skip-added under the same whole-file scan", () => {
  // Widening the Deno "ignore:" fragment past the literal word "true"
  // (Finding 1) reopened the exact same struct-literal false positive
  // "skip:" and "pending:" were already excluded for, so "ignore:" was
  // added to RUST_EXCLUDED_SKIP_FRAGMENTS at the same time, not left for a
  // reviewer to reproduce separately.
  const diff = diffWithHunk("src/pricing.rs", [
    " #[cfg(test)]",
    " mod other_tests {}",
    " ",
    "+struct Filter { ignore: bool, threshold: i64 }",
  ]);
  const result = separateTestDiff(diff);
  assert.deepEqual(result.signals, []);
});

test("a real Rust test disable, #[ignore], still fires skip-added even under the .rs exclusion", () => {
  // The exclusion is narrow: it removes only the two fragments proven to
  // misfire on ordinary Rust source (see the comment on
  // RUST_EXCLUDED_SKIP_FRAGMENTS), not the whole skips bucket. Rust's own
  // idiom for disabling a test, #[ignore], must still fire.
  const diff = diffWithHunk("src/pricing.rs", [
    " #[cfg(test)]",
    " mod tests {",
    "     #[test]",
    "+    #[ignore]",
    "     fn applies_discount() {",
    "         assert_eq!(discount(120), 110);",
    "     }",
    " }",
  ]);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

test("an ordinary .skip( call inside the #[cfg(test)] region itself is also excluded on .rs, not only outside it", () => {
  // The exclusion applies to every .rs file, whichever path found it a
  // test region through (the whole-file marker or the region mask), since
  // Rust simply does not use a skip call to disable a test either way.
  const diff = diffWithHunk("src/pricing.rs", [
    ' #[cfg(all(test, feature = "flaky"))]',
    " mod tests {",
    "     fn helper(items: &[i64]) -> Vec<i64> {",
    "-        items.to_vec()",
    "+        items.iter().skip(1).cloned().collect()",
    "     }",
    " }",
  ]);
  const result = separateTestDiff(diff);
  assert.deepEqual(result.signals, []);
});

test("the .rs exclusion does not leak into other languages: .skip( still fires skip-added everywhere else", () => {
  const diff = oneFileDiff("tests/widget.test.ts", [], ["it.skip('adds', () => {});"]);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
});

// --- The fixtures marker ------------------------------------------------------
//
// Every test below asserts an observable outcome of separateTestDiff: the
// signal list, the test-half classification and counts, or the exempt list
// the report and the JSON both print.

const MARKED_PATH = "tests/holder.test.ts";

/** A one-line skip addition: enough to trip skip-added on its own. */
const SKIP_DIFF = oneFileDiff(MARKED_PATH, [], ["  test.skip('placeholder', () => {});"]);

function readerFor(text: string | undefined): (path: string) => string | undefined {
  return (path) => (path === MARKED_PATH ? text : undefined);
}

/** The marker at the top of a file, in whichever comment form is asked for. */
function fileWithMarker(form: "line" | "hash" | "block"): string {
  const body = ["const x = 1;", "const y = 2;"];
  if (form === "line") return [`// ${FIXTURE_MARKER}`, ...body].join("\n");
  if (form === "hash") return [`# ${FIXTURE_MARKER}`, ...body].join("\n");
  return ["/*", ` * ${FIXTURE_MARKER}`, " */", ...body].join("\n");
}

test("the marker suppresses signals for its file; the same file without it produces them", () => {
  const marked = separateTestDiff(SKIP_DIFF, { readFileText: readerFor(fileWithMarker("line")) });
  assert.deepEqual(signalIds(marked.signals), []);
  assert.deepEqual(marked.exemptFiles, [MARKED_PATH]);
  assert.equal(marked.exemptCount, 1);

  const unmarked = separateTestDiff(SKIP_DIFF, { readFileText: readerFor("const x = 1;\n") });
  assert.deepEqual(signalIds(unmarked.signals), ["skip-added"]);
  assert.deepEqual(unmarked.exemptFiles, []);
  assert.equal(unmarked.exemptCount, 0);
});

test("with no way to read the file at all, nothing is exempt", () => {
  const result = separateTestDiff(SKIP_DIFF);
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
  assert.deepEqual(result.exemptFiles, []);
  assert.equal(result.exemptCount, 0);
});

test("the marker is honoured in a //, a #, and a /* */ comment", () => {
  for (const form of ["line", "hash", "block"] as const) {
    const result = separateTestDiff(SKIP_DIFF, { readFileText: readerFor(fileWithMarker(form)) });
    assert.deepEqual(signalIds(result.signals), [], `${form} comment should suppress`);
    assert.deepEqual(result.exemptFiles, [MARKED_PATH], `${form} comment should exempt the file`);
  }
});

test("the marker on line 20 is honoured and on line 21 is not", () => {
  const filler = (n: number) => Array.from({ length: n }, (_, i) => `const v${i} = ${i};`);

  const onLine20 = [...filler(19), `// ${FIXTURE_MARKER}`].join("\n");
  const inTime = separateTestDiff(SKIP_DIFF, { readFileText: readerFor(onLine20) });
  assert.deepEqual(signalIds(inTime.signals), []);
  assert.deepEqual(inTime.exemptFiles, [MARKED_PATH]);

  const onLine21 = [...filler(20), `// ${FIXTURE_MARKER}`].join("\n");
  const tooLate = separateTestDiff(SKIP_DIFF, { readFileText: readerFor(onLine21) });
  assert.deepEqual(signalIds(tooLate.signals), ["skip-added"]);
  assert.deepEqual(tooLate.exemptFiles, []);
});

test("the marker outside a comment, in code or in a string, is not honoured", () => {
  const notComments = [
    `${FIXTURE_MARKER}`,
    `const marker = "${FIXTURE_MARKER}";`,
    `const marker = "// ${FIXTURE_MARKER}";`,
    `const marker = '# ${FIXTURE_MARKER}';`,
    "const marker = `/* " + FIXTURE_MARKER + " */`;",
  ];
  for (const line of notComments) {
    const result = separateTestDiff(SKIP_DIFF, { readFileText: readerFor(`${line}\nconst x = 1;\n`) });
    assert.deepEqual(signalIds(result.signals), ["skip-added"], `should not be honoured: ${line}`);
    assert.deepEqual(result.exemptFiles, [], `should not be exempt: ${line}`);
  }
});

test("hasFixtureMarker agrees on each of those forms directly", () => {
  assert.equal(hasFixtureMarker(fileWithMarker("line")), true);
  assert.equal(hasFixtureMarker(fileWithMarker("hash")), true);
  assert.equal(hasFixtureMarker(fileWithMarker("block")), true);
  assert.equal(hasFixtureMarker(`const m = "${FIXTURE_MARKER}";`), false);
  assert.equal(hasFixtureMarker("// nothing here\n"), false);
});

test("a marked file is still a test file, in the test half, with its own counts", () => {
  const diff = oneFileDiff(
    MARKED_PATH,
    ["  expect(sum(1, 2)).toBe(3);", "  expect(sum(2, 2)).toBe(4);"],
    ["  test.skip('placeholder', () => {});"],
  );
  const result = separateTestDiff(diff, { readFileText: readerFor(fileWithMarker("line")) });
  assert.deepEqual(
    result.testFiles,
    [{ path: MARKED_PATH, added: 1, removed: 2 }],
    "the marked file stays in the test half with its real counts",
  );
  assert.deepEqual(result.sourceFiles, []);
  assert.equal(result.testAdded, 1);
  assert.equal(result.testRemoved, 2);
  assert.deepEqual(signalIds(result.signals), []);
});

test("the marker suppresses one file only, never another file in the same diff", () => {
  const other = "tests/other.test.ts";
  const diff =
    SKIP_DIFF + oneFileDiff(other, [], ["  test.skip('also placeholder', () => {});"]);
  const result = separateTestDiff(diff, { readFileText: readerFor(fileWithMarker("line")) });
  assert.deepEqual(signalIds(result.signals), ["skip-added"]);
  assert.equal(result.signals[0].file, other);
  assert.deepEqual(result.exemptFiles, [MARKED_PATH]);
  assert.equal(result.exemptCount, 1);
});

test("a source file carrying the marker is not listed as exempt: it faced no check", () => {
  const sourcePath = "src/widget.ts";
  const diff = oneFileDiff(sourcePath, ["return a + b;"], ["return a - b;"]);
  const result = separateTestDiff(diff, {
    readFileText: (path) => (path === sourcePath ? fileWithMarker("line") : undefined),
  });
  assert.deepEqual(result.exemptFiles, []);
  assert.equal(result.exemptCount, 0);
  assert.deepEqual(signalIds(result.signals), []);
});

// --- Inventory: which files in this repository carry the marker ---------------
//
// The exemption spreads quietly or not at all. This test names every file
// allowed to carry it, so adding a third puts the decision in front of a
// person instead of letting it pass with a green run.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const MARKER_HOLDERS = ["tests/test-diff-separator-cli.test.ts", "tests/test-diff-separator.test.ts"];

test("exactly the two declared fixture files in this repository carry the marker", () => {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\0")
    .filter((path) => path !== "");
  assert.ok(tracked.length > 0, "git ls-files returned nothing; the inventory would pass vacuously");

  const carrying = tracked.filter((path) => {
    let text: string;
    try {
      text = readFileSync(join(REPO_ROOT, path), "utf8");
    } catch {
      return false;
    }
    return hasFixtureMarker(text);
  });

  assert.deepEqual(
    carrying.sort(),
    MARKER_HOLDERS,
    "a file gained or lost the fixtures marker; a person has to decide whether that exemption is warranted",
  );
});


// --- Masking: a detector word inside a literal is not a signal ---------------
//
// Every pattern is tested against the line with its strings, templates,
// regular expressions, and trailing comments blanked out (src/code-mask.ts).
// A fixture string and a test's own name stop firing; real code does not.
// The lines in the first block are real ones, taken from the false positives
// this repository's own history produced before the mask went in.

test("a detector word inside a fixture string is not a timeout change", () => {
  const diff = oneFileDiff(
    "tests/induce.test.ts",
    ['    command: "pytest -k retries",'],
    ['    command: "NO_RETRY=1 pytest -k retries",'],
  );
  assert.deepEqual(signalIds(separateTestDiff(diff).signals), []);
});

test("a detector word inside a regex literal is not a timeout change", () => {
  const diff = oneFileDiff(
    "tests/induce.test.ts",
    ["      assert.doesNotMatch(text, /hit the timeout/);"],
    ["      assert.doesNotMatch(killedText, /hit the timeout/);"],
  );
  assert.deepEqual(signalIds(separateTestDiff(diff).signals), []);
});

test("a detector word inside a test's own name is not a timeout change", () => {
  const diff = oneFileDiff(
    "tests/induce.test.ts",
    ['test("could-not-run: a baseline that timed out keeps the reason", () => {'],
    ['test("could-not-run: a baseline that timed out keeps the timeout reason and exit 3", () => {'],
  );
  assert.deepEqual(signalIds(separateTestDiff(diff).signals), []);
});

test("a skip written inside a fixture string is not a skip added", () => {
  const diff = oneFileDiff(
    "tests/census.test.ts",
    [],
    ['      <skipped type="pytest.skip" message="not today"/>'],
  );
  assert.deepEqual(signalIds(separateTestDiff(diff).signals), []);
});

test("a skip word inside a single quote, a double quote, a template, or a regex is ignored", () => {
  const diff = oneFileDiff("tests/holder.test.ts", [], [
    "  const a = 'it.skip me';",
    '  const b = "it.skip me";',
    "  const c = `it.skip me`;",
    "  const d = /it\\.skip/;",
  ]);
  assert.deepEqual(signalIds(separateTestDiff(diff).signals), []);
});

test("a skip word inside a template's ${...} expression is ignored too", () => {
  // Pinned as the mask has it, not as it might be: a template literal is
  // skipped whole, so an interpolated expression is blanked along with the
  // text around it. A signal is lost there and none is invented.
  const diff = oneFileDiff("tests/holder.test.ts", [], ["  const s = `${it.skip(1)}`;"]);
  assert.deepEqual(signalIds(separateTestDiff(diff).signals), []);
});

test("a real skip, a real assertion swap, and a real timeout change all still fire", () => {
  const skip = oneFileDiff("tests/holder.test.ts", [], ['  it.skip("a real skip", () => {});']);
  assert.deepEqual(signalIds(separateTestDiff(skip).signals), ["skip-added"]);

  const swap = oneFileDiff(
    "tests/holder.test.ts",
    ["  assert.equal(shipping(two), 0);"],
    ["  assert.ok(shipping(two));"],
  );
  assert.deepEqual(signalIds(separateTestDiff(swap).signals), ["assertion-weakened"]);

  const timeout = oneFileDiff("tests/holder.test.ts", ["  timeout: 5000,"], ["  timeout: 20000,"]);
  assert.deepEqual(signalIds(separateTestDiff(timeout).signals), ["timeout-raised"]);
});

test("a signal reports the original line, never the masked one", () => {
  const line = '  it.skip("a real skip", () => {});';
  const signals = separateTestDiff(oneFileDiff("tests/holder.test.ts", [], [line])).signals;
  assert.equal(signals.length, 1);
  assert.equal(signals[0].line, line, "the reported line must carry the test's real name");
});

test("an assertion swap reports both original lines, strings and all", () => {
  const gone = '  assert.equal(order.state, "shipped");';
  const now = "  assert.ok(order.state);";
  const signals = separateTestDiff(oneFileDiff("tests/holder.test.ts", [gone], [now])).signals;
  assert.equal(signals.length, 1);
  assert.equal(signals[0].line, `${gone.trim()}  ->  ${now.trim()}`);
});

test("a string that opened on an earlier line is not seen: the known limit", () => {
  // The bound, recorded and not merely described. The middle line is string
  // text in its real file, but the mask reads one line at a time and that
  // line carries no backtick of its own, so the skip still fires. A test
  // file where this is common wants the fixtures marker instead.
  const diff = oneFileDiff("tests/holder.test.ts", [], [
    "  const src = `",
    '    it.skip("x");',
    "  `;",
  ]);
  const signals = separateTestDiff(diff).signals;
  assert.deepEqual(signalIds(signals), ["skip-added"]);
  assert.equal(signals[0].line, '    it.skip("x");');
});

// --- Phase: whole-file mask context (readWholeFile) -------------------------
//
// The same known limit above, closed for a caller that can supply the
// file. oneFileDiff's hunk always opens at line 1 on both sides (see its
// own "@@ -1,N +1,M @@"), so a reader that hands back exactly the added
// (or removed) lines, joined with newlines, is the whole file the diff
// itself describes -- convenient for a test, and also exactly what a real
// git-backed reader would return for a brand new file.

function wholeFileReaderFor(sideToText: Partial<Record<"old" | "new", string>>): (path: string, side: "old" | "new") => string | undefined {
  return (_path, side) => sideToText[side];
}

test("with a whole-file reader, a string that opened on an earlier line IS seen", () => {
  const lines = ["  const src = `", '    it.skip("x");', "  `;"];
  const diff = oneFileDiff("tests/holder.test.ts", [], lines);
  const signals = separateTestDiff(diff, { readWholeFile: wholeFileReaderFor({ new: lines.join("\n") }) }).signals;
  assert.deepEqual(signalIds(signals), [], "the middle line is inside the template literal in its real file");
});

test("a removed line is masked from the OLD side: a removed assertion inside a template literal is not falsely reported", () => {
  const lines = ["  const src = `", "    assert.ok(x);", "  `;"];
  const diff = oneFileDiff("tests/holder.test.ts", lines, []);
  const signals = separateTestDiff(diff, { readWholeFile: wholeFileReaderFor({ old: lines.join("\n") }) }).signals;
  assert.deepEqual(signalIds(signals), [], "the removed line is fixture text in the file it was removed from");
});

test("a removed line is masked from the OLD side: a real removed assertion is still reported", () => {
  const diff = oneFileDiff("tests/holder.test.ts", ["  assert.ok(x);"], []);
  // The old side is a whole file with nothing around the assertion to mask
  // it; supplying it must not somehow make a real removal disappear.
  const signals = separateTestDiff(diff, { readWholeFile: wholeFileReaderFor({ old: "  assert.ok(x);\n" }) }).signals;
  assert.deepEqual(signalIds(signals), ["assertion-removed"]);
});

test("a new file has no old side to read: readWholeFile('old', ...) is never even asked for one, and added lines still mask from the new side", () => {
  const lines = ["  const src = `", '    it.skip("x");', "  `;"];
  const diff = oneFileDiff("tests/holder.test.ts", [], lines);
  let oldRequested = false;
  const reader = (_path: string, side: "old" | "new"): string | undefined => {
    if (side === "old") {
      oldRequested = true;
      return undefined; // a brand new file: nothing to read on the old side
    }
    return lines.join("\n");
  };
  const signals = separateTestDiff(diff, { readWholeFile: reader }).signals;
  assert.deepEqual(signalIds(signals), []);
  assert.equal(oldRequested, false, "a file with no removed lines never asks for its old side");
});

test("a stale reader (its line does not match the diff's own line) falls back to per-line masking instead of misapplying another line's mask", () => {
  const lines = ["  const src = `", '    it.skip("x");', "  `;"];
  const diff = oneFileDiff("tests/holder.test.ts", [], lines);
  // The reader hands back completely different content than the diff
  // itself carries -- as if the working tree moved on since the diff was
  // captured. The line-content check in maskDiffLine must refuse this and
  // mask the diff's own line alone, which still finds the real skip.
  const staleText = ["  const other = 1;", "  const another = 2;", "  const third = 3;"].join("\n");
  const signals = separateTestDiff(diff, { readWholeFile: wholeFileReaderFor({ new: staleText }) }).signals;
  assert.deepEqual(signalIds(signals), ["skip-added"], "a stale whole-file read must not hide a real signal");
});

test("a renamed file reads its old side from the OLD path and its new side from the NEW path", () => {
  const path = "tests/renamed.test.ts";
  const oldPath = "tests/original.test.ts";
  const diffLines = [
    `diff --git a/${oldPath} b/${path}`,
    `similarity index 90%`,
    `rename from ${oldPath}`,
    `rename to ${path}`,
    `index 1111111..2222222 100644`,
    `--- a/${oldPath}`,
    `+++ b/${path}`,
    `@@ -1,3 +1,3 @@`,
    " const src = `",
    '-  it.skip("old");',
    '+  it.skip("new");',
    " `;",
  ];
  const diff = `${diffLines.join("\n")}\n`;
  const requestedPaths: Array<{ path: string; side: string }> = [];
  const reader = (p: string, side: "old" | "new"): string | undefined => {
    requestedPaths.push({ path: p, side });
    const body = side === "old" ? ["const src = `", '  it.skip("old");', "`;"] : ["const src = `", '  it.skip("new");', "`;"];
    return body.join("\n");
  };
  const signals = separateTestDiff(diff, { readWholeFile: reader }).signals;
  assert.deepEqual(signalIds(signals), [], "both the removed and added skip are template text in their own file");
  assert.ok(requestedPaths.some((r) => r.path === oldPath && r.side === "old"), "the old side is read from the pre-rename path");
  assert.ok(requestedPaths.some((r) => r.path === path && r.side === "new"), "the new side is read from the post-rename path");
});

test("no readWholeFile option at all behaves exactly as before this phase: per-line masking, unconditionally", () => {
  const lines = ["  const src = `", '    it.skip("x");', "  `;"];
  const diff = oneFileDiff("tests/holder.test.ts", [], lines);
  const signals = separateTestDiff(diff).signals;
  assert.deepEqual(signalIds(signals), ["skip-added"], "omitting the option is the same as never having it");
});

// --- Finding 3: wholeFileMaskFallbackCount -----------------------------------
//
// The whole-file mask is safe (see the stale-reader test above: it never
// misapplies another line's mask), but until this field existed, nothing
// said when that safety net actually fired. It must be non-zero whenever a
// caller supplied a reader and this run still fell back to per-line masking
// for some line -- a stale read, or a missing answer for a side the reader
// was supposed to cover -- and exactly zero on a clean run, whether or not
// a reader was supplied at all.

test("wholeFileMaskFallbackCount is zero with no readWholeFile option at all: that is the documented behaviour, not a degradation", () => {
  const lines = ["  const src = `", '    it.skip("x");', "  `;"];
  const diff = oneFileDiff("tests/holder.test.ts", [], lines);
  const result = separateTestDiff(diff);
  assert.equal(result.wholeFileMaskFallbackCount, 0);
});

test("wholeFileMaskFallbackCount is zero on a clean run: a reader supplied and every line's whole-file answer matches", () => {
  const lines = ["  const src = `", '    it.skip("x");', "  `;"];
  const diff = oneFileDiff("tests/holder.test.ts", [], lines);
  const result = separateTestDiff(diff, { readWholeFile: wholeFileReaderFor({ new: lines.join("\n") }) });
  assert.equal(result.wholeFileMaskFallbackCount, 0);
});

test("wholeFileMaskFallbackCount counts a stale reader's line falling back to per-line masking", () => {
  const lines = ["  const src = `", '    it.skip("x");', "  `;"];
  const diff = oneFileDiff("tests/holder.test.ts", [], lines);
  // Same stale reader as the test above this section: the reader hands
  // back content that does not match the diff's own lines, as if the
  // working tree (or the revision resolved) moved on since the diff was
  // captured -- the exact git-plumbing misconfiguration Finding 3 named.
  const staleText = ["  const other = 1;", "  const another = 2;", "  const third = 3;"].join("\n");
  const result = separateTestDiff(diff, { readWholeFile: wholeFileReaderFor({ new: staleText }) });
  assert.equal(result.wholeFileMaskFallbackCount, lines.length, "every added line's whole-file answer was stale");
});

test("wholeFileMaskFallbackCount counts a line whose side the reader was supposed to cover but answered nothing for", () => {
  // Unlike the brand-new-file case (where the old side is never even
  // asked for), this file HAS removed lines, so the old side is wanted --
  // but the reader still answers undefined for it, as a misconfigured git
  // call (the wrong revision, a repository the process cannot reach) would.
  const diff = oneFileDiff("tests/holder.test.ts", ["  assert.ok(x);"], []);
  const reader = (_path: string, side: "old" | "new"): string | undefined => (side === "old" ? undefined : undefined);
  const result = separateTestDiff(diff, { readWholeFile: reader });
  assert.equal(result.wholeFileMaskFallbackCount, 1);
  // The real removal is still found through the per-line fallback: the
  // safety net this field counts the use of never hides a real signal.
  assert.deepEqual(signalIds(result.signals), ["assertion-removed"]);
});

test("wholeFileMaskFallbackCount does not count a side that was never requested in the first place", () => {
  // A brand new file's old side is never asked for at all (see the test
  // above this section), so there is nothing here for the fallback to
  // count: this is not a reader failing to answer, it is a side that was
  // never wanted.
  const lines = ["  const src = `", '    it.skip("x");', "  `;"];
  const diff = oneFileDiff("tests/holder.test.ts", [], lines);
  const reader = (_path: string, side: "old" | "new"): string | undefined => (side === "old" ? undefined : lines.join("\n"));
  const result = separateTestDiff(diff, { readWholeFile: reader });
  assert.equal(result.wholeFileMaskFallbackCount, 0);
});

test("a Rust attribute is code, so the mask leaves the Rust marker paths alone", () => {
  const diff = oneFileDiff("src/order.rs", [], [
    "#[cfg(test)]",
    "mod tests {",
    "    #[test]",
    "    fn totals() {",
    "        assert_eq!(total(), 3);",
    "        #[ignore]",
    "    }",
    "}",
  ]);
  const result = separateTestDiff(diff);
  assert.ok(signalIds(result.signals).includes("skip-added"), "#[ignore] is an attribute, not a string");
});

test("a Rust marker written inside a string no longer classifies the file as a test", () => {
  const diff = oneFileDiff("src/order.rs", [], ['    let hint = "assert_eq!(total, 3)";']);
  const result = separateTestDiff(diff);
  assert.deepEqual(result.testFiles, [], "a string mentioning a Rust assertion is not a test marker");
  assert.deepEqual(signalIds(result.signals), []);
});

test("the whole-line comment check still runs on the raw line, before the mask", () => {
  // A leading block comment makes the whole line a comment line here, as it
  // did before the mask went in. Masking first would blank the comment away
  // and leave a bare skip behind, so the order of the two checks is what
  // this pins: comment check first, mask after.
  const diff = oneFileDiff("tests/holder.test.ts", [], ['  /* setup */ it.skip("x", () => {});']);
  assert.deepEqual(signalIds(separateTestDiff(diff).signals), []);
});

test("the removed line of a weakening pair is judged on its masked half", () => {
  // The removed line names a weak assertion inside a string. Read raw, that
  // string makes the line look like it was already weak, and the pair is
  // dropped before it can report. Read masked, it is the strong check it
  // really is and the swap is reported.
  const diff = oneFileDiff(
    "tests/holder.test.ts",
    ['  assert.equal(msg, "assert.ok(x)");'],
    ["  assert.ok(msg);"],
  );
  assert.deepEqual(signalIds(separateTestDiff(diff).signals), ["assertion-weakened"]);
});

test("the added line of a weakening pair is judged on its masked half", () => {
  // Read raw, the added line's fixture string makes it look like a weaker
  // assertion arrived to replace the removed one. Read masked, nothing
  // weaker arrived and there is nothing to report.
  const diff = oneFileDiff(
    "tests/holder.test.ts",
    ["  assert.equal(total, 3);"],
    ['  assert.deepStrictEqual(log, ["assert.ok(x)"]);'],
  );
  assert.deepEqual(signalIds(separateTestDiff(diff).signals), []);
});

test("the double-report guard on a changed value is judged on the masked half", () => {
  // The guard drops an assertion-weakened report when the same edit already
  // has a tolerance or timeout report of its own. Here the word "timeout" is
  // only a string, no timeout signal is coming, and the guard must not fire.
  const diff = oneFileDiff(
    "tests/holder.test.ts",
    ['  assert.equal(label, "timeout");'],
    ['  assert.equal(label, "deadline");'],
  );
  assert.deepEqual(signalIds(separateTestDiff(diff).signals), ["assertion-weakened"]);
});

test("a #[cfg(test)] written inside a Rust string opens no test region", () => {
  // Without the mask on this read, the string below opens a region, the
  // string on the next line is taken for its `mod` opener, and the real
  // #[ignore] that follows gets reported as a skip added to a test.
  const diff = oneFileDiff("src/order.rs", [], [
    '    let doc = "#[cfg(test)]";',
    '    let opener = "mod tests {";',
    "    #[ignore]",
  ]);
  const result = separateTestDiff(diff);
  assert.deepEqual(result.testFiles, []);
  assert.deepEqual(signalIds(result.signals), []);
});

// --- Finding 6: an unwarmed .py request silently uses the wrong mask -----------
//
// A removed line whose real code carries no assertion at all, only a
// trailing "#" comment that happens to say "assert": the regex scanner
// does not know the "#" comment form (see src/code-mask.ts's own header),
// so unwarmed it reads that comment as code and reports a real assertion
// gone. The tree-sitter service knows the comment for what it is and masks
// it away, so warmed first, the same diff reports nothing. This is the gap
// src/agent-adapter.ts's runTestDiffGate used to fall into silently before
// it was moved onto separateTestDiffWarmed.

test("Finding 6: unwarmed, a trailing '#' comment's word counts as a real assertion, and the run records that it degraded", () => {
  const diff = oneFileDiff("tests/test_thing.py", ["    result = compute()  # assert result == 42"], []);
  const result = separateTestDiff(diff);
  assert.deepEqual(signalIds(result.signals), ["assertion-removed"]);
  assert.deepEqual(result.unwarmedExtensions, [".py"]);
});

test("Finding 6: warmed first, the same diff reports nothing and the run is not marked degraded", async () => {
  const diff = oneFileDiff("tests/test_thing.py", ["    result = compute()  # assert result == 42"], []);
  const result = await separateTestDiffWarmed(diff);
  assert.deepEqual(signalIds(result.signals), []);
  assert.deepEqual(result.unwarmedExtensions, []);
});

// --- reviewer finding: a throw between reset and read must not poison later calls ---
//
// separateTestDiff resets the module-level unwarmed-access flag before its
// own work and reads it back after, relying on itself staying synchronous
// so nothing else can run in between. An earlier version had no try/catch
// around that body: an exception thrown mid-batch (readFileText throwing,
// most plausibly) left the reset's batch open forever, since the read that
// would have closed it never ran. Every later call, however unrelated,
// then failed its own reset with "called again before the previous
// batch's read", permanently, for the rest of the process -- worse than
// the silent blur the guard exists to catch, since src/mcp-server.ts calls
// this many times in one long-lived process.

test("a throw between reset and read closes the batch instead of poisoning every later call", () => {
  const diff = oneFileDiff("tests/test_thing.py", ["    assert result == 42"], []);

  const ok = separateTestDiff(diff);
  assert.equal(Array.isArray(ok.unwarmedExtensions), true, "an ordinary call still works");

  assert.throws(
    () =>
      separateTestDiff(diff, {
        readFileText: () => {
          throw new Error("simulated failure mid-batch");
        },
      }),
    /simulated failure mid-batch/,
    "the original error still reaches this call's own caller",
  );

  // The real assertion: two calls after the throw, with ordinary
  // arguments, must both succeed instead of failing on the re-entrancy
  // guard for a batch nothing ever closed.
  const after1 = separateTestDiff(diff);
  assert.equal(Array.isArray(after1.unwarmedExtensions), true, "not poisoned by the earlier throw");
  const after2 = separateTestDiff(diff);
  assert.equal(Array.isArray(after2.unwarmedExtensions), true, "still not poisoned on a second call after that");
});

// --- PHP `text` (raw HTML): why it is never masked, checked at the gate itself ---
//
// src/tree-sitter-language-service.ts's own file header has the full
// account of three rounds that each tried a different answer for PHP's
// `text` node and each made something worse. The short version, checked
// directly here: the gate calls maskNonCode ONE DIFF LINE AT A TIME (see
// `matching` in src/test-diff-separator.ts), never a whole file, so any fix
// that needs to remember something from an earlier line -- "a <script> tag
// opened up above" -- cannot work here even if it works against a
// whole-file corpus. Both directions were tried and both are unsafe per
// line; this project keeps the one whose failure is visible in a diff
// instead of invisible. The three tests below pin that choice, not endorse
// it -- see each one's own name and comment.

// KNOWN LIMITATION (HIGH false positive), pinned, not desired: PHP's `text`
// stays unmasked, so an ordinary documentation line quoting an assertion's
// own call form as prose reads as a live assertion, and editing only the
// literal in it -- a status code in a comment, nothing about test behavior
// -- trips this project's own gate. A human reading the diff can dismiss
// it; an automated caller cannot, which is the accepted cost of never
// hiding a real assertion instead. If this test ever starts asserting an
// empty signal list, `text` masking changed and this comment is stale, not
// proof the limitation is gone -- confirm against a real multi-line
// <script> block (the test below) before believing it.
test("known limitation: an ordinary PHP documentation line naming an assertion's call form can trip the gate on an unrelated literal edit", async () => {
  const diff = oneFileDiff(
    "tests/LoginTest.php",
    ["        Usage: assert.strictEqual(response.code, 200); matches the API docs."],
    ["        Usage: assert.strictEqual(response.code, 404); matches the API docs."],
  );
  const result = await separateTestDiffWarmed(diff);
  assert.deepEqual(
    signalIds(result.signals),
    ["assertion-weakened"],
    "a documentation line's own literal changing is currently indistinguishable from a real assertion's value changing; this is the accepted cost, not a bug to silence here",
  );
});

// The other direction, and the reason `text` stays unmasked despite the
// false positive above: a real assertion inside an ordinary multi-line
// <script> block must never disappear. This is exactly what a diff hands
// the gate for that case: the opening <script> tag sits on its own line,
// nowhere in the one changed line the diff actually carries here, so a
// per-line scan has no tag on THIS line to tell it "still open" -- the
// same blindness described in src/tree-sitter-language-service.ts's own
// header. The round this project tried and reverted read a bare line like
// this one as still-unopened HTML and masked it away, silently, with no
// signal where one was required; this line reopens as ordinary code
// instead, unconditionally, and the weakening is caught.
test("a real assertion weakened inside an ordinary multi-line <script> block still produces a signal", async () => {
  const diff = oneFileDiff(
    "tests/LoginTest.php",
    ["        assert.strictEqual(response.code, 200);"],
    ["        assert.equal(response.code, 200);"],
  );
  const result = await separateTestDiffWarmed(diff);
  assert.deepEqual(
    signalIds(result.signals),
    ["assertion-weakened"],
    "an assertion swapped for a weaker check must never go unreported, script tag on an earlier line or not",
  );
});

// KNOWN LIMITATION (HIGH false positive), pinned, not desired: the SAME
// documentation-line false positive as the test above, but reached through
// a different, older mechanism worth pinning in its own right. `text` is
// also text_interpolation's own child -- the node that wraps HTML sitting
// BETWEEN two `<?php ... ?>` spans, PHP's most common templating form --
// and that masking predates this episode by years; it was never touched by
// the first three rounds src/tree-sitter-language-service.ts's own header
// describes, and this project's own reviewer had to reproduce it directly
// against maskNonCode to confirm it changed at all. It changed here for the
// same CRITICAL reason the bare-under-`program` form did: an inline
// <script>/<style> block sitting between two php spans has no child
// structure of its own to reopen a real assertion through, so masking this
// `text` node hid one. If this test ever starts asserting an empty signal
// list, the between-tags mechanism is masking `text` again and this
// comment is stale -- confirm against a real <script> block sitting
// between two php spans (not just a documentation line) before believing
// the hidden-assertion risk is actually gone.
test("known limitation: a documentation line sitting BETWEEN two php tags, not just before or after them, can also trip the gate on an unrelated literal edit", async () => {
  const diff = oneFileDiff(
    "tests/LoginTest.php",
    ["        <?php $a = 1; ?>Usage: assert.strictEqual(response.code, 200); matches the API docs.<?php $b = 2; ?>"],
    ["        <?php $a = 1; ?>Usage: assert.strictEqual(response.code, 404); matches the API docs.<?php $b = 2; ?>"],
  );
  const result = await separateTestDiffWarmed(diff);
  assert.deepEqual(
    signalIds(result.signals),
    ["assertion-weakened"],
    "HTML between two php tags is exactly as unmasked as leading/trailing HTML now, including inside this project's own gate; this is the accepted cost, not a bug to silence here",
  );
});

// Placed at the end of this file on purpose, not next to the other
// readWholeFile tests above: it is the one test in this file that calls
// separateTestDiffWarmed on a `.py` path, which resolves and permanently
// caches this process's Python language service (src/code-mask.ts's
// resolvedServices map has no per-test reset). Run any earlier than this,
// it silently warms Python for every test after it in this same process,
// including "Finding 6: unwarmed, ..." above, which depends on Python
// never having been warmed yet to prove its own point.
test("a Python docstring word is no longer read as a real removal, once the tree-sitter mask sees the whole docstring", async () => {
  const lines = ['    """', "    call assert_equal(a, b) to compare", '    """', "    return a + b"];
  const diff = oneFileDiff("tests/test_util.py", lines, []);
  const withoutReader = await separateTestDiffWarmed(diff);
  assert.deepEqual(
    signalIds(withoutReader.signals),
    ["assertion-removed"],
    "unchanged from before this phase: a docstring line with no quote of its own reads as code, one line at a time",
  );
  const withReader = await separateTestDiffWarmed(diff, {
    readWholeFile: wholeFileReaderFor({ old: lines.join("\n") + "\n" }),
  });
  assert.deepEqual(
    signalIds(withReader.signals),
    [],
    "the whole docstring is masked once the mask sees the triple-quote that opened it, on the line above",
  );
});
