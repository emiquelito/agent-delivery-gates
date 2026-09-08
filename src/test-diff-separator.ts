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
    "\\.skip\\b",
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
    // unrelated code.
    "\\bskip\\(",
    "\\bskip\\s+[\"']",
    "\\bpending\\(",
    "\\bpending\\s+[\"']",
    "\\bxcontext\\b",
    // xUnit's [Fact(Skip = "reason")].
    "\\bSkip\\s*=",
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

// --- Diff parsing -------------------------------------------------------------

interface RawFileDiff {
  path: string;
  oldPath: string | null;
  addedLines: string[];
  removedLines: string[];
}

/** Strips a leading "a/" or "b/" from a diff header path, when present. */
function stripAbPrefix(path: string): string {
  return path.replace(/^[ab]\//, "");
}

const GIT_HEADER_RE = /^diff --git a\/(.+?) b\/(.+)$/;

interface FileSection {
  path: string | null;
  pathA: string | null;
  oldPath: string | null;
  addedLines: string[];
  removedLines: string[];
  inHunk: boolean;
}

function newSection(): FileSection {
  return { path: null, pathA: null, oldPath: null, addedLines: [], removedLines: [], inHunk: false };
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
      continue; // a later hunk in the same file
    }
    if (line.startsWith("+")) {
      section.addedLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith("-")) {
      section.removedLines.push(line.slice(1));
      continue;
    }
    // A context line (leading space), "\ No newline at end of file", or a
    // blank line from a trailing newline: none of it changed.
  }
  finalize();

  return files;
}

// --- Weakening signals, run against test files only --------------------------

const COMMENT_LINE_RE = /^\s*(?:\/\/|#(?!\[)|\*|\/\*|--)/;

/**
 * True when the line carries only a comment. Commenting an assertion out
 * removes it from the run, so a commented copy must not count as the
 * assertion being added back. A comment naming a skip is not a skip either.
 */
function isCommentLine(line: string): boolean {
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
function isImportLine(line: string): boolean {
  return IMPORT_LINE_RE.test(line);
}

/** Counts and collects the code lines in `lines` that match `re`. */
function matching(lines: string[], re: RegExp): string[] {
  return lines.filter((line) => !isCommentLine(line) && !isImportLine(line) && re.test(line));
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
function assertionWeakenedSignals(file: RawFileDiff, rules: CompiledRules): Signal[] {
  const removed = matching(file.removedLines, rules.assertions);
  const added = matching(file.addedLines, rules.assertions);
  if (removed.length === 0 || added.length === 0) return [];
  const signals: Signal[] = [];

  for (const gone of removed) {
    for (const [strong, weak] of WEAKENING_PAIRS) {
      if (!strong.test(gone) || weak.test(gone)) continue;
      const swapped = added.find((line) => weak.test(line) && !strong.test(line));
      if (swapped === undefined) continue;
      signals.push({
        id: "assertion-weakened",
        severity: "high",
        file: file.path,
        line: `${gone.trim()}  ->  ${swapped.trim()}`,
        message:
          "an assertion was replaced by one that proves less; confirm the check was not loosened to reach green",
      });
      break;
    }
  }

  for (const gone of removed) {
    // A changed tolerance or timeout is a changed literal too, and both have
    // their own signal. Reporting it twice for one edit adds nothing.
    if (rules.tolerance.test(gone) || rules.timeout.test(gone)) continue;
    const blanked = blankLiterals(gone);
    const edited = added.find((line) => blankLiterals(line) === blanked && line.trim() !== gone.trim());
    if (edited === undefined) continue;
    signals.push({
      id: "assertion-weakened",
      severity: "high",
      file: file.path,
      line: `${gone.trim()}  ->  ${edited.trim()}`,
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
): Signal[] {
  const removed = matching(file.removedLines, re);
  const added = matching(file.addedLines, re);
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
): Signal[] {
  const removed = matching(file.removedLines, re);
  const added = matching(file.addedLines, re);
  if (removed.length === 0 || added.length === 0) return [];
  return added.map((line) => ({ id, severity, file: file.path, line, message }));
}

/** skip-added fires on any added line naming a skip or exclusion, unconditionally. */
function skipAddedSignal(file: RawFileDiff, rules: CompiledRules): Signal[] {
  return matching(file.addedLines, rules.skips).map((line) => ({
    id: "skip-added" as const,
    severity: "high" as const,
    file: file.path,
    line,
    message: "a skip, exclusion, or narrowing to '.only' was added; confirm this test was not disabled to reach green",
  }));
}

function signalsForTestFile(file: RawFileDiff, rules: CompiledRules): Signal[] {
  return [
    ...assertionWeakenedSignals(file, rules),
    ...netRemovalSignal(
      file,
      "assertion-removed",
      "high",
      rules.assertions,
      "an assertion was removed with no equivalent added in this file; confirm this check was not deleted to reach green",
    ),
    ...netRemovalSignal(
      file,
      "test-case-removed",
      "high",
      rules.testCases,
      "a test case was removed with no equivalent added in this file; confirm this test was not deleted to reach green",
    ),
    ...skipAddedSignal(file, rules),
    ...changedValueSignal(
      file,
      "tolerance-widened",
      "medium",
      rules.tolerance,
      "a tolerance-related line changed; a human must read the before and after values to confirm this was not loosened to reach green",
    ),
    ...changedValueSignal(
      file,
      "timeout-raised",
      "low",
      rules.timeout,
      "a timeout or retry count changed; a human must read the before and after values to confirm this was not raised to reach green",
    ),
  ];
}

// --- Entry point ---------------------------------------------------------------

/**
 * Separates a unified diff into its source and test parts, and finds
 * weakening signals in the test files alone. A source file with a line
 * that looks like an assertion produces no signal: signals come from test
 * files only.
 */
export function separateTestDiff(diffText: string, options: SeparateOptions = {}): SeparateResult {
  const ruleSet = options.rules ?? DEFAULT_RULES;
  const rules = ruleSet === DEFAULT_RULES ? DEFAULT_COMPILED : compileRuleSet(ruleSet);
  const files = parseDiff(diffText);

  const sourceFiles: FileStats[] = [];
  const testFiles: FileStats[] = [];
  const signals: Signal[] = [];

  let sourceAdded = 0;
  let sourceRemoved = 0;
  let testAdded = 0;
  let testRemoved = 0;

  for (const file of files) {
    const stats: FileStats = {
      path: file.path,
      added: file.addedLines.length,
      removed: file.removedLines.length,
    };
    signals.push(...declassifiedTestSignals(file, rules.testPaths));
    if (rules.testPaths.test(file.path)) {
      testFiles.push(stats);
      testAdded += stats.added;
      testRemoved += stats.removed;
      signals.push(...signalsForTestFile(file, rules));
    } else {
      sourceFiles.push(stats);
      sourceAdded += stats.added;
      sourceRemoved += stats.removed;
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
  };
}
