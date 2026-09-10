// Where the code is on a line, and where the text merely looks like code.
//
// One scanner, two callers. `adg mutate` uses it to refuse to break a token
// that sits inside a string, a comment, or a regular expression, since a
// mutation applied there is not a mutation of the program. `adg test-diff`
// uses it to refuse to read a weakening signal out of a fixture string or a
// test name, since a detector word written inside a literal is not a
// weakening of anything.
//
// It lived in src/mutate.ts first. It moved here so test-diff could use it
// without closing an import loop: src/mutate.ts already imports from
// src/test-diff-separator.ts, so src/test-diff-separator.ts cannot import
// from src/mutate.ts. This module imports nothing.
//
// KNOWN LIMIT, per line. A caller that hands over one line at a time cannot
// be told about a string that opened on an earlier line:
//
//   const xml = `
//     <skipped type="pytest.skip"/>
//   `;
//
// The middle line carries no quote of its own, so scanned alone it reads as
// ordinary code and its detector words stand. Handing whole files in would
// fix it, and the diff callers have no whole file to hand in: a diff line is
// all they hold. For a test file where this is common, the fixture marker
// (`adg-test-diff: fixtures`) is the answer, not this scanner.

/** A character that may appear inside an identifier. */
export const IDENT_CHAR = /[A-Za-z0-9_$]/;

/** Inside a string, a template, a regular expression, or a comment. */
const LITERAL = 0;
/** Ordinary code. */
const CODE = 1;
/**
 * The opening or closing character of a string, a template, or a regular
 * expression. Punctuation the language reads, holding no text of its own.
 * `codeMask` counts it as not code, exactly as it always did. `maskNonCode`
 * keeps it, because a pattern such as RSpec's `it "..."` is recognised by
 * the quote that follows the word, and blanking that quote would lose the
 * test-case opener along with the test's name.
 */
const DELIMITER = 2;

/**
 * Classifies every character of `text` as LITERAL, CODE, or DELIMITER.
 *
 * What it handles: single and double quoted strings with backslash escapes,
 * backtick template literals, line comments, block comments across any
 * number of lines, and a regular-expression literal told from a division by
 * what precedes the slash.
 *
 * What it does not handle, stated plainly:
 *   - A template literal is skipped whole, from its opening backtick to the
 *     matching closing one, with every ${...} interpolation inside it
 *     counted as string too. Nesting is tracked, so a template literal
 *     written inside an interpolation closes on its own backtick and not on
 *     the outer literal's. Nothing inside a template literal is ever
 *     mutated, and nothing inside one is ever read as a signal: that loses
 *     candidates and invents none.
 *   - Inside an interpolation the scan counts braces to find the end. An
 *     unescaped closing brace written inside a regular expression literal
 *     there, as in ${x.replace(/}/g, "")}, ends the interpolation early.
 *     What follows is still read as template text, so the literal still
 *     ends at the right backtick and no candidate is invented, unless a
 *     backtick appears in the part that was misread.
 *   - A regular-expression literal is told from division by a look-back
 *     heuristic. Where the guess goes wrong it goes toward "string", so
 *     again a candidate is lost and none is invented.
 *   - Only the C-family comment forms are known here. A `#` comment, as in
 *     Python, Ruby, or a shell script, stays code. The two callers each run
 *     a whole-line comment check of their own before this one, so a line
 *     that is nothing but a `#` comment is already gone; what stays is a
 *     `#` comment trailing real code on the same line.
 *   - JSX text between tags counts as code, so a comparison operator
 *     written inside JSX text could in principle be picked up. The
 *     whitespace rule in src/mutate.ts makes that unlikely and the mutation
 *     would still compile.
 *   - Nothing here understands the preprocessor, a heredoc, or PHP's
 *     mixed HTML mode.
 * Losing a candidate is the safe direction: a missed mutation understates
 * what the suite fails to catch, while a mutation that cannot compile
 * would be scored as killed and would overstate it. A missed signal is
 * likewise quieter than a signal invented out of a fixture.
 */
function classify(text: string, loneTickIsCode = false): Uint8Array {
  const kinds = new Uint8Array(text.length); // LITERAL everywhere until proven otherwise
  let i = 0;
  // The last non-space code character seen, used to tell a regular
  // expression literal from a division.
  let lastCode = "";
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === "'" && loneTickIsCode && isLoneTick(text, i)) {
      // See isLoneTick: a tick with no partner on the line cannot open a
      // finished literal, and reading it as one blanks real code to the end
      // of the line.
      i += 1;
      lastCode = "x";
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = skipQuoted(text, i);
      markDelimiters(kinds, text, i, end, ch);
      i = end;
      lastCode = "x";
      continue;
    }
    if (ch === "`") {
      const end = skipTemplate(text, i);
      markDelimiters(kinds, text, i, end, "`");
      i = end;
      lastCode = "x";
      continue;
    }
    if (ch === "/" && startsRegex(lastCode)) {
      const start = i;
      i++;
      let inClass = false;
      while (i < text.length) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === "[") inClass = true;
        else if (text[i] === "]") inClass = false;
        else if (text[i] === "/" && !inClass) {
          i++;
          break;
        } else if (text[i] === "\n") break;
        i++;
      }
      markDelimiters(kinds, text, start, i, "/");
      lastCode = "x";
      continue;
    }

    kinds[i] = CODE;
    if (ch.trim() !== "") lastCode = ch;
    i++;
  }
  return kinds;
}

/**
 * Marks the opening character of a literal running from `start` up to but
 * not including `end`, and its closing character when the literal actually
 * closed on that character. An unterminated literal, one that ran to a line
 * end or to the end of the text, has an opener and no closer.
 */
function markDelimiters(kinds: Uint8Array, text: string, start: number, end: number, delim: string): void {
  kinds[start] = DELIMITER;
  if (end - 1 > start && text[end - 1] === delim) kinds[end - 1] = DELIMITER;
}

/**
 * Marks every character of `text` that is ordinary code, as against one
 * inside a string literal, a character literal, a template literal, a
 * regular-expression literal, or a comment. A mutation may only be applied
 * where this says true. A literal's own opening and closing punctuation
 * reads as not code here, which is what it always did.
 *
 * See `classify` above for what the scan handles and what it does not.
 */
export function codeMask(text: string): boolean[] {
  const kinds = classify(text);
  const mask = new Array<boolean>(text.length);
  for (let i = 0; i < text.length; i++) mask[i] = kinds[i] === CODE;
  return mask;
}

/**
 * Returns `text` with every character inside a string, a template, a
 * regular expression, or a comment replaced by a space. Length is
 * preserved, so a column in the result is the same column in the input,
 * and the punctuation that opens and closes a literal stays put.
 *
 * This is for testing a pattern, never for reporting. A caller that finds
 * something here must report the original line: a person reading a signal
 * has to see the real text, not a line with holes cut in it.
 *
 * The per-line limit at the top of this file applies to every caller that
 * hands over one line at a time.
 */
export function maskNonCode(text: string): string {
  // A tick with no partner is read as code here, and as a literal opener in
  // codeMask above. The two callers want opposite safe directions. codeMask
  // decides what may be mutated, where inventing a candidate inside a string
  // would produce text that does not compile, so it stays cautious. This
  // decides what a detector may look at, where losing a marker is a silent
  // miss and a word left visible only costs someone a look. See isLoneTick.
  const kinds = classify(text, true);
  let out = "";
  for (let i = 0; i < text.length; i++) out += kinds[i] === LITERAL ? " " : text[i];
  return out;
}

/**
 * Skips a single or double quoted string, from its opening quote, and
 * returns the index just past its closing quote. An unterminated string
 * ends at the line end, so a stray apostrophe in a comment-like line cannot
 * swallow the rest of the file.
 */
/**
 * True when the tick at `start` has no partner on the rest of its line, so it
 * cannot open a finished literal at all. A Rust lifetime is the common case:
 * `&'static str` and `<'a>` carry a lone tick. Read as a string opener, a
 * lone tick swallows everything after it, and a line like
 * `let s: &'static str = "x"; assert!(ok);` loses its assert!, which callers
 * of this file read as a marker. Treating it as code instead is the safer
 * reading: an unfinished literal was never going to be masked correctly, and
 * blanking to the end of the line hides real code.
 *
 * A tick with a partner stays a literal, so an ordinary single-quoted string
 * and a Rust character literal are both untouched.
 */
function isLoneTick(text: string, start: number): boolean {
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "\n") return true;
    if (ch === "'") return false;
  }
  return true;
}

function skipQuoted(text: string, start: number): number {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    if (ch === "\n") return i;
    i++;
  }
  return i;
}

/**
 * Skips a template literal, from its opening backtick, and returns the
 * index just past the matching closing backtick. Every ${...} inside is
 * skipped by skipInterpolation below, which is what keeps a template
 * literal nested inside an interpolation from closing the outer one: that
 * bug read the inner literal's opening backtick as the outer literal's
 * close, and then mutated the code that followed.
 */
function skipTemplate(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") return i + 1;
    if (ch === "$" && text[i + 1] === "{") {
      i = skipInterpolation(text, i + 2);
      continue;
    }
    i++;
  }
  return i;
}

/**
 * Skips the body of a ${...} interpolation, from the index just past the
 * opening brace, and returns the index just past its matching closing
 * brace. Braces are counted, and a string, a template literal, or a
 * backslash escape inside the body is skipped whole, so a brace written in
 * one of those does not end the body early.
 */
function skipInterpolation(text: string, start: number): number {
  let i = start;
  let depth = 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") {
      i = skipTemplate(text, i);
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipQuoted(text, i);
      continue;
    }
    if (ch === "{") {
      depth++;
      i++;
      continue;
    }
    if (ch === "}") {
      depth--;
      i++;
      if (depth === 0) return i;
      continue;
    }
    i++;
  }
  return i;
}

/**
 * True when a slash in this position opens a regular expression literal.
 * A slash right after a value (an identifier, a number, a closing bracket)
 * is a division; anywhere else it opens a literal. `}` counts as a value
 * here, which is wrong for a block that just closed, but that reading only
 * ever loses candidates.
 */
function startsRegex(lastCode: string): boolean {
  if (lastCode === "") return true;
  if (IDENT_CHAR.test(lastCode)) return false;
  return !(lastCode === ")" || lastCode === "]" || lastCode === "}");
}

// --- the language-service seam ------------------------------------------------
//
// Everything above this line answers "where is the code" for the C-family
// and JavaScript-family languages only, using regexes and hand-written
// heuristics like isLoneTick. That is the whole of what this file's own
// doc comment lists as its known limits: no per-file state across lines,
// no `#` comments, no Python triple-quoted strings, and so on.
//
// A `LanguageService` names the two things a caller actually needs from a
// scanner: codeMask to decide where a mutation may land, maskNonCode to
// decide where a detector may read. Both callers, src/mutate.ts and
// src/test-diff-separator.ts, use nothing else from this file except the
// IDENT_CHAR character class, which is about identifier syntax and not
// literal scanning, and stays a plain export, not part of the seam.
//
// Wrapping the existing functions as `regexLanguageService` changes no
// behaviour: it is the same `classify` underneath, reached through one more
// layer of indirection.
//
// A first version of this seam kept the chosen service in a module-level
// variable, set once by a `selectLanguageService` call and read back by
// `getLanguageService`. Two problems with that survived review before
// anything called it: nothing ever reset it, so one test choosing a
// non-default service would leak into every test that ran after it in the
// same file; and a single global can only ever hold one language for an
// entire process, which cannot express what this phase exists to start,
// per-file dispatch across a repository that mixes languages. Both callers
// already know the path of the file they are scanning when they ask for a
// mask, so `languageServiceFor(path)` replaces the global outright: the
// choice is made fresh from that path on every call, and there is no
// process-lifetime state left to leak between callers or between tests.

/** What a caller needs from a source-language scanner. */
export interface LanguageService {
  /** See `codeMask` above. */
  codeMask(text: string): boolean[];
  /** See `maskNonCode` above. */
  maskNonCode(text: string): string;
}

/** The regex-and-heuristic scanner this file has always run, wrapped to the
 * interface callers now go through. Byte-for-byte the same scanner as
 * before this seam existed. Still the answer for every extension this file
 * does not name a more specific service for below. */
export const regexLanguageService: LanguageService = {
  codeMask,
  maskNonCode,
};

// The tree-sitter-backed Python service, once loading it has been tried for
// this process. `undefined` means "never tried yet", which is also this
// module's initial state: nothing here imports web-tree-sitter or
// tree-sitter-python at module load, so a process that never touches a
// `.py` file never even attempts it. A value of `regexLanguageService`
// here records a real, already-made decision: the load was tried and
// failed (the dev dependencies are not installed), and falling back to the
// regex scanner for `.py` files is what this project did before this
// service existed, so that is the answer once and for all for this
// process, not retried on every call.
let pythonService: LanguageService | undefined;

async function resolvePythonService(): Promise<LanguageService> {
  if (pythonService !== undefined) return pythonService;
  try {
    const { loadPythonLanguageService } = await import("./tree-sitter-python-service.ts");
    pythonService = await loadPythonLanguageService();
  } catch {
    // No web-tree-sitter, no tree-sitter-python, or the wasm grammar itself
    // failed to load: on any of those, a `.py` file gets exactly the
    // scanner it always got, and nothing above this catch throws.
    pythonService = regexLanguageService;
  }
  return pythonService;
}

/**
 * Loads whichever language services a batch of files will actually need,
 * before any of them is scanned. `languageServiceFor` below is
 * synchronous, because both callers need to call it deep inside otherwise
 * synchronous, per-line and per-file logic; loading a WASM grammar is not
 * synchronous, so the load has to happen here, ahead of time, from a
 * caller that already knows every path it is about to process. A path
 * list with no `.py` file in it returns immediately having imported
 * nothing. Safe to call more than once: the second call for a process
 * that already resolved the Python service returns at once.
 */
export async function warmLanguageServices(paths: readonly string[]): Promise<void> {
  if (pythonService !== undefined) return;
  if (!paths.some((path) => path.toLowerCase().endsWith(".py"))) return;
  await resolvePythonService();
}

/**
 * The scanner for one file, chosen from its path, not from any state
 * carried between calls. Every extension other than `.py` gets the regex
 * scanner this file has always run, unchanged. A `.py` file gets the
 * tree-sitter-backed service when `warmLanguageServices` was able to load
 * it for this process, and the regex scanner otherwise, including for a
 * caller that never called `warmLanguageServices` at all: that keeps every
 * caller written before this function existed working exactly as it did.
 */
export function languageServiceFor(path: string): LanguageService {
  if (path.toLowerCase().endsWith(".py") && pythonService !== undefined) return pythonService;
  return regexLanguageService;
}
