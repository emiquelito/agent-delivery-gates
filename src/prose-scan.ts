// Pure core for the prose scan. Takes rules text and file text and returns
// what matched, what a baseline forgives, and what the report says. No I/O,
// no git, no process exit: every caller, the CLI in hooks/scan-prose.ts and
// any future CI step, goes through this file so one decision about what
// counts as a match lives in exactly one place.
//
// This began as a port of a bash script that needed bash 4, and so could not
// run on the bash macOS ships. That script is gone and this is now the only
// implementation. The contract, in short:
//
//   - a rules file is one entry per line: blank and # lines ignored,
//     "include: PATH" pulls in another file, "exclude: GLOB" drops a path
//     from the default file list, "prose-only: FRAGMENT" applies to prose
//     and not to source, and any other line is an extended-regex fragment.
//   - a baseline is keyed on the file path and the trimmed text of the
//     matching line, never the line number, and records how many times that
//     text matched, so a fourth copy of a line recorded three times is new.
//   - exit 0 clean, exit 1 a match was found, exit 2 could not run as asked.
//
// Exit 2 matters: a checker that cannot read its input must never look the
// same as a checker that read the input and found it clean.

// --- errors ------------------------------------------------------------------

/**
 * Every failure this core reports that the CLI turns into exit 2. The CLI
 * prints the message after its own "scan-prose: " prefix.
 */
export class ProseScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProseScanError";
  }
}

// --- POSIX extended regex, translated for JavaScript --------------------------
//
// Rules files hold POSIX extended regular expressions written for `grep -E`.
// JavaScript's RegExp is close, and the gap is small enough to name in full:
//
//   supported, by translation:
//     [:alpha:] [:digit:] [:alnum:] [:upper:] [:lower:] [:space:] [:punct:]
//     both alone ("[[:alpha:]]") and inside a wider bracket expression
//     ("[[:digit:]x-z]"), and inside a negated one ("[^[:space:]]").
//     A backslash inside a bracket expression, which POSIX reads as an
//     ordinary character and JavaScript reads as an escape.
//
//   refused, loudly, naming the fragment:
//     every other [:name:] class ([:blank:], [:cntrl:], [:print:],
//     [:graph:], [:xdigit:], [:word:], and any misspelling),
//     collating elements "[.x.]" and equivalence classes "[=x=]",
//     the GNU-only anchors \< \> \` \' , an unterminated bracket
//     expression, a trailing backslash, and anything RegExp itself
//     refuses to compile.
//
// A refusal is exit 2 and names the fragment. The one thing this must never
// do is compile a pattern that means something else than the rules author
// wrote, because the scan would then report clean having looked for the
// wrong text.

const POSIX_CLASSES: Readonly<Record<string, string>> = {
  alpha: "A-Za-z",
  digit: "0-9",
  alnum: "A-Za-z0-9",
  upper: "A-Z",
  lower: "a-z",
  // Written out, not "\\s": JavaScript's \s also matches non-breaking space
  // and the Unicode space separators, which POSIX [:space:] in the C locale
  // does not. A wider class than the rules author wrote is the same fault
  // as a narrower one.
  space: " \\t\\n\\v\\f\\r",
  // 0x21-0x2F, 0x3A-0x40, 0x5B-0x60, 0x7B-0x7E: every printable character
  // that is neither alphanumeric nor a space.
  punct: "!-/:-@\\[-`{-~",
};

/** The POSIX class names this scan knows how to translate, for messages. */
export const SUPPORTED_POSIX_CLASSES: readonly string[] = Object.keys(POSIX_CLASSES);

/** A rule fragment that cannot be turned into an equivalent JavaScript regex. */
export class PatternError extends ProseScanError {
  readonly fragment: string;
  constructor(fragment: string, reason: string) {
    super(`cannot use the rule fragment '${fragment}': ${reason}`);
    this.name = "PatternError";
    this.fragment = fragment;
  }
}

interface BracketResult {
  text: string;
  next: number;
}

function translateBracket(fragment: string, start: number): BracketResult {
  let i = start + 1;
  let negated = false;
  let body = "";
  if (fragment[i] === "^") {
    negated = true;
    i += 1;
  }
  // A "]" in first position is a literal one, not the end of the expression.
  if (fragment[i] === "]") {
    body += "\\]";
    i += 1;
  }
  let closed = false;
  while (i < fragment.length) {
    const ch = fragment[i]!;
    if (ch === "]") {
      closed = true;
      i += 1;
      break;
    }
    if (ch === "[" && (fragment[i + 1] === ":" || fragment[i + 1] === "." || fragment[i + 1] === "=")) {
      const kind = fragment[i + 1]!;
      const end = fragment.indexOf(`${kind}]`, i + 2);
      if (end === -1) {
        throw new PatternError(fragment, `a bracket expression opens '[${kind}' and never closes it`);
      }
      const name = fragment.slice(i + 2, end);
      if (kind !== ":") {
        const what = kind === "." ? "collating element" : "equivalence class";
        throw new PatternError(fragment, `the ${what} '[${kind}${name}${kind}]' has no JavaScript equivalent`);
      }
      const expansion = POSIX_CLASSES[name];
      if (expansion === undefined) {
        throw new PatternError(
          fragment,
          `the POSIX class '[:${name}:]' is not one this scan can translate ` +
            `(it knows ${SUPPORTED_POSIX_CLASSES.map((c) => `[:${c}:]`).join(", ")})`,
        );
      }
      body += expansion;
      i = end + 2;
      continue;
    }
    if (ch === "\\") {
      // POSIX reads a backslash inside a bracket expression as an ordinary
      // character; JavaScript reads it as an escape. Escaping it keeps the
      // meaning the rules author wrote.
      body += "\\\\";
      i += 1;
      continue;
    }
    body += ch;
    i += 1;
  }
  if (!closed) {
    throw new PatternError(fragment, "a bracket expression opens '[' and never closes it");
  }
  return { text: `[${negated ? "^" : ""}${body}]`, next: i };
}

/**
 * Turns one POSIX extended-regex fragment into a JavaScript regex source
 * string with the same meaning, or throws PatternError naming the fragment.
 */
export function translateEre(fragment: string): string {
  let out = "";
  let i = 0;
  while (i < fragment.length) {
    const ch = fragment[i]!;
    if (ch === "\\") {
      const next = fragment[i + 1];
      if (next === undefined) {
        throw new PatternError(fragment, "it ends with a backslash that escapes nothing");
      }
      if (next === "<" || next === ">" || next === "`" || next === "'") {
        throw new PatternError(
          fragment,
          `'\\${next}' is a GNU-only anchor with no JavaScript equivalent; use '\\b' for a word boundary`,
        );
      }
      out += ch + next;
      i += 2;
      continue;
    }
    if (ch === "[") {
      const bracket = translateBracket(fragment, i);
      out += bracket.text;
      i = bracket.next;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Joins fragments with "|", exactly as the bash built its grep pattern, and
 * returns the JavaScript regex source. An empty list yields an empty string,
 * which the caller must treat as "nothing to look for" and never hand to a
 * regex: an empty pattern matches every line.
 */
export function buildPatternSource(fragments: readonly string[]): string {
  return fragments.map((f) => translateEre(f)).join("|");
}

/** Compiles a pattern source, turning a JavaScript syntax error into exit 2. */
export function compilePattern(source: string, fragments: readonly string[], ignoreCase: boolean): RegExp {
  try {
    return new RegExp(source, ignoreCase ? "i" : "");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new PatternError(fragments.join("|"), `JavaScript will not compile it: ${reason}`);
  }
}

// --- rules --------------------------------------------------------------------

export interface Rules {
  /** Fragments applied to every scanned file. */
  fragments: string[];
  /** Fragments applied to prose files only. */
  proseOnly: string[];
  /** Globs never scanned in the default (no-argument) mode. */
  excludes: string[];
}

export function emptyRules(): Rules {
  return { fragments: [], proseOnly: [], excludes: [] };
}

/** The file access one rules load needs, injected so this core does no I/O. */
export interface RulesFileSystem {
  /** True when the path names an existing regular file, following symlinks. */
  isFile: (path: string) => boolean;
  /** The real, symlink-free absolute path, used only for cycle detection. */
  realPath: (path: string) => string;
  /** The directory holding a path, for resolving a relative include. */
  dirName: (path: string) => string;
  /** True when the path is absolute. */
  isAbsolute: (path: string) => boolean;
  /** Joins a directory and a relative path. */
  join: (dir: string, rel: string) => string;
  readText: (path: string) => string;
}

const LEADING_SPACE = /^[ \t\n\v\f\r]+/;

/** Strips leading whitespace only, keeping any trailing whitespace, as the bash did. */
function stripLeading(s: string): string {
  return s.replace(LEADING_SPACE, "");
}

/**
 * Splits text into lines the way a line-oriented tool does: a trailing
 * newline ends the last line and does not begin an empty one, and a final
 * line with no newline still counts.
 */
export function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function loadInto(rules: Rules, path: string, chain: readonly string[], fs: RulesFileSystem): void {
  if (!fs.isFile(path)) throw new ProseScanError(`rules file '${path}' does not exist`);
  let absolute: string;
  try {
    absolute = fs.realPath(path);
  } catch {
    throw new ProseScanError(`could not resolve '${path}'`);
  }
  if (chain.includes(absolute)) {
    throw new ProseScanError(`include cycle: '${path}' includes itself, directly or indirectly`);
  }
  const nextChain = [...chain, absolute];
  const dir = fs.dirName(absolute);

  let text: string;
  try {
    text = fs.readText(path);
  } catch {
    throw new ProseScanError(`rules file '${path}' is not readable`);
  }

  for (const line of splitLines(text)) {
    if (/^[ \t\n\v\f\r]*$/.test(line)) continue;
    if (/^[ \t\n\v\f\r]*#/.test(line)) continue;
    const trimmed = stripLeading(line);
    if (trimmed.startsWith("include:")) {
      const inc = stripLeading(trimmed.slice("include:".length));
      const incPath = fs.isAbsolute(inc) ? inc : fs.join(dir, inc);
      loadInto(rules, incPath, nextChain, fs);
    } else if (trimmed.startsWith("exclude:")) {
      rules.excludes.push(stripLeading(trimmed.slice("exclude:".length)));
    } else if (trimmed.startsWith("prose-only:")) {
      rules.proseOnly.push(stripLeading(trimmed.slice("prose-only:".length)));
    } else {
      rules.fragments.push(trimmed);
    }
  }
}

/** Reads one rules file and everything it includes, in the order read. */
export function loadRules(path: string, fs: RulesFileSystem): Rules {
  const rules = emptyRules();
  loadInto(rules, path, [], fs);
  return rules;
}

/** True when no fragment of any kind was configured, so nothing is checked. */
export function rulesAreEmpty(rules: Rules): boolean {
  return rules.fragments.length === 0 && rules.proseOnly.length === 0;
}

// --- prose versus source ------------------------------------------------------

const SOURCE_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".sh"];

/**
 * Decided by extension, case-insensitively, so "README.MD" is prose and
 * "Build.TS" is source. The bash folded case with ${1,,} for the same reason.
 */
export function isProseFile(path: string): boolean {
  const lower = path.toLowerCase();
  return !SOURCE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// --- fenced code blocks -------------------------------------------------------

const FENCE_LINE = /^[ \t\v\f\r]*```/;

/**
 * The 1-based numbers of the lines inside a fenced code block, the fence
 * lines themselves included. A fenced block in a prose file holds quoted
 * evidence: a command and what it printed. Word bans still apply in there,
 * but a typographic prose-only rule must not, because rewriting a line of
 * real output to please a style rule would falsify the evidence the file
 * exists to show.
 */
export function fencedLineNumbers(text: string): Set<number> {
  const inFence = new Set<number>();
  let open = false;
  const lines = splitLines(text);
  for (let i = 0; i < lines.length; i += 1) {
    if (FENCE_LINE.test(lines[i]!)) {
      open = !open;
      inFence.add(i + 1);
      continue;
    }
    if (open) inFence.add(i + 1);
  }
  return inFence;
}

// --- baselines ----------------------------------------------------------------

/**
 * Joins the file path and the trimmed matching text into one key. The
 * separator is a byte that appears in neither half.
 */
export const BASELINE_SEPARATOR = "\u001F";

const TRIM_EDGES = /^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g;

/**
 * Strips leading and trailing whitespace, keeping everything in between
 * (internal tabs included) exactly as matched. Used both when building a key
 * to write to a baseline and when reading one back, so the two stay
 * comparable.
 */
export function trimText(s: string): string {
  return s.replace(TRIM_EDGES, "");
}

export function baselineKey(file: string, text: string): string {
  return `${file}${BASELINE_SEPARATOR}${text}`;
}

/**
 * Reads a baseline file's text into the tally it records. Keyed on file path
 * and trimmed text; the count says how many times that exact text was
 * recorded as matching, so occurrence N is forgiven exactly when N does not
 * exceed the recorded count.
 */
export function parseBaseline(text: string, path: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of splitLines(text)) {
    if (/^[ \t\n\v\f\r]*$/.test(line)) continue;
    if (/^[ \t\n\v\f\r]*#/.test(line)) continue;
    // Split the way the bash did, so a malformed line is malformed for both.
    const firstTab = line.indexOf("\t");
    const count = firstTab === -1 ? line : line.slice(0, firstTab);
    const rest = firstTab === -1 ? line : line.slice(firstTab + 1);
    const restTab = rest.indexOf("\t");
    const file = restTab === -1 ? rest : rest.slice(0, restTab);
    const entryText = restTab === -1 ? rest : rest.slice(restTab + 1);
    if (!/^[0-9]+$/.test(count)) {
      throw new ProseScanError(`baseline file '${path}' has a malformed entry: '${line}'`);
    }
    counts.set(baselineKey(file, entryText), Number(count));
  }
  return counts;
}

const BASELINE_HEADER: readonly string[] = [
  "# Prose scan baseline for the agent-delivery-gates prose scan.",
  "#",
  "# Every match already present in this project when the baseline was",
  "# recorded, so turning the prose gate on does not fail on everything",
  "# the project already had. Meant to shrink over time: fix a match and",
  "# delete its line here, and the fix is checked in as the reason that",
  "# match stops being forgiven. Deleting a line makes that violation",
  "# fail again the next time it is seen.",
  "#",
  "# Keyed on the file path and the trimmed text of the matching line,",
  "# never on the line number, so inserting a line above a recorded",
  "# match does not invalidate it. The same text in a DIFFERENT file is",
  "# a different key and is not forgiven; a moved or renamed file",
  "# re-flags and needs its own entry here.",
  "#",
  "# Format: <count><TAB><file><TAB><trimmed line text>",
];

/** Byte order, which is what `LC_ALL=C sort` compares by. */
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * Renders a tally as a baseline file: the header, then one sorted
 * "<count><TAB><file><TAB><text>" line per key. Sorted so the file diffs
 * cleanly as it shrinks over time; the sort is the one `LC_ALL=C sort -t TAB
 * -k2,2 -k3,3` performs, which falls back to the whole line as a last
 * tiebreaker.
 */
export function formatBaseline(counts: ReadonlyMap<string, number>): string {
  const rows: string[] = [];
  for (const [key, count] of counts) {
    const sep = key.indexOf(BASELINE_SEPARATOR);
    const file = key.slice(0, sep);
    const text = key.slice(sep + 1);
    rows.push(`${count}\t${file}\t${text}`);
  }
  rows.sort((a, b) => {
    const fa = a.split("\t");
    const fb = b.split("\t");
    const byFile = byteCompare(fa[1] ?? "", fb[1] ?? "");
    if (byFile !== 0) return byFile;
    const byText = byteCompare(fa[2] ?? "", fb[2] ?? "");
    if (byText !== 0) return byText;
    return byteCompare(a, b);
  });
  return [...BASELINE_HEADER, ...rows, ""].join("\n");
}

// --- the scan -----------------------------------------------------------------

export interface ScanRequest {
  rules: Rules;
  /** The files to scan, in order, as the caller wants them named in output. */
  files: readonly string[];
  /** Reads one file as text. Throwing is reported as a file that could not be read. */
  readText: (path: string) => string;
  /** A baseline's tally, when --baseline was given. */
  baseline?: ReadonlyMap<string, number>;
  /** True when --write-baseline was given: record only, never fail. */
  recordOnly?: boolean;
}

export interface ScanResult {
  /** The "file:line:content" lines to print, in the order they were found. */
  matchLines: string[];
  scannedFiles: number;
  matchedFiles: number;
  totalMatches: number;
  forgivenMatches: number;
  newMatches: number;
  hadMatch: boolean;
  /** The tally of every match seen, the thing --write-baseline writes out. */
  counts: Map<string, number>;
}

/**
 * Runs the scan. Every decision the bash made, in the order it made them:
 * pick the pattern for the file's kind, skip the file when that pattern is
 * empty (an empty extended regex matches every line, so an empty pattern is
 * never a no-op), read every byte as text so one NUL cannot make a file
 * invisible, drop a match inside a fence unless it also matches what a
 * source file would be checked against, then tally, forgive, or report it.
 */
export function scan(request: ScanRequest): ScanResult {
  const { rules, files, readText } = request;
  const codeSource = buildPatternSource(rules.fragments);
  const proseSource = buildPatternSource([...rules.fragments, ...rules.proseOnly]);
  const codePattern = codeSource === "" ? undefined : compilePattern(codeSource, rules.fragments, true);
  const prosePattern =
    proseSource === "" ? undefined : compilePattern(proseSource, [...rules.fragments, ...rules.proseOnly], true);
  // The fence re-check is the source pattern applied to one line, and it
  // folds case exactly as the main match does. Anything else would drop an
  // uppercase banned word written inside a fence: the main match would find
  // the line and the re-check would then fail to confirm it, so the one
  // place a banned word is most likely to be shouted would go unreported.
  const fencePattern = codeSource === "" ? undefined : compilePattern(codeSource, rules.fragments, true);

  const counts = new Map<string, number>();
  const result: ScanResult = {
    matchLines: [],
    scannedFiles: files.length,
    matchedFiles: 0,
    totalMatches: 0,
    forgivenMatches: 0,
    newMatches: 0,
    hadMatch: false,
    counts,
  };

  for (const file of files) {
    const prose = isProseFile(file);
    const pattern = prose ? prosePattern : codePattern;
    if (pattern === undefined) continue;

    let text: string;
    try {
      text = readText(file);
    } catch {
      throw new ProseScanError(`error reading '${file}'`);
    }

    const inFence = prose ? fencedLineNumbers(text) : new Set<number>();
    const lines = splitLines(text);
    let fileHadNew = false;

    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i]!;
      if (!pattern.test(raw)) continue;
      const lineNumber = i + 1;
      // The bash captured grep's output through a command substitution, which
      // drops NUL bytes. The match itself was made against the bytes on disk,
      // so the match decision above reads the raw line and everything after
      // this point reads the line as it would have been printed.
      const content = raw.includes("\u0000") ? raw.split("\u0000").join("") : raw;
      if (inFence.has(lineNumber)) {
        // Nothing applies inside a fence when every fragment is prose-only.
        if (fencePattern === undefined) continue;
        if (!fencePattern.test(content)) continue;
      }
      const text_ = trimText(content);
      const key = baselineKey(file, text_);
      const occurrence = (counts.get(key) ?? 0) + 1;
      counts.set(key, occurrence);
      result.totalMatches += 1;

      if (request.recordOnly) continue;

      const matchLine = `${file}:${lineNumber}:${content}`;
      if (request.baseline !== undefined) {
        const recorded = request.baseline.get(key) ?? 0;
        if (occurrence <= recorded) {
          result.forgivenMatches += 1;
          continue;
        }
      }
      result.newMatches += 1;
      fileHadNew = true;
      result.matchLines.push(matchLine);
    }

    if (fileHadNew) {
      result.matchedFiles += 1;
      result.hadMatch = true;
    }
  }

  return result;
}

/** How many baseline entries were not seen this run, so are safe to delete. */
export function baselineEntriesNotSeen(
  baseline: ReadonlyMap<string, number>,
  counts: ReadonlyMap<string, number>,
): number {
  let notSeen = 0;
  for (const key of baseline.keys()) {
    if ((counts.get(key) ?? 0) === 0) notSeen += 1;
  }
  return notSeen;
}

/**
 * The report the scan prints after the match lines, without the trailing
 * newline on the last entry: one line for what was scanned, and with a
 * baseline in play two more for what it forgave and what it no longer needs.
 */
export function formatReport(
  result: ScanResult,
  baseline?: { path: string; counts: ReadonlyMap<string, number> },
): string[] {
  const lines = [`scan-prose: scanned ${result.scannedFiles} file(s), ${result.matchedFiles} contained matches`];
  if (baseline !== undefined) {
    const notSeen = baselineEntriesNotSeen(baseline.counts, result.counts);
    lines.push(
      `scan-prose: baseline ${baseline.path}: ${result.totalMatches} found, ` +
        `${result.forgivenMatches} forgiven, ${result.newMatches} new`,
    );
    lines.push(
      `scan-prose: ${notSeen} baseline entries not seen this run ` +
        `(fixed; safe to delete from ${baseline.path})`,
    );
  }
  return lines;
}

/** Exit 1 when a match the baseline does not forgive was found, else exit 0. */
export function exitCodeFor(result: ScanResult): number {
  return result.hadMatch ? 1 : 0;
}
