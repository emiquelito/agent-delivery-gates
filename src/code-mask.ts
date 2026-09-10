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
// from src/mutate.ts. This module imports nothing that could reopen that
// loop: src/tree-sitter-grammars.ts below is pure per-language data (node
// type names, package and wasm file names), with no import of its own on
// web-tree-sitter or any grammar package, so importing it here costs
// nothing at module load and pulls in nothing mutate.ts or
// test-diff-separator.ts would circle back through.
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

import { GRAMMAR_SPECS } from "./tree-sitter-grammars.ts";

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

// --- the per-extension registry ------------------------------------------
//
// Finding 1 from three earlier builders of this phase: a single inline
// `.py` check does not scale to six more languages. What it becomes
// instead is one table, keyed by lowercase extension, from which a
// seventh language is added by adding one more entry and, for anything
// beyond Python's bespoke tree-sitter-python-service.ts, one more
// GrammarSpec in src/tree-sitter-grammars.ts -- no new file, no touched
// function here.
//
// Each entry is a *loader*, not a service: calling it is what imports
// web-tree-sitter and evaluates a wasm file, so a repository with no file
// of a given language never calls that language's entry and never pays
// for it. Python keeps its own bespoke loader, wired to the module that
// predates this registry and already has its own 1199-test history behind
// it; every other language shares one generic loader
// (loadTreeSitterLanguageService in src/tree-sitter-language-service.ts)
// parameterised by that language's GrammarSpec.
const TREE_SITTER_LOADERS: Readonly<Record<string, () => Promise<LanguageService>>> = {
  ".py": async () => {
    const { loadPythonLanguageService } = await import("./tree-sitter-python-service.ts");
    return loadPythonLanguageService();
  },
  ...Object.fromEntries(
    Object.entries(GRAMMAR_SPECS).map(([ext, spec]) => [
      ext,
      async () => {
        const { loadTreeSitterLanguageService } = await import("./tree-sitter-language-service.ts");
        return loadTreeSitterLanguageService(spec.packageName, spec.wasmFileName, spec.config);
      },
    ]),
  ),
};

// One resolved service per extension, once loading it has been tried for
// this process. A key absent from this map means "never tried yet",
// which is also this module's initial state: nothing here imports
// web-tree-sitter or any grammar package at module load, so a process
// that never touches a file of a given language never even attempts it.
// A value of `regexLanguageService` for a key records a real,
// already-made decision: the load was tried and failed (the dev
// dependency is not installed, or the wasm file failed to load), and
// falling back to the regex scanner for that extension is what this
// project did before that language's service existed, so that is the
// answer once and for all for this process, not retried on every call.
const resolvedServices = new Map<string, LanguageService>();

// Extensions whose tree-sitter grammar was actually attempted, through
// `warmLanguageServices`, and did not resolve to a working service: the
// devDependency that ships its grammar (tree-sitter-python,
// web-tree-sitter, or one of the six packages src/tree-sitter-grammars.ts
// names) is not installed -- an ordinary adopter's `npm install`, since
// none of those packages are a runtime dependency of this one -- or it is
// installed and something about the load still went wrong (a corrupt
// wasm file, an ABI mismatch between web-tree-sitter and a grammar built
// against a different version, a truncated install).
//
// This is a different fact from `resolvedServices` holding
// `regexLanguageService` for that extension: that map also holds
// `regexLanguageService` for an extension that loaded its grammar
// perfectly and simply has no tree-sitter loader at all (every extension
// outside TREE_SITTER_LOADERS). Reading resolvedServices alone cannot
// tell "this language has no better scanner" apart from "this language
// has a better scanner and it failed to load this time" -- and a caller
// that cannot tell them apart cannot tell a Python file whose docstring
// mask is trustworthy from one where it silently is not. That gap is what
// let `adg mutate` rewrite a docstring's True/False and and/or on any
// machine that never installed tree-sitter-python: the fallback looked
// identical to "no tree-sitter service for this extension exists," which
// mutate.ts already knew was safe.
//
// STOP-GAP, split in two. A CRITICAL finding on this project's own commit
// history: every one of these packages ships as a devDependency, and this
// package's own package.json carries no `dependencies` key at all (see
// package.json's own header comment and the README's "zero dependencies"
// claim), so an adopter who installs this tool the way its own quickstart
// says to (`npm install --save-dev agent-delivery-gates`) gets every one
// of these grammars absent, permanently, for every process this tool ever
// runs for them. Before this split, "not installed" and "installed but
// broken" were the same fact, `grammarLoadFailures`, and every consumer of
// it treated both as a hard block -- which meant the majority case for a
// real adopter (nothing installed, because npm never installs a
// dependency's devDependencies) failed every commit touching Python,
// Rust, Go, Java, PHP, C#, or Ruby, forever, with no escape hatch. That is
// worse than the silent-corruption bug this project exists to catch.
//
// The two facts below are kept apart because they deserve different
// reactions. `grammarAbsentExtensions` is an environment fact, true for
// nearly every adopter today, and not a defect in anyone's commit: the
// right response is to say so loudly and get out of the way (see each
// consumer's own comment -- src/agent-adapter.ts's runTestDiffGate,
// hooks/test-diff-post-tool-hook.ts, hooks/test-diff-separator.ts,
// src/mcp-server.ts's runSeparateTestDiff -- for what "loudly" means for
// that consumer). `grammarGenuineFailures` is a real problem: the package
// is there and something is still wrong, which is exactly the class of
// bug (a corrupt install, an ABI mismatch) worth blocking on the way the
// undivided set used to block on everything.
//
// This split is a stop-gap, not the fix. The actual fix is shipping the
// grammars where an ordinary `npm install` reaches them -- bundling the
// wasm files this tool already needs, or moving the packages to
// `optionalDependencies`, a later phase of this project with its own
// evidence to gather (wasm file size across all seven languages,
// optionalDependencies' own failure modes on an adopter's install). Until
// that phase ships, `grammarAbsentExtensions` is the honest answer for
// what every adopter following this project's own README sees today, and
// nothing here should be read as more permanent than that.
//
// `hadLanguageLoadFailure` below answers the union of both sets on
// purpose: src/mutate.ts writes to the files it masks, so it needs "is
// this mask trustworthy at all", not which of the two reasons it is not.
// A consumer that instead needs to tell them apart -- to warn on one and
// block on the other -- reads `hadGrammarAbsent` and
// `hadGenuineGrammarLoadFailure` directly.
//
// Both sets are permanent for the life of the process, exactly like
// resolvedServices above and for the same reason: the load is tried once
// per extension, and a devDependency that failed to import once is not
// going to start importing successfully later in the same run.
const grammarAbsentExtensions = new Set<string>();
const grammarGenuineFailures = new Set<string>();

/**
 * True when `err` is Node's own "could not resolve this module at all"
 * error: the package a grammar loader needs (tree-sitter-python,
 * web-tree-sitter, or one of the six packages src/tree-sitter-grammars.ts
 * names) was never installed. CommonJS's `require.resolve` (used by
 * resolveWasmPath in both src/tree-sitter-python-service.ts and
 * src/tree-sitter-language-service.ts) reports this as `MODULE_NOT_FOUND`;
 * an ESM dynamic `import()` of a specifier that cannot be resolved (which
 * is what happens here when web-tree-sitter itself, imported at the top
 * of either of those files, is absent) reports `ERR_MODULE_NOT_FOUND`.
 * Anything else -- a corrupt wasm file, an ABI mismatch, a truncated
 * install -- reaches this loader with the package present and some other
 * error code (or none at all), and is a real failure, not an absence.
 */
function isModuleAbsenceError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND";
}

// Test-only escape hatch for reaching a real grammar-load failure without
// touching this process's real node_modules. A reviewer's first repro
// renamed tree-sitter-python and web-tree-sitter out of node_modules,
// spawned the CLI as a subprocess against the crippled tree, and restored
// the packages in a try/finally. Two hazards came with that: a SIGKILL of
// the test process (this suite's own help text warns that a SIGKILL "leaves
// the last mutated file mutated on disk" -- the same class of problem, one
// level up -- and this suite has been killed mid-run before) skips the
// finally block and leaves the package renamed for whatever runs next on
// this machine; and `node --test tests/*.test.ts` runs test files in
// parallel processes, so another file's in-process import of the real
// package can land mid-rename and fail for a reason that has nothing to do
// with what it is testing (reproduced: 0 successful imports out of 40
// during the churn window).
//
// This variable removes the filesystem from the picture entirely: a test
// that wants a grammar load to fail sets ADG_TEST_FORCE_GRAMMAR_FAILURE to
// a comma-separated list of extensions in the subprocess's own environment
// (nothing outside that one process's env is touched, so nothing needs
// restoring and nothing else sharing the real node_modules can be
// affected), and resolveTreeSitterService below skips the real load for
// exactly those extensions -- the same code path a real, present-but-broken
// grammar takes, `grammarGenuineFailures` included, just reached without
// deleting or moving a single file. Read once at module load, the same way
// this project already reads ADG_TEST_MCP_STALL in src/mcp-server.ts for
// an identical reason: a name a real adopter is never going to set by
// accident, doing nothing unless a test deliberately sets it. See
// docs/test-only-env-vars.md for what an ADG_TEST_* variable is and is not
// allowed to do; this one conforms by picking a branch the real loader
// already has, at the one point that loader is called, with everything
// downstream reading the same recorded failure a real one would leave.
//
// ADG_TEST_FORCE_GRAMMAR_ABSENT is the same idea for the other branch: a
// test that wants to reach "the package was never installed" -- the
// majority case for a real adopter, see grammarAbsentExtensions above --
// without an adopter's node_modules actually missing anything, and without
// this repository's own devDependencies (needed by every other test in
// this suite) ever being touched.
const FORCED_GRAMMAR_FAILURES: ReadonlySet<string> = new Set(
  (process.env.ADG_TEST_FORCE_GRAMMAR_FAILURE ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0),
);

const FORCED_GRAMMAR_ABSENT: ReadonlySet<string> = new Set(
  (process.env.ADG_TEST_FORCE_GRAMMAR_ABSENT ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0),
);

function extensionOf(path: string): string {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot === -1 ? "" : lower.slice(dot);
}

async function resolveTreeSitterService(ext: string): Promise<LanguageService> {
  const cached = resolvedServices.get(ext);
  if (cached !== undefined) return cached;
  const load = TREE_SITTER_LOADERS[ext];
  let service = regexLanguageService;
  if (load !== undefined && FORCED_GRAMMAR_FAILURES.has(ext)) {
    // See FORCED_GRAMMAR_FAILURES above: a test asked this extension's
    // load to fail (present but broken) without touching node_modules.
    // Recorded exactly like a real, present-but-broken failure below, and the real
    // loader is never called.
    service = regexLanguageService;
    grammarGenuineFailures.add(ext);
  } else if (load !== undefined && FORCED_GRAMMAR_ABSENT.has(ext)) {
    // See FORCED_GRAMMAR_ABSENT above: a test asked this extension's
    // package to read as never installed, without touching node_modules.
    // Recorded exactly like a real absence below, and the real loader is
    // never called.
    service = regexLanguageService;
    grammarAbsentExtensions.add(ext);
  } else if (load !== undefined) {
    try {
      service = await load();
    } catch (err) {
      // The package was never installed, or it is installed and
      // something about the load still went wrong (a corrupt wasm file,
      // an ABI mismatch): either way, a file of this extension gets
      // exactly the scanner it always got, and nothing above this catch
      // throws. isModuleAbsenceError tells the two apart at the one
      // point this loader is actually called, so everything downstream
      // -- src/mutate.ts, which writes to the file this mask decides
      // where to cut, and needs to know only "is this mask trustworthy";
      // the four production readers of a diff's signals, which need to
      // know which of the two this is, since only one of them deserves
      // to block a commit -- reads a recorded fact instead of re-deriving
      // it.
      service = regexLanguageService;
      if (isModuleAbsenceError(err)) {
        grammarAbsentExtensions.add(ext);
      } else {
        grammarGenuineFailures.add(ext);
      }
    }
  }
  resolvedServices.set(ext, service);
  return service;
}

/**
 * True when `ext`'s tree-sitter grammar was attempted, through
 * `warmLanguageServices`, and did not resolve to a working service, for
 * either reason: never installed (`grammarAbsentExtensions`) or installed
 * and broken (`grammarGenuineFailures`). False both for an extension never
 * attempted yet (including one with no tree-sitter service at all, which
 * was never going to be attempted) and for one that loaded successfully --
 * so this answers a different question than `hadUnwarmedLanguageAccess`
 * below. That one says a caller asked for a mask before warming ran at
 * all, which a later warm call can still fix. This one says warming ran,
 * was given the chance to succeed, and did not: no later call in this
 * process is going to change the answer.
 *
 * This is the union on purpose, kept under its original name for
 * src/mutate.ts, its one caller: a tool that writes to the files it masks
 * needs "is this mask trustworthy at all" and nothing more specific --
 * mutating a file with the wrong scanner is exactly as destructive whether
 * the grammar was never installed or was installed and broken. A caller
 * that instead needs to tell the two reasons apart -- every consumer of a
 * diff's signals does, see the STOP-GAP comment above
 * grammarAbsentExtensions -- reads `hadGrammarAbsent` and
 * `hadGenuineGrammarLoadFailure` below directly instead of this one.
 */
export function hadLanguageLoadFailure(ext: string): boolean {
  return grammarAbsentExtensions.has(ext) || grammarGenuineFailures.has(ext);
}

/**
 * True when `ext`'s tree-sitter grammar was attempted and the package
 * that ships it was never installed -- the ordinary state of every one of
 * the seven tree-sitter-backed languages for an adopter who installed
 * this tool the way its own README says to (`npm install --save-dev
 * agent-delivery-gates`; see the STOP-GAP comment above
 * grammarAbsentExtensions for why that leaves every one of these packages
 * absent). Not a defect in anyone's commit, so a caller reading this
 * should warn, not block. False when the extension was never attempted,
 * loaded successfully, or failed for a different reason -- see
 * `hadGenuineGrammarLoadFailure` for that last case.
 */
export function hadGrammarAbsent(ext: string): boolean {
  return grammarAbsentExtensions.has(ext);
}

/**
 * True when `ext`'s tree-sitter grammar was attempted, the package that
 * ships it resolved, and the load still failed: a corrupt wasm file, an
 * ABI mismatch, a truncated install. Unlike `hadGrammarAbsent`, this is a
 * real problem worth being loud about -- worth blocking on, in every
 * production consumer of a diff's signals -- because it says something is
 * actually broken in this environment or this gate, not merely that a
 * devDependency was never installed.
 */
export function hadGenuineGrammarLoadFailure(ext: string): boolean {
  return grammarGenuineFailures.has(ext);
}

// Records a fact `languageServiceFor` cannot report through its own return
// value: that a path was answered by the regex scanner not because the
// load was tried and failed, but because nothing had asked it to try yet.
// That distinction matters because a caller who never warms keeps
// reintroducing the same bug this project has already hit more than once
// (see planMutationsWarmed in src/mutate.ts, and src/agent-adapter.ts's
// runTestDiffGate before this file's own history added a fourth, then a
// fifth, warm call by hand). Set here, inside the one function every
// caller already goes through, so the fact survives even a future caller
// nobody adds a comment for. Cleared by `separateTestDiffWarmed`'s own
// caller reading `resetUnwarmedLanguageAccess`/`hadUnwarmedLanguageAccess`
// around one synchronous batch of work; see src/test-diff-separator.ts.
//
// Generalised in this phase from a Python-only flag to one that covers
// every tree-sitter-backed language in the registry above: the bug class
// (a caller reads a mask before its grammar finished loading, and gets
// the regex fallback silently) is the same bug for a `.rs` file as it was
// for `.py`, so one flag answers "did this batch hit that bug for any
// language it touched", not one flag per language.
//
// A reviewer found that this stayed a plain boolean, and `SeparateResult`
// kept the boolean's historic name, `unwarmedPythonUsed`, past the point
// where the flag actually covers seven languages: src/agent-adapter.ts's
// failure message named Python, blamed docstrings and f-strings, for a
// diff that carried none, because the flag it read could say only "some
// registered extension was unwarmed", never which one. Fixed by
// recording the actual extensions hit, not just that one was: nothing
// outside this repository reads `unwarmedPythonUsed` or
// `hadUnwarmedPythonAccess` (this is an internal gate, not a published
// library), so there is no external caller to keep either name for.
const unwarmedExtensions = new Set<string>();

// Re-entrancy guard for the reset/read pair above. `separateTestDiff`
// documents itself as synchronous end to end specifically so that a
// module-level flag can be reset before its own work and read back after,
// with no other call able to run in between and blur one batch's answer
// into another's. That invariant is enforced today only by that comment;
// nothing fails if a future refactor adds an `await` somewhere in
// separateTestDiff's call graph and lets two calls interleave. This flag
// makes that failure loud instead of silent: a reset while a previous
// batch's reset has not yet been matched by a read throws immediately,
// instead of quietly letting the second batch's answer bleed into the
// first's.
let unwarmedAccessBatchOpen = false;

/** The extensions (".py", ".rs", and so on) this process has answered a
 * mask request for, for a file whose extension has a tree-sitter service,
 * with the regex scanner because `warmLanguageServices` had not yet
 * resolved that service for it -- not because the load was tried and
 * failed. Empty when a caller always warms before asking (every
 * production entry point this project ships now does); one entry per
 * extension a caller forgot to warm, silently or not. Reading this closes
 * the batch opened by `resetUnwarmedLanguageAccess`; see that function and
 * `unwarmedAccessBatchOpen` above. Returns a fresh array, safe for a
 * caller to keep past the next reset. */
export function hadUnwarmedLanguageAccess(): readonly string[] {
  unwarmedAccessBatchOpen = false;
  return [...unwarmedExtensions];
}

/** Clears the extensions `hadUnwarmedLanguageAccess` reports. Meant to be
 * called immediately before one synchronous batch of `languageServiceFor`
 * calls, so what that batch reports after reflects only that batch, not
 * whatever ran earlier in this same process. Safe to call this way
 * because every reader of this flag is itself synchronous, start to
 * finish: nothing else can run between the reset and the read to blur one
 * batch into another. Throws if a previous batch's reset was never
 * matched by a read -- see `unwarmedAccessBatchOpen` above -- which is
 * this guard actually firing, not a bug in the guard. */
export function resetUnwarmedLanguageAccess(): void {
  if (unwarmedAccessBatchOpen) {
    throw new Error(
      "resetUnwarmedLanguageAccess called again before the previous batch's hadUnwarmedLanguageAccess read. " +
        "separateTestDiff must stay synchronous end to end for this flag to mean anything; an `await` was " +
        "added somewhere in its call graph, letting two calls interleave.",
    );
  }
  unwarmedAccessBatchOpen = true;
  unwarmedExtensions.clear();
}

/**
 * Loads whichever language services a batch of files will actually need,
 * before any of them is scanned. `languageServiceFor` below is
 * synchronous, because every caller needs to call it deep inside
 * otherwise synchronous, per-line and per-file logic; loading a WASM
 * grammar is not synchronous, so the load has to happen here, ahead of
 * time, from a caller that already knows every path it is about to
 * process. A path list touching no registered extension returns
 * immediately having imported nothing. Safe to call more than once: an
 * extension already resolved for this process is skipped.
 */
export async function warmLanguageServices(paths: readonly string[]): Promise<void> {
  const toLoad = new Set<string>();
  for (const path of paths) {
    const ext = extensionOf(path);
    if (ext in TREE_SITTER_LOADERS && !resolvedServices.has(ext)) toLoad.add(ext);
  }
  if (toLoad.size === 0) return;
  await Promise.all([...toLoad].map((ext) => resolveTreeSitterService(ext)));
}

/**
 * The scanner for one file, chosen from its path, not from any state
 * carried between calls. Every extension not in the registry gets the
 * regex scanner this file has always run, unchanged. A registered
 * extension gets its tree-sitter-backed service when `warmLanguageServices`
 * was able to load it for this process, and the regex scanner otherwise,
 * including for a caller that never called `warmLanguageServices` at all:
 * that keeps every caller written before this function existed working
 * exactly as it did.
 *
 * That last case is also what the bug `adg mutate` had looked like: a
 * caller that reads a registered file's mask without ever warming gets
 * the regex scanner's answer silently, with nothing to say a better one
 * was available and simply never asked for. This function cannot fail
 * loudly on "never warmed" itself, because src/test-diff-separator.ts
 * calls it the same way, unwarmed, from tests that intend the regex
 * fallback and would break if this started throwing (verified: doing so
 * failed 5 tests in tests/test-diff-separator.test.ts). The fix belongs
 * one level up, at whichever function actually knows all the paths a
 * batch of work is about to touch: see `planMutationsWarmed` in
 * src/mutate.ts, the single warm-then-plan entry point every production
 * caller of mutate's planner now goes through, so which mask a
 * registered file gets no longer depends on an entry point remembering a
 * second, separate call.
 */
export function languageServiceFor(path: string): LanguageService {
  const ext = extensionOf(path);
  if (!(ext in TREE_SITTER_LOADERS)) return regexLanguageService;
  const cached = resolvedServices.get(ext);
  if (cached !== undefined) return cached;
  unwarmedExtensions.add(ext);
  return regexLanguageService;
}
