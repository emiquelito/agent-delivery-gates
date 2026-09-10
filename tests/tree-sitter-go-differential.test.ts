// Differential test: the regex scanner in src/code-mask.ts against the
// tree-sitter-backed Go service (src/tree-sitter-language-service.ts,
// configured by src/tree-sitter-grammars.ts's `go` entry). See
// tests/lib/tree-sitter-differential-harness.ts for what a "disagree" and
// an "agree" case each check and why.
//
// Go has neither doc-comment nesting (Rust's surprise) nor string
// interpolation (Ruby/PHP/C#'s), so most of its differential comes down
// to the two constructs the regex scanner was never written to know
// about at all: a backtick raw string, and a rune literal.

import { regexLanguageService } from "../src/code-mask.ts";
import { loadTreeSitterLanguageService } from "../src/tree-sitter-language-service.ts";
import { GRAMMAR_SPECS } from "../src/tree-sitter-grammars.ts";
import { runDifferentialCorpus, blank, type DifferentialCase } from "./lib/tree-sitter-differential-harness.ts";

const spec = GRAMMAR_SPECS[".go"];

function disagree(name: string, text: string, regexExpected: string, treeExpected: string): DifferentialCase {
  return { kind: "disagree", name, text, regexExpected, treeExpected };
}

function agree(name: string, text: string): DifferentialCase {
  return { kind: "agree", name, text };
}

const raw = "s := `raw\nassert(1)\nstring`\n";
const rune = "r := 'z'\nassertOk(r)\n";

const cases: DifferentialCase[] = [
  disagree(
    "a backtick raw string: regex reads it as a JS template literal and keeps the backticks visible, tree-sitter blanks them too",
    // Regex reasoning: classify's backtick case exists for JS/C-family
    // template literals, and it is not gated by file extension -- a
    // caller falling back to the regex scanner for a `.go` file (this
    // grammar not installed, say) gets the same classify() every other
    // extension does. skipTemplate happens to read a Go raw string
    // almost the way tree-sitter does, content-wise: it opens at the
    // first backtick and closes at the matching one, blanking
    // everything between, "assert(1)" included, and even the two real
    // newlines the raw string spans -- markNonCode does not distinguish
    // a blanked newline from a blanked letter, so this collapses what
    // was three source lines into one line of spaces. What regex gets
    // wrong is subtler than "no case for it at all": had this raw
    // string's content contained a literal `${`, skipTemplate would
    // misread it as a JS interpolation opening, which Go's grammar has
    // no such concept of at all.
    // tree-sitter reasoning: the whole span, backtick to backtick, is one
    // raw_string_literal node, blanked wholesale -- the same content
    // regex also blanks, but with the backticks blanked along with it
    // instead of left visible as delimiters.
    raw,
    blank(raw, "raw\nassert(1)\nstring"),
    blank(raw, "`raw\nassert(1)\nstring`"),
  ),
  disagree(
    "a rune literal: regex reads it as an ordinary single-quoted string, keeping its quotes visible; tree-sitter blanks the whole literal",
    // Regex reasoning: `'z'` is read the same way any other single-quoted
    // string is: classify opens at the first `'`, closes at the next
    // one, and blanks "z" between them while leaving both ticks visible
    // as delimiters.
    // tree-sitter reasoning: `'z'` is a rune_literal node in its own
    // right, with no separate quote-punctuation children at all (unlike
    // Rust's char_literal or C#'s character_literal, both of which do
    // expose their ticks as children -- see this file's own exploration
    // notes in the report), so the whole three-character span is blanked
    // together.
    rune,
    blank(rune, "z"),
    blank(rune, "'z'"),
  ),
  agree(
    "an ordinary interpreted string with an escape sequence: both scanners agree on which characters are code",
    's := "hi\\tthere"; assertOk(s)\n',
  ),
  agree("a `//` line comment: both scanners agree", "// plain\nfunc f() {}\n"),
  agree("a `/* */` block comment: both scanners agree", "/* plain */\nfunc f() {}\n"),
];

runDifferentialCorpus(
  "go",
  () => loadTreeSitterLanguageService(spec.packageName, spec.wasmFileName, spec.config),
  regexLanguageService,
  cases,
);
