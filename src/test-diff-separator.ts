// Pure core for test-diff-separator. Takes unified diff text (as produced by
// `git diff`, covering any number of files) and returns the source diff and
// the test diff separated, plus a list of signals found in the test files
// alone. No I/O, no git, no process exit, no vendor concepts: every caller,
// a CLI, a PostToolUse wrapper, a future CI step, goes through this file so
// the detection rules live in exactly one place.
//
// The point of this check: a fix that reaches green by weakening a test
// looks identical to a fix that reaches green by fixing the bug, if all a
// reviewer sees is "tests pass". This file finds the difference by reading
// what changed in the test files themselves, separately from the source
// change that supposedly caused them to pass.

import {
  languageServiceFor,
  warmLanguageServices,
  hadUnwarmedLanguageAccess,
  resetUnwarmedLanguageAccess,
  hadGenuineGrammarLoadFailure,
  hadGrammarAbsent,
} from "./code-mask.ts";

/** Reaches the scanner chosen for `path` on every call (see
 * languageServiceFor in src/code-mask.ts), so a `.py` file is read by the
 * tree-sitter service when one is available for this process, and every
 * other file keeps the regex scanner it always used. */
function maskNonCode(text: string, path: string): string {
  return languageServiceFor(path).maskNonCode(text);
}

export type SignalId =
  | "assertion-removed"
  | "assertion-weakened"
  | "test-file-declassified"
  | "test-case-removed"
  | "skip-added"
  | "tolerance-widened"
  | "timeout-raised";

// How bad one finding is. This is not the severity in rules/schema.json,
// which ranks a rule. The two vocabularies differ on purpose and used to
// share a name, which made them look like one thing.
export type FindingSeverity = "high" | "medium" | "low";

export interface FileStats {
  path: string;
  added: number;
  removed: number;
}

export interface Signal {
  id: SignalId;
  severity: FindingSeverity;
  file: string;
  /** The line content that triggered the signal, without its +/- marker. */
  line: string;
  message: string;
}

// --- Configurable rule fragments ----------------------------------------------
//
// Every pattern group below is a list of extended-regex fragments, joined
// with "|" and compiled case-insensitively. A project can add to or replace
// any group through a JSON config; see src/test-diff-config.ts for how a
// config file becomes a RuleSet. This file itself does no file reading: it
// only knows how to turn a RuleSet into working regexes and how to apply
// them. The defaults here are broad on purpose, since test naming is
// convention, not one project's taste, and the tool must work with no
// configuration at all.

export type RuleBucket = "testPaths" | "assertions" | "testCases" | "skips" | "tolerance" | "timeout";

export const RULE_BUCKETS: readonly RuleBucket[] = [
  "testPaths",
  "assertions",
  "testCases",
  "skips",
  "tolerance",
  "timeout",
];

/** Buckets a config file may fully replace instead of only adding to. */
export const REPLACEABLE_BUCKETS: ReadonlySet<RuleBucket> = new Set([
  "testPaths",
  "assertions",
  "testCases",
  "skips",
]);

export interface RuleSet {
  testPaths: string[];
  assertions: string[];
  testCases: string[];
  skips: string[];
  tolerance: string[];
  timeout: string[];
}

export interface CompiledRules {
  testPaths: RegExp;
  assertions: RegExp;
  testCases: RegExp;
  skips: RegExp;
  tolerance: RegExp;
  timeout: RegExp;
}

// Written case-insensitively at compile time (see compileFragments), so a
// fragment does not itself need to spell out every casing.
export const DEFAULT_RULES: Readonly<RuleSet> = Object.freeze({
  testPaths: [
    // A directory segment naming a conventional test folder. This already
    // covers Java and Kotlin's src/test/... layout, since "test" is its own
    // path segment there.
    // Capitalised spellings are listed because this bucket is compiled case
      // sensitively. Swift and C# name these folders Tests and Specs.
      "(^|/)(test|tests|Test|Tests|__tests__|spec|specs|Spec|Specs)(/|$)",
    "\\.test\\.[^/]*$",
    "\\.spec\\.[^/]*$",
    "_test\\.[^/]*$",
    "(^|/)test_[^/]*$",
    // Ruby's *_spec.rb: an underscore, not the dotted form above.
    "_spec\\.rb$",
    // Python's pytest fixture file, wherever it sits.
    "(^|/)conftest\\.py$",
    // A PascalCase Test/Tests suffix: FooTest.java, FooTests.cs,
    // FooTest.php, FooTests.swift, FooTest.kt. Scoped to these extensions
    // on purpose: opened up to every extension, this would also catch an
    // ordinary class named Contest or Latest.
    "[A-Za-z0-9]+Tests?\\.(java|cs|php|swift|kt)$",
  ],
  assertions: [
    // Word-prefixed so assertEqual, assert_equal, self.assertTrue,
    // PHPUnit's $this->assert..., C#'s Assert., and Java's assertThat and
    // Assertions. all match through this one prefix.
    "\\bassert",
    "\\bexpect\\(",
    "\\bshould\\b",
    "\\bverify\\(",
    "\\brequire!",
    // Go testify's require.NoError(...), require.Equal(...), and so on.
    // Named explicitly, not just "require." followed by a call, because
    // this whole rule set is matched case-insensitively (see
    // compileFragments below), so an uppercase-only check would not tell
    // this apart from Node's own require.resolve(...) or require.cache.
    "\\brequire\\.(?:NoErrorf?|Errorf?|EqualError|Equal|NotEqual|True|False|Nil|NotNil|Empty|NotEmpty|Len|Contains|NotContains|ElementsMatch|Panics|NotPanics|Greater|GreaterOrEqual|Less|LessOrEqual|WithinDuration|InDelta|InEpsilon|Zero|NotZero|Same|NotSame|IsType|Implements|FailNow|Fail)\\b",
    // Ruby minitest's refute / refute_equal / refute_nil.
    "\\brefute",
    "\\bpytest\\.raises\\b",
    "\\bt\\.(?:Errorf?|Fatalf?|Fail(?:Now)?)\\b",
  ],
  testCases: [
    "\\btest\\(",
    "\\bit\\(",
    "\\bdescribe\\(",
    "\\bdef test_",
    "#\\[test\\]",
    "\\bfunc Test",
    "@Test\\b",
    // RSpec and Elixir's string-form opener: it "does x" do, test "does x".
    "\\bit\\s+[\"']",
    "\\btest\\s+[\"']",
    "\\bpublic function test\\w*\\(",
    "\\bclass\\s+\\w*Tests?\\b",
    "\\[Fact\\]",
    "\\[Test\\]",
    "\\[TestMethod\\]",
    // Rust's #[tokio::test], #[async_std::test], and similar.
    "#\\[\\w+::test\\]",
    "@ParameterizedTest\\b",
  ],
  skips: [
    // Chained off a test-declaration identifier, never a bare object: xUnit
    // has no fluent skip call at all (it disables only through the
    // "Skip = " attribute argument covered further down), and in every
    // JavaScript/TypeScript framework this project has runner support for
    // (Mocha, Jest, Vitest, Jasmine's spec runner, Cypress, Playwright,
    // Ava), a disabling ".skip" is always chained off one of these five
    // names, never off an arbitrary data object. Anchoring here is what
    // drops the false positives an earlier, unanchored "\.skip\b" caught:
    // C# LINQ's ".Skip(20)" pagination call and the JS Iterator Helpers
    // ".skip(5)" method, both ordinary data slicing with no test-runner
    // identifier in front of the dot. "test.describe.skip(...)"
    // (Playwright's nested form) still matches: "describe.skip" is itself
    // a substring of it.
    //
    // This allowlist is confident but incomplete on its own -- a project's
    // own runner wrapper, a helper, or a differently-aliased import never
    // appears here, and never could: there is no way to enumerate every
    // name a team might use. The fragment right after this one covers that
    // gap by anchoring on the ARGUMENT instead of the receiver: any
    // identifier at all, followed by ".skip(", whose first argument is a
    // string. A disabling call names the test or gives a reason, so it
    // takes a string; ".Skip(20)" and ".skip(5)" both take a plain number
    // and so never match it. That also means this second fragment now
    // catches a test function imported under an alias
    // ("import { test as t } ... t.skip('reason', ...)"), a miss this
    // allowlist fragment alone could never close. What still escapes both
    // fragments: a receiver reached through bracket/computed access
    // ("runners['custom'].skip('flaky', ...)"), since there is no
    // identifier immediately before the "." there, and Mocha's dynamic
    // "this.skip()" inside a test body, which takes no argument at all.
    "\\b(?:it|describe|test|context|suite)\\.skip\\b",
    // Any identifier at all, chained with ".skip(" into a string-literal
    // first argument. See the comment on the fragment above for why the
    // argument, not the receiver, is what tells a real disabling call
    // apart from ordinary pagination/slicing: ".Skip(20)" and ".skip(5)"
    // both take a number, never a string. Backtick included alongside the
    // two quote characters since JS/TS code as often writes a skip reason
    // as a template literal as a plain string.
    "\\b\\w+\\.skip\\(\\s*[\"'`]",
    "\\.only\\b",
    "\\bxit\\(",
    "\\bxdescribe\\(",
    "\\btest\\.todo\\b",
    "\\bit\\.todo\\b",
    "@pytest\\.mark\\.skip",
    "@unittest\\.skip",
    "#\\[ignore\\]",
    "\\bt\\.Skip\\(",
    "\\bt\\.SkipNow\\b",
    "@Disabled",
    "@Ignore",
    "\\[Ignore\\]",
    "\\bmarkTestSkipped\\b",
    "\\bmarkTestIncomplete\\b",
    // Anchored to a call or a string argument, never a bare word: "skip" and
    // "pending" alone are ordinary English and would fire on prose and on
    // unrelated code. Also excludes a call immediately preceded by ".",
    // since that is the chained form the identifier-anchored fragment above
    // already owns; without the exclusion this bare form re-admitted the
    // same ".Skip(20)"/".skip(5)" false positives that fragment was just
    // anchored to drop. What it keeps: a bare, unchained "skip(...)" call,
    // such as R's testthat::skip("reason"), which is never written as a
    // method chain in the first place.
    "(?<!\\.)\\bskip\\(",
    "\\bskip\\s+[\"']",
    "\\bpending\\(",
    "\\bpending\\s+[\"']",
    "\\bxcontext\\b",
    // xUnit's [Fact(Skip = "reason")] / [Theory(Skip = "reason")]. The
    // real argument's value is always one of a small set of forms: a
    // plain string ("reason"), an interpolated or verbatim string ($"...",
    // @"...", or the combined $@".../@$"... forms), or a bare identifier
    // or member-access reference to a constant holding the reason
    // (SkipReasons.Flaky). Anchoring to "Skip" followed by "=" followed by
    // one of exactly those forms -- never a bare "skip =" assigned to
    // something else -- keeps every spacing variant of the real attribute
    // (Skip=, Skip =, Skip  =) while "const skip = new Set(...)" (this
    // bucket compiles case-insensitively; see compileFragments below)
    // still does not match: "new Set(...)" is neither a string nor a bare
    // identifier/member-access value on its own, since the identifier
    // alternative below is anchored at its OWN end too -- it only matches
    // when the identifier chain is the entire value (followed by nothing
    // but a comma, a closing paren/bracket, a semicolon, or the end of the
    // line), so "new" alone can start the match but never finish it: what
    // follows "new" is " Set(...)", not one of those terminators.
    //
    // A prior version of this fragment anchored to an unclosed "[" earlier
    // on the same line instead. That version was checked against this same
    // false positive and reached green, but a reviewer running the real
    // gate -- not the regex alone -- found it missed two ordinary forms the
    // bracket anchor was blind to: a long attribute wrapped across several
    // lines, where the "[" and "Skip =" land on different diff lines and
    // this bucket only ever sees one line at a time (see the per-line
    // limit named on maskDiffLine below); and any other unrelated "]"
    // earlier on the same line, from an array-typed argument in the same
    // attribute list ("Data = new[] {1,2}, Skip = ..."), which closed the
    // bracket class early and hid the real "Skip =" that followed it. A
    // second version, anchored to a bare quote right after "=", closed
    // those two gaps but reopened a narrower one of its own: an
    // interpolated string, a verbatim string, or a reference to a named
    // constant never starts with a quote at all, so all three ordinary
    // C# forms slipped past it (a reviewer reproduced all three through
    // the real gate). This value-form anchor closes that gap in turn,
    // still needs no bracket, and is still checked line by line like every
    // fragment in this bucket -- it does not depend on seeing more than
    // the one line an attribute's "Skip =" argument sits on.
    //
    // Known gap, not attempted here: when "Skip =" and its value land on
    // different diff lines -- an attribute wrapped so the "=" ends one line
    // and the value opens the next -- nothing on either line alone carries
    // both halves, so this fragment (like every fragment in this bucket)
    // has nothing to match. This is the same per-line limit named above,
    // not a defect specific to this fragment.
    "\\bSkip\\s*=\\s*(?:[\"']|\\$@?\"|@\\$?\"|[A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*)*(?=\\s*(?:,|\\)|\\]|;)|\\s*$))",
  ],
  tolerance: [
    "\\btolerance\\b",
    "\\bepsilon\\b",
    "\\batol\\b",
    "\\brtol\\b",
    "\\bdelta\\b",
    "\\bcloseTo\\b",
    "\\bapproximately\\b",
    "\\balmostEqual\\b",
    "\\bwithinDelta\\b",
  ],
  timeout: ["\\btimeout\\b", "\\bretr(?:y|ies)\\b", "\\bmax_?retries\\b"],
});

/** Joins a bucket's fragments into one case-insensitive RegExp. An empty
 * bucket compiles to a pattern that never matches anything, not one that
 * matches everything. Throws when a fragment is not valid regex,
 * naming the bucket so the error points somewhere useful. */
/**
 * testPaths is the one bucket that has to respect case. Case is the only
 * thing telling WidgetTest.java apart from Contest.java, and matching without
 * it turned ordinary source files into test files. Every other bucket stays
 * case insensitive. This lives in one place because it was decided in two,
 * and the two disagreed as soon as one of them changed.
 */
function bucketFlags(bucket: RuleBucket): string {
  return bucket === "testPaths" ? "" : "i";
}

function compileFragments(bucket: RuleBucket, fragments: string[]): RegExp {
  if (fragments.length === 0) return /(?!)/;
  const source = fragments.map((fragment) => `(?:${fragment})`).join("|");
  // testPaths is the one bucket that has to respect case. Case is the only
  // thing telling WidgetTest.java apart from Contest.java, and matching
  // without it turned ordinary source files into test files. Every other
  // bucket stays case insensitive.
  const flags = bucketFlags(bucket);
  try {
    return new RegExp(source, flags);
  } catch (err) {
    throw new Error(`invalid regex fragment in "${bucket}": ${(err as Error).message}`);
  }
}

/** Compiles a resolved RuleSet (defaults already merged with any config, by
 * the caller) into the regexes separateTestDiff actually runs. */
export function compileRuleSet(rules: RuleSet): CompiledRules {
  return {
    testPaths: compileFragments("testPaths", rules.testPaths),
    assertions: compileFragments("assertions", rules.assertions),
    testCases: compileFragments("testCases", rules.testCases),
    skips: compileFragments("skips", rules.skips),
    tolerance: compileFragments("tolerance", rules.tolerance),
    timeout: compileFragments("timeout", rules.timeout),
  };
}

const DEFAULT_COMPILED = compileRuleSet(DEFAULT_RULES);

/**
 * Classifies one path against a resolved rule set and names which testPaths
 * fragment decided it, trying the fragments in the order they are listed.
 * Pure and synchronous, so it backs both --classify and its own tests
 * directly, with no subprocess needed.
 */
export function classifyTestPath(
  path: string,
  rules: RuleSet = DEFAULT_RULES,
): { isTest: boolean; matchedRule: string | null } {
  for (const fragment of rules.testPaths) {
    let re: RegExp;
    try {
      re = new RegExp(fragment, bucketFlags("testPaths"));
    } catch (err) {
      throw new Error(`invalid regex fragment in "testPaths": '${fragment}' (${(err as Error).message})`);
    }
    if (re.test(path)) return { isTest: true, matchedRule: fragment };
  }
  return { isTest: false, matchedRule: null };
}

export interface SeparateOptions {
  /**
   * A fully resolved rule set: defaults already merged with any config's
   * add/replace, done by the caller. This file does no file reading, so it
   * never resolves a config path itself. Defaults to DEFAULT_RULES.
   */
  rules?: RuleSet;
  /**
   * Returns the current text of a file named in the diff, or undefined when
   * it cannot be read. Used for one thing only: looking for the fixtures
   * marker (see FIXTURE_MARKER above). This file does no I/O of its own, so
   * a caller that supplies nothing gets no exemptions at all, which is the
   * direction that reports more, never less.
   */
  readFileText?: (path: string) => string | undefined;
  /**
   * Returns the whole content of `path` on one side of the diff, or
   * undefined when that side cannot be supplied: the file does not exist
   * there (added has no old side, deleted has no new side), the caller has
   * no commit to read from, or the read failed for any other reason. "old"
   * is the pre-image a removed line came from; "new" is the post-image an
   * added line lands in.
   *
   * This is what lets a detector see a construct spanning more than one
   * diff line -- a Python docstring, a PHP <script> block that opened
   * above the hunk's own context window -- because the line is masked
   * against the whole file it actually sits in, not read in isolation. See
   * `buildFileMaskContext` and `maskDiffLine` below for how a line is
   * matched back to its place in that whole file, and src/code-mask.ts's
   * file header for what this replaces.
   *
   * This file does no I/O of its own, so a caller with nothing to supply
   * here (raw diff text with no known revision -- see hooks/test-diff-
   * separator.ts's --diff/stdin mode, and src/mcp-server.ts's diff_text
   * argument) may simply omit this option. Every check then runs exactly
   * as it did before this option existed: one diff line at a time, masked
   * alone. A caller that supplies a reader for only one side (a brand new
   * file has no useful "old" reader to write) gets whole-file context for
   * the side it can answer and per-line context for the side it cannot,
   * line by line, not as an all-or-nothing switch.
   */
  readWholeFile?: (path: string, side: "old" | "new") => string | undefined;
}

export interface SeparateResult {
  sourceFiles: FileStats[];
  testFiles: FileStats[];
  signals: Signal[];
  sourceAdded: number;
  sourceRemoved: number;
  testAdded: number;
  testRemoved: number;
  signalCount: number;
  /**
   * Every file whose signal checks were skipped because it carries the
   * fixtures marker, in diff order. Reported on every run, found or not:
   * a gate that quietly skips a file is the failure this project names.
   */
  exemptFiles: string[];
  exemptCount: number;
  /**
   * The extensions (".py", ".rs", and so on) this run answered at least
   * one file's mask for with the regex scanner because nothing had warmed
   * that language's service first, not because the load was tried and
   * failed. Empty when a caller warms before calling (see
   * `separateTestDiffWarmed` below, and every production entry point in
   * this project); one entry per extension a caller skipped the warm for
   * and happened to touch, whether or not anyone reading its code ever
   * noticed the skip. This is reported unconditionally, found or not, the
   * same reasoning `exemptCount` above already follows: a degraded run
   * that reads like a clean one is the failure this project exists to
   * catch, including in itself.
   *
   * Named for what actually triggered it, not for the language that
   * happened to trigger it first: an earlier version of this field was a
   * plain boolean named `unwarmedPythonUsed`, left over from when Python
   * was the only tree-sitter-backed language, and a caller reading it true
   * had no way to tell a Rust file from a Python one. Renamed because
   * nothing outside this repository reads this field's name.
   */
  unwarmedExtensions: readonly string[];
  /**
   * The extensions (".py", ".rs", and so on) at least one file in this diff
   * carried whose tree-sitter grammar was attempted, through
   * `warmLanguageServices`, resolved to a package that is actually
   * installed, and still failed to load: see `hadGenuineGrammarLoadFailure`
   * in src/code-mask.ts. Distinct from `unwarmedExtensions` above -- that
   * one means nobody asked the grammar to load yet; this one means the
   * load was tried and did not succeed, so no later call in this process
   * is going to fix it either. Also distinct from `grammarAbsentExtensions`
   * below, which used to be folded into this same field: a real failure
   * (a corrupt wasm file, an ABI mismatch) is a real bug in this
   * environment or this gate, worth blocking on, where an absent package
   * is an ordinary fact of how most adopters install this tool (see the
   * STOP-GAP comment above grammarAbsentExtensions in src/code-mask.ts). A
   * file whose extension appears here was scanned with the regex fallback
   * reading every string, comment, and interpolation as ordinary code, the
   * same gap src/mutate.ts already refuses to mutate through (see
   * grammarUnavailablePaths there). Reported unconditionally, found or
   * not, for the same reason unwarmedExtensions is: a degraded run that
   * reads like a clean one is the failure this project exists to catch.
   */
  grammarLoadFailedExtensions: readonly string[];
  /**
   * The extensions (".py", ".rs", and so on) at least one file in this
   * diff carried whose tree-sitter grammar was attempted and whose
   * package was never installed at all: see `hadGrammarAbsent` in
   * src/code-mask.ts. This is the ordinary state for every one of the
   * seven tree-sitter-backed languages on an adopter who installed this
   * tool the way its own README says to, since none of those packages
   * is a runtime dependency of this one -- not a defect in the commit
   * being scanned, and not folded into `grammarLoadFailedExtensions`
   * above for exactly that reason. A file whose extension appears here
   * was still scanned with the regex fallback, and a caller should say so
   * plainly, but must not block on it the way a real failure warrants.
   * Reported unconditionally, found or not, for the same reason the other
   * two extension lists on this type are.
   */
  grammarAbsentExtensions: readonly string[];
  /**
   * The number of diff lines this run masked one at a time instead of
   * through the whole-file reader a caller supplied, because
   * `maskDiffLine`'s own raw-text check (see the comment banner above
   * `FileMaskContext`) found the whole file's answer for that line
   * untrustworthy: no text for that side, this line's number out of
   * range, or the whole file's own line at that position no longer
   * reading back the same text the diff itself carries. Zero whenever no
   * `readWholeFile` was supplied at all -- that is the documented,
   * expected behaviour for a caller with no commit to read from (raw diff
   * text, no known revision), not a degradation, so it is never counted
   * here.
   *
   * Finding 3: the whole-file reader this field is named for is SAFE --
   * it never misapplies one line's mask to another, because of the very
   * check this field counts the failures of -- but until this field
   * existed, a caller whose git plumbing was misconfigured (a stale
   * checkout, a revision that resolves to the wrong tree, GIT_DIR
   * pointing somewhere unexpected) got back exactly the old, weaker
   * per-line detection with nothing to say the new whole-file benefit was
   * lost for any of it. Reported unconditionally, found or not, the same
   * reasoning `exemptCount`, `unwarmedExtensions`,
   * `grammarLoadFailedExtensions`, and `grammarAbsentExtensions` above
   * already follow: a degraded run that reads like a clean one is the
   * failure this project exists to catch, including in itself.
   */
  wholeFileMaskFallbackCount: number;
}

/** Renders one signal as the CLI's text-format line: `id severity file: message`. */
export function formatSignalText(signal: Signal): string {
  return `${signal.id} ${signal.severity} ${signal.file}: ${signal.message}\n    ${signal.line}`;
}

// --- Line splitting, same rule as src/report-validator.ts -------------------

/** Splits diff text into lines. Handles CRLF, a lone CR, and no trailing newline. */
function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

// --- File-path classification ------------------------------------------------

/**
 * A path is a test when it matches one of the built-in testPaths rules (see
 * DEFAULT_RULES above), or one of the caller's own extra patterns. Case
 * insensitive throughout, since a project's convention on one platform is
 * often cased differently on another. Kept as a standalone helper, separate
 * from a full RuleSet, for a caller that wants the defaults plus one or two
 * of its own patterns without building a whole config.
 */
export function isTestPath(path: string, extraPatterns: RegExp[] = []): boolean {
  if (DEFAULT_COMPILED.testPaths.test(path)) return true;
  return extraPatterns.some((pattern) => pattern.test(path));
}

// --- The fixtures marker: an in-file exemption -------------------------------
//
// A test file can exist to hold text that only looks like a weakening, so the
// detector in this file can be tested against it. Two files in this
// repository do exactly that, and every commit touching them reported signals
// that were never real. Noise like that is what gets a gate switched off, and
// a gate nobody runs catches nothing.
//
// The exemption is a marker comment inside the file it affects, never a list
// of paths in a config file. An exemption written in the file appears in the
// diff of the commit that grants it, so a reviewer watches it happen. A list
// of paths can be extended far away from the code it silences, and grows
// without anyone noticing.
//
// What the marker does: it suppresses signals for its own file. What it does
// not do: it does not change classification. A marked file is still a test
// file, is still counted in the test half, and keeps its added and removed
// counts untouched. It never affects any other file. Every run names every
// file it skipped, whether or not anything else was found, so a skipped file
// is never quiet.

/** The text a marker comment must carry, exactly. */
export const FIXTURE_MARKER = "adg-test-diff: fixtures";

/**
 * How far into a file the marker may sit. Past this line it is not honoured,
 * so an exemption cannot be buried at the bottom of a long file where nobody
 * reading the top of it would know the file was exempt.
 */
export const FIXTURE_MARKER_HEAD_LINES = 20;

/**
 * The comment text on one line, given whether a block comment was already
 * open when the line began. Everything outside a comment is dropped, and a
 * quoted string never opens a comment, so a marker written in ordinary code
 * or inside a string literal yields nothing here. Recognises `//`, `#`, and
 * `/* ... *\/`, including a block that runs across lines, so the marker is
 * not tied to one language.
 */
function commentTextOf(line: string, inBlock: boolean): { text: string; inBlock: boolean } {
  let text = "";
  let block = inBlock;
  let i = 0;
  const n = line.length;
  while (i < n) {
    if (block) {
      const end = line.indexOf("*/", i);
      if (end === -1) {
        text += line.slice(i);
        return { text, inBlock: true };
      }
      text += line.slice(i, end);
      i = end + 2;
      block = false;
      continue;
    }
    const ch = line[i];
    if (ch === "/" && line[i + 1] === "/") {
      text += line.slice(i + 2);
      return { text, inBlock: false };
    }
    if (ch === "#") {
      text += line.slice(i + 1);
      return { text, inBlock: false };
    }
    if (ch === "/" && line[i + 1] === "*") {
      block = true;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < n && line[j] !== ch) {
        if (line[j] === "\\") j++;
        j++;
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return { text, inBlock: block };
}

/**
 * True when the file's first FIXTURE_MARKER_HEAD_LINES lines carry the marker
 * inside a comment. Both halves of that matter: a marker further
 * down is not honoured, and a marker outside a comment is not honoured.
 */
export function hasFixtureMarker(fileText: string): boolean {
  let inBlock = false;
  const head = splitLines(fileText).slice(0, FIXTURE_MARKER_HEAD_LINES);
  for (const line of head) {
    const result = commentTextOf(line, inBlock);
    if (result.text.includes(FIXTURE_MARKER)) return true;
    inBlock = result.inBlock;
  }
  return false;
}

// --- Diff parsing -------------------------------------------------------------

/** One line inside a hunk, in file order, tagged with how it changed. */
export type DiffLineKind = "added" | "removed" | "context";

export interface DiffLine {
  kind: DiffLineKind;
  /** The line's content, with its leading +/-/space marker stripped. */
  content: string;
  /**
   * The line's 1-based line number in the file's pre-image (the old side),
   * or null when it has none: an added line exists only in the new file.
   * Read off the hunk header's own `-a,b` count and advanced one line at a
   * time; used to find this exact line inside a whole file's own text (see
   * `readWholeFile` on SeparateOptions and `maskDiffLine` below), never
   * printed or compared against anything else.
   */
  oldLineNo: number | null;
  /**
   * The line's 1-based line number in the file's post-image (the new
   * side), or null when it has none: a removed line exists only in the old
   * file. Read off the hunk header's own `+c,d` count.
   */
  newLineNo: number | null;
}

interface RawFileDiff {
  path: string;
  oldPath: string | null;
  addedLines: DiffLine[];
  removedLines: DiffLine[];
  /**
   * Every hunk line for this file, in file order, added/removed/context
   * lines alike. Context lines are dropped from addedLines/removedLines
   * (by design, unchanged from before this field existed), but a module
   * boundary like Rust's #[cfg(test)] can only be found by reading past
   * a changed line into the context around it, so this keeps the whole
   * stream around for that.
   */
  lines: DiffLine[];
  /**
   * Each `@@ ... @@` hunk header's trailing text, in file order, when
   * present. Git fills this in with the enclosing scope it can find
   * above the hunk (a function or, for Rust, a `mod tests {` line),
   * skipping any hunk whose heading was empty.
   */
  hunkHeadings: string[];
}

/** Strips a leading "a/" or "b/" from a diff header path, when present. */
function stripAbPrefix(path: string): string {
  return path.replace(/^[ab]\//, "");
}

const GIT_HEADER_RE = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@[ \t]?(.*)$/;

interface FileSection {
  path: string | null;
  pathA: string | null;
  oldPath: string | null;
  addedLines: DiffLine[];
  removedLines: DiffLine[];
  lines: DiffLine[];
  hunkHeadings: string[];
  inHunk: boolean;
  /**
   * The line number the NEXT context or removed line will carry in the old
   * file, and the next context or added line will carry in the new file.
   * Both are set from the hunk header's own `-a,b +c,d` counts when a hunk
   * opens, and each advances independently as lines are read: a removed
   * line advances only oldLine, an added line only newLine, a context line
   * both. Null before the first hunk header of the file is seen, so a line
   * read outside any hunk (never happens; parseDiff only builds DiffLine
   * entries inside a hunk) cannot be mistaken for a numbered one.
   */
  oldLine: number | null;
  newLine: number | null;
}

function newSection(): FileSection {
  return {
    path: null,
    pathA: null,
    oldPath: null,
    addedLines: [],
    removedLines: [],
    lines: [],
    hunkHeadings: [],
    inHunk: false,
    oldLine: null,
    newLine: null,
  };
}

/**
 * Parses unified diff text into one entry per file, with its added and
 * removed line content (marker stripped). Handles `diff --git` headers,
 * renames, new/deleted files, binary files, a plain diff with no `diff
 * --git` header, an empty diff, and hunks spanning many `@@` sections
 * within one file. A `+++`/`---` header line is metadata, read only to
 * recover the path, and is never counted as an added or removed line.
 */
function parseDiff(text: string): RawFileDiff[] {
  const files: RawFileDiff[] = [];
  let current: FileSection | null = null;

  const finalize = () => {
    if (current && current.path !== null) {
      files.push({
        path: current.path,
        oldPath: current.oldPath,
        addedLines: current.addedLines,
        removedLines: current.removedLines,
        lines: current.lines,
        hunkHeadings: current.hunkHeadings,
      });
    }
    current = null;
  };

  for (const line of splitLines(text)) {
    const header = GIT_HEADER_RE.exec(line);
    if (header) {
      finalize();
      current = newSection();
      current.pathA = header[1];
      current.path = header[2];
      continue;
    }

    if (current === null) {
      // A plain unified diff with no `diff --git` header starts a file at
      // its first "--- " line instead. Anything before that, a mailbox
      // preamble for instance, is not part of any file's content.
      if (line.startsWith("--- ") || line === "---") {
        current = newSection();
      } else {
        continue;
      }
    }

    const section = current;
    if (!section.inHunk) {
      if (line.startsWith("rename to ")) {
        section.path = line.slice("rename to ".length).trim();
        continue;
      }
      if (line.startsWith("rename from ")) {
        section.oldPath = line.slice("rename from ".length).trim();
        continue;
      }
      if (line.startsWith("--- ") || line === "---") {
        if (section.path === null) {
          const p = stripAbPrefix(line.slice(4).trim());
          section.pathA = p === "/dev/null" ? null : p;
        }
        continue;
      }
      if (line.startsWith("+++ ") || line === "+++") {
        if (section.path === null) {
          const p = stripAbPrefix(line.slice(4).trim());
          section.path = p === "/dev/null" ? section.pathA : p;
        }
        continue;
      }
      if (line.startsWith("@@")) {
        section.inHunk = true;
        const heading = HUNK_HEADER_RE.exec(line);
        if (heading) {
          section.oldLine = Number(heading[1]);
          section.newLine = Number(heading[2]);
          if (heading[3].trim() !== "") section.hunkHeadings.push(heading[3].trim());
        }
        continue;
      }
      // Other pre-hunk metadata: "index ...", "new file mode ...",
      // "deleted file mode ...", "similarity index ...", "Binary files ...
      // differ". None of it is a changed line, so it is skipped, but a
      // binary file still gets a file entry with zero added/removed once
      // finalized, since a `diff --git` header always precedes it.
      continue;
    }

    // Inside a hunk.
    if (line.startsWith("@@")) {
      // A later hunk in the same file: its own changed-line counts are
      // unaffected, but its heading is its own trace of enclosing scope.
      // Its own `-a,b +c,d` counts restart the running line numbers too,
      // since a second hunk is not a continuation of the first one's.
      const heading = HUNK_HEADER_RE.exec(line);
      if (heading) {
        section.oldLine = Number(heading[1]);
        section.newLine = Number(heading[2]);
        if (heading[3].trim() !== "") section.hunkHeadings.push(heading[3].trim());
      }
      continue;
    }
    if (line.startsWith("+")) {
      const content = line.slice(1);
      const newLineNo = section.newLine;
      if (section.newLine !== null) section.newLine++;
      const entry: DiffLine = { kind: "added", content, oldLineNo: null, newLineNo };
      section.addedLines.push(entry);
      section.lines.push(entry);
      continue;
    }
    if (line.startsWith("-")) {
      const content = line.slice(1);
      const oldLineNo = section.oldLine;
      if (section.oldLine !== null) section.oldLine++;
      const entry: DiffLine = { kind: "removed", content, oldLineNo, newLineNo: null };
      section.removedLines.push(entry);
      section.lines.push(entry);
      continue;
    }
    // A context line (leading space), "\ No newline at end of file", or a
    // blank line from a trailing newline: none of it changed, so none of
    // it joins addedLines/removedLines, but a context line's content still
    // joins the ordered stream: it is the only place a module boundary
    // that did not itself change (Rust's #[cfg(test)]) can be found.
    if (line.startsWith("\\")) {
      continue; // "\ No newline at end of file": diff metadata, not content
    }
    const content = line.startsWith(" ") ? line.slice(1) : line;
    const oldLineNo = section.oldLine;
    const newLineNo = section.newLine;
    if (section.oldLine !== null) section.oldLine++;
    if (section.newLine !== null) section.newLine++;
    section.lines.push({ kind: "context", content, oldLineNo, newLineNo });
  }
  finalize();

  return files;
}

/**
 * Every file path named in `diffText`, in the order the diff names them.
 * Exists for a caller that wants to warm up a language service (see
 * `warmLanguageServices` in src/code-mask.ts) before calling
 * `separateTestDiff`, which stays a plain synchronous function and cannot
 * do that loading itself. Reuses `parseDiff`, so it recognises the same
 * kinds of diff: renames, new and deleted files, and so on.
 */
export function pathsInDiff(diffText: string): string[] {
  return parseDiff(diffText).map((file) => file.path);
}

// --- Weakening signals, run against test files only --------------------------

const COMMENT_LINE_RE = /^\s*(?:\/\/|#(?!\[)|\*|\/\*|--)/;

/**
 * True when the line carries only a comment. Commenting an assertion out
 * removes it from the run, so a commented copy must not count as the
 * assertion being added back. A comment naming a skip is not a skip either.
 */
export function isCommentLine(line: string): boolean {
  return COMMENT_LINE_RE.test(line);
}

// An import or a require, across the languages this file already covers: an
// ES import, a require(...) call, Python's "import x" and "from x import
// y", a Go "import" line, a Java or Kotlin import, and Rust's "use". The
// word "assert" shows up in plenty of import lines ("import assert from
// 'node:assert/strict'"), and a deleted or renamed test file drags its own
// import lines into the diff as removed lines, so without this exclusion
// they get read as removed assertions.
const IMPORT_LINE_RE = /^\s*(?:import\b|from\s+\S+\s+import\b|use\s+[A-Za-z_])|\brequire\(/;

/**
 * True when the line is only an import or a require, in any of the forms
 * IMPORT_LINE_RE covers. Never itself an assertion, a test case opener, or
 * a skip, whatever word it happens to contain.
 */
export function isImportLine(line: string): boolean {
  return IMPORT_LINE_RE.test(line);
}

// --- Whole-file mask context ---------------------------------------------
//
// Every real call site used to hand maskNonCode one diff line at a time,
// which is what src/code-mask.ts's header long called a KNOWN LIMIT: a
// string, a docstring, an HTML script block, anything that opens on an
// earlier line, is invisible to a scan that only ever sees the one line
// that changed. This section is the fix. A caller that can read a whole
// file at the commit (see `readWholeFile` on SeparateOptions) gets that
// file masked ONCE, and every line the diff touches is answered from that
// one masked file by its own line number, not re-masked alone.
//
// A removed line has no post-image: it only ever existed in the file
// before this diff, so it is read and masked from the OLD side. An added
// line has no pre-image and is read and masked from the NEW side. A
// context line is unchanged, so it exists on both sides with the same
// content; the new side is preferred (it is the file as it stands after
// the diff, the more useful one to have masked for anything downstream
// that also wants it), the old side is tried if the new side has nothing
// for this line, and per-line masking is the last resort, exactly the
// behaviour every caller already had before this section existed.
//
// A reader is trusted only as far as it can be checked: the whole file's
// own line at the position the hunk header says this line sits at must
// read back the SAME raw text the diff itself carries. A stale read (the
// working tree moved on, the wrong revision was handed in, an off-by-one
// in the hunk arithmetic) fails that check and falls back to per-line
// masking instead of applying some other line's mask to this one, which
// would be worse than the limit this section closes.

/** One side's precomputed whole-file text, split into lines twice: once
 * raw, for the reader-trust check above, and once masked, what a line
 * lookup actually returns. Both null when this side could not be
 * supplied at all -- no reader given, the file does not exist on this
 * side, or the read failed. */
interface SideMask {
  raw: string[] | null;
  masked: string[] | null;
}

/** Everything one changed file needs to mask any of its own diff lines,
 * built once per file and reused across every check that runs against it. */
interface FileMaskContext {
  old: SideMask;
  new: SideMask;
  /** The path a removed line's own extension is chosen from: the file's
   * pre-rename path when this file was renamed, its own path otherwise. */
  oldPath: string;
  /** The path an added or context line's own extension is chosen from. */
  newPath: string;
  /** Shared across every file in this run; see MaskStats above. */
  stats: MaskStats;
  /** One DiffLine object is asked for its masked text by more than one
   * check (assertions, testCases, skips, tolerance, timeout each scan the
   * same added/removed lines; a Rust file's marker and region checks scan
   * the same context lines too). Without this cache maskDiffLine below
   * would recompute -- and, on a fallback, re-count against
   * wholeFileFallbackCount -- once per check instead of once per line,
   * turning a one-line degradation into a five- or six-times-inflated
   * number with no meaning a caller could read. Keyed by object identity,
   * never by content: two different DiffLine entries can carry the same
   * text and must still be masked (and counted) independently. */
  cache: Map<DiffLine, string>;
}

const EMPTY_SIDE_MASK: SideMask = { raw: null, masked: null };

function buildSideMask(text: string | undefined, path: string): SideMask {
  if (text === undefined) return EMPTY_SIDE_MASK;
  return { raw: splitLines(text), masked: splitLines(maskNonCode(text, path)) };
}

/**
 * One counter, shared by every file's own FileMaskContext for the life of
 * one separateTestDiff call, backing `SeparateResult.
 * wholeFileMaskFallbackCount` (see that field's own doc for why it exists:
 * Finding 3, the whole-file fallback having no field to say it happened).
 *
 * `readerSupplied` is fixed for the whole run, from whether the caller
 * passed a `readWholeFile` option at all: a caller with none (raw diff
 * text, no known revision -- see `readWholeFile` on SeparateOptions) is
 * the documented, expected behaviour this file always had, not a degradation,
 * so nothing is counted there. `wholeFileFallbackCount` only grows when a
 * caller DID supply a reader and `maskDiffLine` still had to fall back to
 * masking one line alone: the whole-file answer for that line's side was
 * missing, out of range, or its raw text no longer matched what the diff
 * itself carries. That is exactly the gap Finding 3 named: a caller whose
 * git plumbing is misconfigured gets the old, weaker detection with
 * nothing, until this field, to say the new benefit was lost.
 */
interface MaskStats {
  readerSupplied: boolean;
  wholeFileFallbackCount: number;
}

/**
 * Builds `file`'s mask context, reading whole-file text through
 * `readWholeFile` only for the sides this file could actually need: the
 * old side when it carries any removed line, the new side when it carries
 * any added line, and both sides unconditionally for a `.rs` file, since
 * Rust's own test detection (`hasRustTestMarker`, `cfgTestRegionMask`
 * below) reads context lines too, on either side, not only added/removed
 * ones. A plain source file with no removed or added lines worth masking
 * -- most of a large commit, ordinarily -- triggers no read at all: this
 * is the bound that keeps a fifty-file commit from paying for fifty whole
 * files it was never going to mask a single line of.
 *
 * `readWholeFile` undefined (no commit to read from) returns a context
 * whose every lookup falls through to per-line masking, unchanged from
 * how this file always worked before this option existed.
 */
function buildFileMaskContext(
  file: RawFileDiff,
  readWholeFile: ((path: string, side: "old" | "new") => string | undefined) | undefined,
  stats: MaskStats,
): FileMaskContext {
  const oldPath = file.oldPath ?? file.path;
  const newPath = file.path;
  if (readWholeFile === undefined) {
    return { old: EMPTY_SIDE_MASK, new: EMPTY_SIDE_MASK, oldPath, newPath, stats, cache: new Map() };
  }
  const isRust = RUST_PATH_RE.test(newPath);
  const wantOld = isRust || file.removedLines.length > 0;
  const wantNew = isRust || file.addedLines.length > 0;
  const oldText = wantOld ? readWholeFile(oldPath, "old") : undefined;
  const newText = wantNew ? readWholeFile(newPath, "new") : undefined;
  return {
    old: buildSideMask(oldText, oldPath),
    new: buildSideMask(newText, newPath),
    oldPath,
    newPath,
    stats,
    cache: new Map(),
  };
}

/**
 * The masked form of one diff line, read from whichever side of `ctx` has
 * it: the new side for an added or context line, the old side for a
 * removed or context line (new preferred when both could answer a context
 * line), falling back to masking this line alone when neither side has a
 * trustworthy answer -- no whole-file text for that side, this line's own
 * number missing or out of range (should not happen; recorded loudly if
 * it ever does, not silently misapplied), or the whole file's own line at
 * that number no longer reading back the exact text this diff line
 * carries.
 *
 * The first time this reaches the final per-line branch for a given
 * DiffLine while `ctx.stats.readerSupplied` is true, it counts against
 * `ctx.stats.wholeFileFallbackCount` -- see MaskStats above and
 * `SeparateResult.wholeFileMaskFallbackCount`. A caller with no reader at
 * all (readerSupplied false) always ends up here for every line, which is
 * the documented, expected behaviour, not a degradation, so nothing is
 * counted for it. `ctx.cache` (see FileMaskContext) makes this "first
 * time" real: more than one check asks the same DiffLine for its masked
 * text, and only the first of those may compute and count; the rest reuse
 * the cached answer, so one degraded line is counted once, not once per
 * check that happened to scan it.
 */
function maskDiffLine(line: DiffLine, ctx: FileMaskContext): string {
  const cached = ctx.cache.get(line);
  if (cached !== undefined) return cached;

  let result: string | undefined;
  if (line.kind !== "removed" && line.newLineNo !== null && ctx.new.raw !== null && ctx.new.masked !== null) {
    const idx = line.newLineNo - 1;
    if (idx >= 0 && idx < ctx.new.raw.length && ctx.new.raw[idx] === line.content) result = ctx.new.masked[idx];
  }
  if (result === undefined && line.kind !== "added" && line.oldLineNo !== null && ctx.old.raw !== null && ctx.old.masked !== null) {
    const idx = line.oldLineNo - 1;
    if (idx >= 0 && idx < ctx.old.raw.length && ctx.old.raw[idx] === line.content) result = ctx.old.masked[idx];
  }
  if (result === undefined) {
    if (ctx.stats.readerSupplied) ctx.stats.wholeFileFallbackCount++;
    const path = line.kind === "removed" ? ctx.oldPath : ctx.newPath;
    result = maskNonCode(line.content, path);
  }
  ctx.cache.set(line, result);
  return result;
}

/** One line kept twice: the text to test against, and the text to report. */
interface MaskedLine {
  raw: string;
  masked: string;
}

/**
 * Counts and collects the code lines in `lines` that match `re`, each kept
 * alongside the masked text it matched on.
 *
 * The pattern is tested against the line with every string, template,
 * regular expression, and trailing comment blanked out (see
 * src/code-mask.ts and `maskDiffLine` above), because a detector word
 * written inside a literal is fixture text or a test's own name, not a
 * weakening of anything. The ORIGINAL line is what comes back and what
 * gets reported: a person reading a signal has to see the real text,
 * never a line with holes cut in it. A line whose code half is empty once
 * masked matches nothing, which is the point.
 *
 * The whole-line comment and import checks run first, not instead: the
 * mask knows the C-family comment forms only, and an import line is never
 * an assertion whatever word it carries.
 */
function matchingMasked(lines: DiffLine[], re: RegExp, ctx: FileMaskContext): MaskedLine[] {
  const out: MaskedLine[] = [];
  for (const line of lines) {
    if (isCommentLine(line.content) || isImportLine(line.content)) continue;
    const masked = maskDiffLine(line, ctx);
    if (re.test(masked)) out.push({ raw: line.content, masked });
  }
  return out;
}

/** `matchingMasked`, for a caller that only wants the raw text back. */
function matching(lines: DiffLine[], re: RegExp, ctx: FileMaskContext): string[] {
  return matchingMasked(lines, re, ctx).map((m) => m.raw);
}

// An assertion that stays in place but stops proving as much. The net-count
// rules cannot see this, because one line goes and one line arrives, so it is
// its own signal. Each pair is a strong check on the left and a weaker one on
// the right.
const WEAKENING_PAIRS: Array<[RegExp, RegExp]> = [
  [/\bassert\w*\.?(?:strictEqual|deepStrictEqual)\b/i, /\bassert\w*\.?(?:equal|deepEqual)\b/i],
  [/\b(?:assert\w*\.?equal|assertEqual|toBe|toEqual)\b/i, /\b(?:assert\w*\.?ok|assertTrue|assertIsNotNone|toBeTruthy|toBeDefined|toBeTruthy)\b/i],
  [/===/, /(?<![=!<>])==(?!=)/],
  [/\btoHaveBeenCalledTimes\b/i, /\btoHaveBeenCalled\b/i],
];

/** Everything a literal could be, blanked, so two lines can be compared. */
function blankLiterals(line: string): string {
  return line
    .replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, "L")
    .replace(/\b\d+(?:\.\d+)?\b/g, "N")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Two ways an assertion gets quieter without disappearing. A strong check is
 * swapped for a weaker one, or the same check keeps its form while the value
 * it expects changes, which is how a test gets edited to match a bug.
 */
function assertionWeakenedSignals(file: RawFileDiff, rules: CompiledRules, ctx: FileMaskContext): Signal[] {
  // Every pattern below is tested against the masked half of the line and
  // reported from the raw half, for the reason given on `matchingMasked`
  // above.
  const removed = matchingMasked(file.removedLines, rules.assertions, ctx);
  const added = matchingMasked(file.addedLines, rules.assertions, ctx);
  if (removed.length === 0 || added.length === 0) return [];
  const signals: Signal[] = [];

  for (const gone of removed) {
    for (const [strong, weak] of WEAKENING_PAIRS) {
      if (!strong.test(gone.masked) || weak.test(gone.masked)) continue;
      const swapped = added.find((line) => weak.test(line.masked) && !strong.test(line.masked));
      if (swapped === undefined) continue;
      signals.push({
        id: "assertion-weakened",
        severity: "high",
        file: file.path,
        line: `${gone.raw.trim()}  ->  ${swapped.raw.trim()}`,
        message:
          "an assertion was replaced by one that proves less; confirm the check was not loosened to reach green",
      });
      break;
    }
  }

  for (const gone of removed) {
    // A changed tolerance or timeout is a changed literal too, and both have
    // their own signal. Reporting it twice for one edit adds nothing.
    if (rules.tolerance.test(gone.masked) || rules.timeout.test(gone.masked)) continue;
    const blanked = blankLiterals(gone.raw);
    const edited = added.find((line) => blankLiterals(line.raw) === blanked && line.raw.trim() !== gone.raw.trim());
    if (edited === undefined) continue;
    signals.push({
      id: "assertion-weakened",
      severity: "high",
      file: file.path,
      line: `${gone.raw.trim()}  ->  ${edited.raw.trim()}`,
      message:
        "an assertion kept its form while the value it expects changed; confirm the test was not edited to match the behavior",
    });
  }

  return signals;
}

/** The final path segment: what a runner globs on, not the directory it sits in. */
function basenameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

// The basename-only testPaths conventions, tightened for a bare basename
// with no directory to anchor against. testPaths itself matches
// "\.spec\.[^/]*$" against a whole path, so "helper.js" after ".spec." is
// fine there: it still has to sit under a test directory to count, and
// there this fragment only ever fires alongside the directory check. Tested
// against a basename alone that guard is gone, so a marker followed by more
// than one extension segment ("refund.spec.helper.js") would otherwise read
// as conventional when no runner globs that way. Every dotted suffix marker
// below requires exactly one extension after it; the prefix and exact-name
// forms are unaffected since a runner already treats anything after them as
// free-form.
function matchesBasenameConvention(basename: string): boolean {
  return (
    /\.test\.[^./]+$/.test(basename) ||
    /\.spec\.[^./]+$/.test(basename) ||
    /_test\.[^./]+$/.test(basename) ||
    /^test_[^/]*$/.test(basename) ||
    /_spec\.rb$/.test(basename) ||
    basename === "conftest.py" ||
    /[A-Za-z0-9]+Tests?\.(java|cs|php|swift|kt)$/.test(basename)
  );
}

/**
 * A file that was a test and is not one any more has left the run entirely,
 * whatever its content diff says. Renaming a test out of the naming rules
 * takes it out of scrutiny, so the rename itself is the signal.
 *
 * A file can also stay classified as a test by path (still under a test
 * directory) while its basename stops matching any naming convention a
 * runner globs on. That rename is invisible to the path-level check alone,
 * so it gets its own branch here.
 */
function declassifiedTestSignals(file: RawFileDiff, testPathsRe: RegExp): Signal[] {
  if (file.oldPath === null) return [];
  if (!testPathsRe.test(file.oldPath)) return [];
  if (!testPathsRe.test(file.path)) {
    return [
      {
        id: "test-file-declassified",
        severity: "high",
        file: file.path,
        line: `${file.oldPath} -> ${file.path}`,
        message:
          "a test file was renamed so it no longer reads as a test; confirm these tests were not taken out of the run",
      },
    ];
  }
  const oldBase = basenameOf(file.oldPath);
  const newBase = basenameOf(file.path);
  if (matchesBasenameConvention(oldBase) && !matchesBasenameConvention(newBase)) {
    return [
      {
        id: "test-file-declassified",
        severity: "high",
        file: file.path,
        line: `${file.oldPath} -> ${file.path}`,
        message:
          "a test file was renamed so its basename no longer matches a test naming convention; the file may no longer be collected by the test runner, so its tests stop running while the suite still reports success",
      },
    ];
  }
  return [];
}

/**
 * The net-removal signals (assertion-removed, test-case-removed): fires
 * only when the file's matching removed-line count exceeds its matching
 * added-line count, so a rewritten line (one removed, one added) does not
 * fire while a deleted one does. Reports every matching removed line.
 */
function netRemovalSignal(
  file: RawFileDiff,
  id: SignalId,
  severity: FindingSeverity,
  re: RegExp,
  message: string,
  ctx: FileMaskContext,
): Signal[] {
  const removed = matching(file.removedLines, re, ctx);
  const added = matching(file.addedLines, re, ctx);
  if (removed.length <= added.length) return [];
  return removed.map((line) => ({ id, severity, file: file.path, line, message }));
}

/**
 * The changed-value signals (tolerance-widened, timeout-raised): fires only
 * when a matching line was both added and removed in the file, since only
 * a change is interesting, not a line present all along. This file never
 * compares the numbers on either side; it says plainly that a human must
 * read them. Reports every matching added line.
 */
function changedValueSignal(
  file: RawFileDiff,
  id: SignalId,
  severity: FindingSeverity,
  re: RegExp,
  message: string,
  ctx: FileMaskContext,
): Signal[] {
  const removed = matching(file.removedLines, re, ctx);
  const added = matching(file.addedLines, re, ctx);
  if (removed.length === 0 || added.length === 0) return [];
  return added.map((line) => ({ id, severity, file: file.path, line, message }));
}

/** skip-added fires on any added line naming a skip or exclusion, unconditionally. */
function skipAddedSignal(file: RawFileDiff, rules: CompiledRules, ctx: FileMaskContext): Signal[] {
  return matching(file.addedLines, rules.skips, ctx).map((line) => ({
    id: "skip-added" as const,
    severity: "high" as const,
    file: file.path,
    line,
    message: "a skip, exclusion, or narrowing to '.only' was added; confirm this test was not disabled to reach green",
  }));
}

function signalsForTestFile(file: RawFileDiff, rules: CompiledRules, ctx: FileMaskContext): Signal[] {
  return [
    ...assertionWeakenedSignals(file, rules, ctx),
    ...netRemovalSignal(
      file,
      "assertion-removed",
      "high",
      rules.assertions,
      "an assertion was removed with no equivalent added in this file; confirm this check was not deleted to reach green",
      ctx,
    ),
    ...netRemovalSignal(
      file,
      "test-case-removed",
      "high",
      rules.testCases,
      "a test case was removed with no equivalent added in this file; confirm this test was not deleted to reach green",
      ctx,
    ),
    ...skipAddedSignal(file, rules, ctx),
    ...changedValueSignal(
      file,
      "tolerance-widened",
      "medium",
      rules.tolerance,
      "a tolerance-related line changed; a human must read the before and after values to confirm this was not loosened to reach green",
      ctx,
    ),
    ...changedValueSignal(
      file,
      "timeout-raised",
      "low",
      rules.timeout,
      "a timeout or retry count changed; a human must read the before and after values to confirm this was not raised to reach green",
      ctx,
    ),
  ];
}

// --- Rust: tests declared inside an ordinary source file ---------------------
//
// Rust puts unit tests in a #[cfg(test)] module inside the same file as the
// code they cover, so a file's path alone never says "this is a test" the
// way tests/foo.rs or foo.test.js does. File-level classification, the only
// kind this file otherwise does, cannot see them: the path reads as source,
// and the tests inside it go unscrutinised.
//
// Two independent traces are read out of a .rs file's diff:
//
// 1. hasRustTestMarker: true when a test-ish token (#[cfg(test)], #[test]
//    and the #[whatever::test] family, assert_eq!/assert_ne!/assert!) shows
//    up ANYWHERE in the file's diff, including a context line and a hunk's
//    `@@ ... @@` section heading, not only an added or removed line. When
//    true, the whole file's changed lines run through the same weakening
//    checks a test file gets. This is unchanged in spirit from before,
//    widened only to read context and headings too, since a marker sitting
//    two lines above the one that actually changed is real evidence, not
//    noise.
//
// 2. cfgTestRegionMask: a #[cfg(test)] module's extent, found by brace
//    matching over the file's ordered line stream (added, removed, and
//    context lines together, in file order). An attribute matching
//    #[cfg(test)] or #[cfg(all(..., test, ...))], followed (stacked
//    attributes skipped over) by `mod <name> {`, opens a region; `{`/`}`
//    are counted from there until the count returns to zero, and every
//    line from the attribute through that closing brace, inclusive, is
//    test content, whatever it says. `#[cfg(test)] mod tests;` (a
//    declaration, module body in another file) opens no region. When only
//    a marker is missing but a region is open, the weakening checks run
//    over just that region's added/removed lines, not the whole file, so a
//    real source-code change elsewhere in the same file still reports
//    nothing. This is what closes the gap the old comment here called
//    unclosable: an expected value edited on a line with no assert-like
//    macro of its own, deep inside a #[cfg(test)] module, is now visible as
//    long as the module's opener and the changed line are both in the
//    diff, whether or not either one carries a literal marker word.
//
// What this still cannot catch, plainly:
//
// - Brace counting is an approximation, not a Rust parser. It strips `//`
//   line comments, a single-line `/* ... */` block comment, and ordinary
//   `"..."`/`'x'` literals (including a same-line raw string, r"...",
//   r#"..."#, ...) before counting braces. It does NOT handle a block
//   comment or a raw string that spans more than one line: each of those
//   is only recognised up to the end of the line it starts on, so a `{`
//   or `}` sitting inside one of those two multi-line forms is still
//   counted as a real brace. That defeats the fail-open direction stated
//   below: instead of erring toward "this is a test", a region can close
//   too early or never open, and the miss goes unreported.
// - Brace matching can only see what is in the diff. If a #[cfg(test)]
//   opener sits above the hunk's context window, it is invisible, and the
//   region it would have opened is never found from this file's diff text
//   alone; the same is true in reverse if the closing brace sits below the
//   window. When a region opens but never visibly closes within the diff,
//   this fails toward calling the rest of the file's visible lines test
//   content instead of missing them, on purpose: a false "this is a test"
//   costs a human one look, a false "this is source" is exactly the miss
//   this file exists to avoid. Widening the context window (the CLI does
//   this for a .rs diff; see hooks/test-diff-separator.ts) narrows this
//   bound but cannot erase it. A change far enough from both the opener
//   and the closer, in a file wide enough, is still outside any diff.
// - `#[cfg(any(test, feature = "x"))]` opens no region and matches no
//   marker: CFG_TEST_ATTR_RE only recognises `cfg(test)` and a `cfg(all(
//   ...))` naming test among its conditions, both forms where test is
//   required for the item to compile at all. `any(...)` means the item
//   also compiles outside test builds, so it is not test-only code, and
//   treating it as a test region would misclassify code that ships in
//   the normal build. This is not new: the marker-only check this file
//   had before cfgTestRegionMask never caught it either.
const RUST_PATH_RE = /\.rs$/;
const RUST_TEST_MARKER_RE = /#\[cfg\(test\)\]|#\[\w+::test\]|#\[test\]|\bassert_eq!|\bassert_ne!|\bassert!/;

// Both reads below test the masked line, for the same reason every other
// pattern in this file does: `let s = "assert!";` is a Rust string that
// says nothing about whether this file holds tests. A Rust attribute is
// code, so `#[cfg(test)]` and `#[test]` come through the mask untouched,
// and so does `assert_eq!(total, 3)`.
function hasRustTestMarker(file: RawFileDiff, ctx: FileMaskContext): boolean {
  // Hunk headings are git's own one-line summary of enclosing scope, never
  // a line that itself sits at a known position in either whole file, so
  // this reads unconditionally per-line -- the same bound named on
  // maskDiffLine above for a line with nowhere else to look.
  if (file.hunkHeadings.some((heading) => RUST_TEST_MARKER_RE.test(maskNonCode(heading, file.path)))) return true;
  return file.lines.some((line) => RUST_TEST_MARKER_RE.test(maskDiffLine(line, ctx)));
}

// Matches "#[cfg(test)]" and "#[cfg(all(test, feature = \"x\"))]" (or any
// all(...) form naming "test" among its conditions), but not an unrelated
// #[cfg(...)] that never mentions test.
const CFG_TEST_ATTR_RE = /#\[cfg\((?:test|all\([^()]*\btest\b[^()]*\))\)\]/;
// The item a #[cfg(test)] attribute decorates: `mod name {` opens a region,
// `mod name;` (the module's body lives in another file entirely) does not.
const MOD_OPEN_OR_DECL_RE = /\bmod\s+\w+\s*([{;])/;

/**
 * Best-effort removal of the Rust syntax that can hide a brace from the
 * counter below: a `//` line comment (everything after it on the line is
 * dropped), a `/* ... *\/` block comment that both opens and closes on
 * this same line, an ordinary double-quoted string (backslash escapes
 * respected), a char literal (`'x'`, `'\n'`), and a raw string opener
 * (`r"..."`, `r#"..."#`, `r##"..."##`, ...) closed later on the same line.
 * Explicitly NOT handled: a block comment or a raw string that continues
 * onto another line. If the matching closer is not found on this same
 * line, the rest of the line is dropped instead of guessed at. See the
 * comment banner above this section for what that means for brace
 * counting.
 */
function stripRustNoiseForBraceCounting(line: string): string {
  let out = "";
  let i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line[i];
    if (ch === "/" && line[i + 1] === "/") break;
    if (ch === "/" && line[i + 1] === "*") {
      const end = line.indexOf("*/", i + 2);
      if (end === -1) break; // spans past this line: best-effort, stop here
      i = end + 2;
      continue;
    }
    if (ch === "r") {
      const rawOpen = /^r(#*)"/.exec(line.slice(i));
      if (rawOpen) {
        const closer = `"${"#".repeat(rawOpen[1].length)}`;
        const start = i + rawOpen[0].length;
        const end = line.indexOf(closer, start);
        if (end === -1) break; // spans past this line: best-effort, stop here
        i = end + closer.length;
        continue;
      }
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n && line[j] !== '"') {
        if (line[j] === "\\") j++;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (ch === "'") {
      const charLit = /^'(?:\\.|[^'\\])'/.exec(line.slice(i));
      if (charLit) {
        i += charLit[0].length;
        continue;
      }
      // Not a closed char literal: most likely a lifetime ('a). Consume
      // just the quote itself so it is never mistaken for a brace.
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Finds the `mod <name> {` or `mod <name>;` a #[cfg(test)] attribute at
 * `attrIdx` decorates, skipping over any other attributes stacked between
 * them. Returns null when nothing that looks like a mod item follows. */
function locateModOpener(lines: DiffLine[], attrIdx: number): { idx: number; punct: "{" | ";" } | null {
  const sameLine = MOD_OPEN_OR_DECL_RE.exec(lines[attrIdx].content);
  if (sameLine) return { idx: attrIdx, punct: sameLine[1] as "{" | ";" };
  for (let j = attrIdx + 1; j < lines.length; j++) {
    const trimmed = lines[j].content.trim();
    if (trimmed === "") continue;
    if (/^#\[/.test(trimmed)) continue; // a stacked attribute; keep looking
    const opener = MOD_OPEN_OR_DECL_RE.exec(lines[j].content);
    return opener ? { idx: j, punct: opener[1] as "{" | ";" } : null;
  }
  return null;
}

/**
 * Marks every index in `lines` that falls inside a #[cfg(test)] module
 * region: from the attribute through the closing brace, inclusive. See the
 * comment banner above this section for the brace-counting approximation
 * and its limits.
 */
function cfgTestRegionMask(lines: DiffLine[], ctx: FileMaskContext): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  let i = 0;
  while (i < lines.length) {
    if (!CFG_TEST_ATTR_RE.test(maskDiffLine(lines[i], ctx))) {
      i++;
      continue;
    }
    const opener = locateModOpener(lines, i);
    if (opener === null || opener.punct === ";") {
      i++;
      continue;
    }
    let depth = 0;
    let closeIdx = lines.length - 1; // fails toward "still in region" if never closed in view
    for (let k = opener.idx; k < lines.length; k++) {
      const stripped = stripRustNoiseForBraceCounting(lines[k].content);
      let closed = false;
      for (const ch of stripped) {
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            closeIdx = k;
            closed = true;
            break;
          }
        }
      }
      if (closed) break;
    }
    for (let m = i; m <= closeIdx; m++) mask[m] = true;
    i = closeIdx + 1;
  }
  return mask;
}

// --- Entry point ---------------------------------------------------------------

/**
 * Separates a unified diff into its source and test parts, and finds
 * weakening signals in the test files alone. A source file with a line
 * that looks like an assertion produces no signal, with two exceptions,
 * both there because Rust's own tests commonly live inside a source
 * file's own #[cfg(test)] module: a .rs file whose diff carries a Rust
 * test marker anywhere (see hasRustTestMarker above) gets its whole diff
 * checked, and failing that, a .rs file whose diff shows a #[cfg(test)]
 * module region (see cfgTestRegionMask above) gets that region's own
 * added/removed lines checked, marker or not.
 */
export function separateTestDiff(diffText: string, options: SeparateOptions = {}): SeparateResult {
  // Reset-then-read around this call only, not a lasting mode switch: this
  // function is synchronous start to finish (no `await` anywhere in it or
  // in anything it calls), so nothing else in this process can run between
  // the reset below and the read at the bottom to blur one call's answer
  // into another's, however many other callers share this same process.
  //
  // The body between the reset and the read is wrapped in try/catch so the
  // read always happens, on the thrown path as well as the normal one. An
  // earlier version of this function had no such wrapper: an exception
  // thrown by, say, options.readFileText mid-batch left the reset's batch
  // open forever, since nothing after it ever ran to close it. That turned
  // one bad diff into a permanent failure for every later call in the same
  // process (src/mcp-server.ts is long-lived and calls this many times per
  // session) -- the guard existed to make a silent blur loud, not to make a
  // recoverable error permanent. Catching here and rethrowing keeps that
  // error visible to this call's own caller while still closing the batch,
  // so the next call starts clean. An actual re-entrancy bug -- two calls
  // to this function really overlapping, in violation of the synchronous
  // invariant above -- is unaffected: the second call's reset still runs
  // before this first call's catch could possibly close its batch, so it
  // still throws loudly, exactly as before.
  resetUnwarmedLanguageAccess();
  try {
    return separateTestDiffBody(diffText, options);
  } catch (err) {
    hadUnwarmedLanguageAccess();
    throw err;
  }
}

function separateTestDiffBody(diffText: string, options: SeparateOptions): SeparateResult {
  const ruleSet = options.rules ?? DEFAULT_RULES;
  const rules = ruleSet === DEFAULT_RULES ? DEFAULT_COMPILED : compileRuleSet(ruleSet);
  const files = parseDiff(diffText);

  const sourceFiles: FileStats[] = [];
  const testFiles: FileStats[] = [];
  const signals: Signal[] = [];
  const exemptFiles: string[] = [];

  let sourceAdded = 0;
  let sourceRemoved = 0;
  let testAdded = 0;
  let testRemoved = 0;

  // One counter for the whole run, shared by every file's own
  // FileMaskContext; see MaskStats and SeparateResult.
  // wholeFileMaskFallbackCount above.
  const maskStats: MaskStats = { readerSupplied: options.readWholeFile !== undefined, wholeFileFallbackCount: 0 };

  const readFileText = options.readFileText;
  const carriesMarker = (path: string): boolean => {
    if (readFileText === undefined) return false;
    const text = readFileText(path);
    return text !== undefined && hasFixtureMarker(text);
  };

  for (const file of files) {
    const stats: FileStats = {
      path: file.path,
      added: file.addedLines.length,
      removed: file.removedLines.length,
    };
    // Records the file as exempt the first time a check would have run
    // against it, and answers whether that check should be skipped. Only
    // called where signals would otherwise be produced, so an ordinary
    // source file is never listed as skipped for a check it never faced.
    let exempt = false;
    const skipChecks = (): boolean => {
      if (exempt) return true;
      if (!carriesMarker(file.path)) return false;
      exempt = true;
      exemptFiles.push(file.path);
      return true;
    };

    // Built at most once per file, and only for a file some check below
    // actually needs it for: a test file, or a .rs file (checked for a
    // Rust test marker whether or not it turns out to hold one). Every
    // other source file in the same commit never calls readWholeFile at
    // all, which is the bound that keeps a large commit from paying to
    // read files it was never going to mask a line of. See
    // buildFileMaskContext's own comment for the read itself.
    let maskCtx: FileMaskContext | null = null;
    const getMaskCtx = (): FileMaskContext => {
      if (maskCtx === null) maskCtx = buildFileMaskContext(file, options.readWholeFile, maskStats);
      return maskCtx;
    };

    const declassified = declassifiedTestSignals(file, rules.testPaths);
    // Classification is decided before the marker is ever read, and the
    // marker never enters this decision: an exempt file is still a test
    // file, still in the test half, with its own counts unchanged.
    if (rules.testPaths.test(file.path)) {
      testFiles.push(stats);
      testAdded += stats.added;
      testRemoved += stats.removed;
      if (!skipChecks()) {
        signals.push(...declassified);
        signals.push(...signalsForTestFile(file, rules, getMaskCtx()));
      }
    } else {
      sourceFiles.push(stats);
      sourceAdded += stats.added;
      sourceRemoved += stats.removed;
      if (declassified.length > 0 && !skipChecks()) signals.push(...declassified);
      if (RUST_PATH_RE.test(file.path)) {
        const rustCtx = getMaskCtx();
        if (hasRustTestMarker(file, rustCtx)) {
          if (!skipChecks()) signals.push(...signalsForTestFile(file, rules, rustCtx));
        } else {
          const mask = cfgTestRegionMask(file.lines, rustCtx);
          const regionAdded: DiffLine[] = [];
          const regionRemoved: DiffLine[] = [];
          file.lines.forEach((line, idx) => {
            if (!mask[idx]) return;
            if (line.kind === "added") regionAdded.push(line);
            else if (line.kind === "removed") regionRemoved.push(line);
          });
          if ((regionAdded.length > 0 || regionRemoved.length > 0) && !skipChecks()) {
            signals.push(
              ...signalsForTestFile(
                {
                  path: file.path,
                  oldPath: file.oldPath,
                  addedLines: regionAdded,
                  removedLines: regionRemoved,
                  lines: [],
                  hunkHeadings: [],
                },
                rules,
                rustCtx,
              ),
            );
          }
        }
      }
    }
  }

  return {
    sourceFiles,
    testFiles,
    signals,
    sourceAdded,
    sourceRemoved,
    testAdded,
    testRemoved,
    signalCount: signals.length,
    exemptFiles,
    exemptCount: exemptFiles.length,
    unwarmedExtensions: hadUnwarmedLanguageAccess(),
    grammarLoadFailedExtensions: extensionsMatching(files.map((file) => file.path), hadGenuineGrammarLoadFailure),
    grammarAbsentExtensions: extensionsMatching(files.map((file) => file.path), hadGrammarAbsent),
    wholeFileMaskFallbackCount: maskStats.wholeFileFallbackCount,
  };
}

/** The extensions among `paths` for which `predicate` (one of
 * src/code-mask.ts's `hadGenuineGrammarLoadFailure` or `hadGrammarAbsent`)
 * answers true. Sorted and deduplicated, in the same form
 * `unwarmedExtensions` already returns, so a caller can report any of the
 * three the same way. */
function extensionsMatching(paths: readonly string[], predicate: (ext: string) => boolean): string[] {
  const found = new Set<string>();
  for (const path of paths) {
    const lower = path.toLowerCase();
    const dot = lower.lastIndexOf(".");
    const ext = dot === -1 ? "" : lower.slice(dot);
    if (ext !== "" && predicate(ext)) found.add(ext);
  }
  return [...found].sort();
}

/**
 * `separateTestDiff`, warmed first. `pathsInDiff` already exists for
 * exactly this: naming every file a diff touches before any of it is
 * scanned, the way `planMutationsWarmed` in src/mutate.ts warms ahead of
 * `planMutations`. Every production caller of `separateTestDiff` -
 * hooks/test-diff-separator.ts, hooks/test-diff-post-tool-hook.ts,
 * src/mcp-server.ts, and src/agent-adapter.ts's runTestDiffGate - now goes
 * through this instead of repeating its own warm-then-call pair by hand,
 * the same fix mutate.ts's own history already made for its callers: one
 * function to reach for instead of one more call site to remember.
 * `separateTestDiff` itself stays synchronous and unwarmed on purpose, for
 * a caller (a test among them) that already knows it holds no `.py` file,
 * or warms some other way.
 */
export async function separateTestDiffWarmed(
  diffText: string,
  options: SeparateOptions = {},
): Promise<SeparateResult> {
  await warmLanguageServices(pathsInDiff(diffText));
  return separateTestDiff(diffText, options);
}
