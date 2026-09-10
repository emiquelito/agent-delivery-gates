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

import { languageServiceFor } from "./code-mask.ts";

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
  /**
   * Returns the current text of a file named in the diff, or undefined when
   * it cannot be read. Used for one thing only: looking for the fixtures
   * marker (see FIXTURE_MARKER above). This file does no I/O of its own, so
   * a caller that supplies nothing gets no exemptions at all, which is the
   * direction that reports more, never less.
   */
  readFileText?: (path: string) => string | undefined;
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
}

interface RawFileDiff {
  path: string;
  oldPath: string | null;
  addedLines: string[];
  removedLines: string[];
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
const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@[ \t]?(.*)$/;

interface FileSection {
  path: string | null;
  pathA: string | null;
  oldPath: string | null;
  addedLines: string[];
  removedLines: string[];
  lines: DiffLine[];
  hunkHeadings: string[];
  inHunk: boolean;
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
        if (heading && heading[1].trim() !== "") section.hunkHeadings.push(heading[1].trim());
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
      const heading = HUNK_HEADER_RE.exec(line);
      if (heading && heading[1].trim() !== "") section.hunkHeadings.push(heading[1].trim());
      continue;
    }
    if (line.startsWith("+")) {
      const content = line.slice(1);
      section.addedLines.push(content);
      section.lines.push({ kind: "added", content });
      continue;
    }
    if (line.startsWith("-")) {
      const content = line.slice(1);
      section.removedLines.push(content);
      section.lines.push({ kind: "removed", content });
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
    section.lines.push({ kind: "context", content });
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

/**
 * Counts and collects the code lines in `lines` that match `re`.
 *
 * The pattern is tested against the line with every string, template,
 * regular expression, and trailing comment blanked out (see
 * src/code-mask.ts), because a detector word written inside a literal is
 * fixture text or a test's own name, not a weakening of anything. The
 * ORIGINAL line is what comes back and what gets reported: a person
 * reading a signal has to see the real text, never a line with holes cut
 * in it. A line whose code half is empty once masked matches nothing,
 * which is the point.
 *
 * The whole-line comment and import checks run first, not instead: the
 * mask knows the C-family comment forms only, and an import line is never
 * an assertion whatever word it carries.
 *
 * KNOWN LIMIT: this masks one line at a time, so a string that opened on an
 * earlier line is invisible to it. In
 *
 *     const xml = `
 *       <skipped type="pytest.skip"/>
 *     `;
 *
 * the middle line carries no quote of its own and reads as code, so its
 * detector words still fire. A diff line is all this file ever holds, so
 * there is no whole file to scan instead. For a test file where that is
 * common, the fixture marker (FIXTURE_MARKER above) is the answer.
 */
function matching(lines: string[], re: RegExp, path: string): string[] {
  return lines.filter((line) => !isCommentLine(line) && !isImportLine(line) && re.test(maskNonCode(line, path)));
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

/** One line kept twice: the text to test against, and the text to report. */
interface MaskedLine {
  raw: string;
  masked: string;
}

function withMask(raw: string, path: string): MaskedLine {
  return { raw, masked: maskNonCode(raw, path) };
}

/**
 * Two ways an assertion gets quieter without disappearing. A strong check is
 * swapped for a weaker one, or the same check keeps its form while the value
 * it expects changes, which is how a test gets edited to match a bug.
 */
function assertionWeakenedSignals(file: RawFileDiff, rules: CompiledRules): Signal[] {
  // Every pattern below is tested against the masked half of the line and
  // reported from the raw half, for the reason given on `matching` above.
  const removed = matching(file.removedLines, rules.assertions, file.path).map((line) => withMask(line, file.path));
  const added = matching(file.addedLines, rules.assertions, file.path).map((line) => withMask(line, file.path));
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
): Signal[] {
  const removed = matching(file.removedLines, re, file.path);
  const added = matching(file.addedLines, re, file.path);
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
  const removed = matching(file.removedLines, re, file.path);
  const added = matching(file.addedLines, re, file.path);
  if (removed.length === 0 || added.length === 0) return [];
  return added.map((line) => ({ id, severity, file: file.path, line, message }));
}

/** skip-added fires on any added line naming a skip or exclusion, unconditionally. */
function skipAddedSignal(file: RawFileDiff, rules: CompiledRules): Signal[] {
  return matching(file.addedLines, rules.skips, file.path).map((line) => ({
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
function hasRustTestMarker(file: RawFileDiff): boolean {
  if (file.hunkHeadings.some((heading) => RUST_TEST_MARKER_RE.test(maskNonCode(heading, file.path)))) return true;
  return file.lines.some((line) => RUST_TEST_MARKER_RE.test(maskNonCode(line.content, file.path)));
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
function cfgTestRegionMask(lines: DiffLine[], path: string): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  let i = 0;
  while (i < lines.length) {
    if (!CFG_TEST_ATTR_RE.test(maskNonCode(lines[i].content, path))) {
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
        signals.push(...signalsForTestFile(file, rules));
      }
    } else {
      sourceFiles.push(stats);
      sourceAdded += stats.added;
      sourceRemoved += stats.removed;
      if (declassified.length > 0 && !skipChecks()) signals.push(...declassified);
      if (RUST_PATH_RE.test(file.path)) {
        if (hasRustTestMarker(file)) {
          if (!skipChecks()) signals.push(...signalsForTestFile(file, rules));
        } else {
          const mask = cfgTestRegionMask(file.lines, file.path);
          const regionAdded: string[] = [];
          const regionRemoved: string[] = [];
          file.lines.forEach((line, idx) => {
            if (!mask[idx]) return;
            if (line.kind === "added") regionAdded.push(line.content);
            else if (line.kind === "removed") regionRemoved.push(line.content);
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
  };
}
