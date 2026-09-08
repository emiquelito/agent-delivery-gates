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

export type Severity = "high" | "medium" | "low";

export interface FileStats {
  path: string;
  added: number;
  removed: number;
}

export interface Signal {
  id: SignalId;
  severity: Severity;
  file: string;
  /** The line content that triggered the signal, without its +/- marker. */
  line: string;
  message: string;
}

export interface SeparateOptions {
  /**
   * Extra patterns, tested against the full file path, that mark a file as
   * a test in addition to the built-in rules. The built-in rules already
   * work with no configuration; this is for a project with its own
   * convention.
   */
  extraTestPatterns?: RegExp[];
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

const TEST_PATH_SEGMENTS = new Set(["test", "tests", "__tests__", "spec"]);

/**
 * A path is a test when a directory segment names a test convention, or the
 * basename matches one of the common test-file naming patterns. Case
 * insensitive throughout, since a project's convention on one platform is
 * often cased differently on another.
 */
export function isTestPath(path: string, extraPatterns: RegExp[] = []): boolean {
  const segments = path.split("/");
  if (segments.some((segment) => TEST_PATH_SEGMENTS.has(segment.toLowerCase()))) {
    return true;
  }
  const basename = (segments[segments.length - 1] ?? "").toLowerCase();
  if (
    /\.test\./.test(basename) ||
    /\.spec\./.test(basename) ||
    /_test\./.test(basename) ||
    /^test_/.test(basename)
  ) {
    return true;
  }
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

// Word-prefixed so "assertEqual", "assert_equal", and "self.assertTrue" all
// match through the "assert" prefix, not only a standalone "assert" call.
const ASSERTION_RE =
  /\bassert|\bexpect\(|\bshould\b|\bverify\(|\brequire!|\bt\.(?:Errorf?|Fatalf?|Fail(?:Now)?)\b/i;
const TEST_CASE_RE = /\btest\(|\bit\(|\bdescribe\(|\bdef test_|#\[test\]|\bfunc Test|@Test\b/i;
const SKIP_RE =
  /\.skip\b|\.only\b|\bxit\(|\bxdescribe\(|\btest\.todo\b|\bit\.todo\b|@pytest\.mark\.skip|@unittest\.skip|#\[ignore\]|\bt\.Skip\(|@Disabled|@Ignore/i;
const TOLERANCE_RE =
  /\btolerance\b|\bepsilon\b|\batol\b|\brtol\b|\bdelta\b|\bcloseTo\b|\bapproximately\b|\balmostEqual\b|\bwithinDelta\b/i;
const TIMEOUT_RE = /\btimeout\b|\bretr(?:y|ies)\b|\bmax_?retries\b/i;

const COMMENT_LINE_RE = /^\s*(?:\/\/|#(?!\[)|\*|\/\*|--)/;

/**
 * True when the line carries only a comment. Commenting an assertion out
 * removes it from the run, so a commented copy must not count as the
 * assertion being added back. A comment naming a skip is not a skip either.
 */
function isCommentLine(line: string): boolean {
  return COMMENT_LINE_RE.test(line);
}

/** Counts and collects the code lines in `lines` that match `re`. */
function matching(lines: string[], re: RegExp): string[] {
  return lines.filter((line) => !isCommentLine(line) && re.test(line));
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
function assertionWeakenedSignals(file: RawFileDiff): Signal[] {
  const removed = matching(file.removedLines, ASSERTION_RE);
  const added = matching(file.addedLines, ASSERTION_RE);
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
    if (TOLERANCE_RE.test(gone) || TIMEOUT_RE.test(gone)) continue;
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

/**
 * A file that was a test and is not one any more has left the run entirely,
 * whatever its content diff says. Renaming a test out of the naming rules
 * takes it out of scrutiny, so the rename itself is the signal.
 */
function declassifiedTestSignals(file: RawFileDiff, extraPatterns: RegExp[]): Signal[] {
  if (file.oldPath === null) return [];
  if (!isTestPath(file.oldPath, extraPatterns)) return [];
  if (isTestPath(file.path, extraPatterns)) return [];
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

/**
 * The net-removal signals (assertion-removed, test-case-removed): fires
 * only when the file's matching removed-line count exceeds its matching
 * added-line count, so a rewritten line (one removed, one added) does not
 * fire while a deleted one does. Reports every matching removed line.
 */
function netRemovalSignal(
  file: RawFileDiff,
  id: SignalId,
  severity: Severity,
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
  severity: Severity,
  re: RegExp,
  message: string,
): Signal[] {
  const removed = matching(file.removedLines, re);
  const added = matching(file.addedLines, re);
  if (removed.length === 0 || added.length === 0) return [];
  return added.map((line) => ({ id, severity, file: file.path, line, message }));
}

/** skip-added fires on any added line naming a skip or exclusion, unconditionally. */
function skipAddedSignal(file: RawFileDiff): Signal[] {
  return matching(file.addedLines, SKIP_RE).map((line) => ({
    id: "skip-added" as const,
    severity: "high" as const,
    file: file.path,
    line,
    message: "a skip, exclusion, or narrowing to '.only' was added; confirm this test was not disabled to reach green",
  }));
}

function signalsForTestFile(file: RawFileDiff): Signal[] {
  return [
    ...assertionWeakenedSignals(file),
    ...netRemovalSignal(
      file,
      "assertion-removed",
      "high",
      ASSERTION_RE,
      "an assertion was removed with no equivalent added in this file; confirm this check was not deleted to reach green",
    ),
    ...netRemovalSignal(
      file,
      "test-case-removed",
      "high",
      TEST_CASE_RE,
      "a test case was removed with no equivalent added in this file; confirm this test was not deleted to reach green",
    ),
    ...skipAddedSignal(file),
    ...changedValueSignal(
      file,
      "tolerance-widened",
      "medium",
      TOLERANCE_RE,
      "a tolerance-related line changed; a human must read the before and after values to confirm this was not loosened to reach green",
    ),
    ...changedValueSignal(
      file,
      "timeout-raised",
      "low",
      TIMEOUT_RE,
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
  const extraPatterns = options.extraTestPatterns ?? [];
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
    signals.push(...declassifiedTestSignals(file, extraPatterns));
    if (isTestPath(file.path, extraPatterns)) {
      testFiles.push(stats);
      testAdded += stats.added;
      testRemoved += stats.removed;
      signals.push(...signalsForTestFile(file));
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
