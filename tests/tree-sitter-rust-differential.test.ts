// Differential test: the regex scanner in src/code-mask.ts against the
// tree-sitter-backed Rust service (src/tree-sitter-language-service.ts,
// configured by src/tree-sitter-grammars.ts's `rust` entry), over a corpus
// built with the shared harness in tests/lib/tree-sitter-differential-harness.ts.
// See that file for what a "disagree" and an "agree" case each check and why.
//
// Note what this file is not: src/test-diff-separator.ts's own Rust
// machinery (hasRustTestMarker, cfgTestRegionMask,
// stripRustNoiseForBraceCounting) is untouched by this phase and untested
// here. That machinery decides which lines of a diff belong to a
// #[cfg(test)] region; this file is about a different question, where
// the code is on a line the mask already knows to look at.

import { codeMask as regexCodeMask, regexLanguageService } from "../src/code-mask.ts";
import { loadTreeSitterLanguageService } from "../src/tree-sitter-language-service.ts";
import { GRAMMAR_SPECS } from "../src/tree-sitter-grammars.ts";
import { runDifferentialCorpus, blank, type DifferentialCase } from "./lib/tree-sitter-differential-harness.ts";
import { test } from "node:test";
import assert from "node:assert/strict";

const spec = GRAMMAR_SPECS[".rs"];

function disagree(name: string, text: string, regexExpected: string, treeExpected: string): DifferentialCase {
  return { kind: "disagree", name, text, regexExpected, treeExpected };
}

function agree(name: string, text: string): DifferentialCase {
  return { kind: "agree", name, text };
}

const cases: DifferentialCase[] = [
  disagree(
    "a raw string holding an embedded quote: regex re-opens a new string at it, tree-sitter blanks the whole raw string",
    // Regex reasoning: skipQuoted only ever looks for the next matching
    // `"`. It opens at the first `"` (right after `r#`) and closes at the
    // very next one, six characters later, treating "hello " as the
    // string. Scanning resumes as ordinary code from right after that
    // quote: "world" is read as a plain identifier (real code, so it
    // stays visible), until the next `"` opens a second, unrelated
    // "string" that runs to the following `"` and blanks " end". The raw
    // string's own r#" and "# delimiters are never recognised as a unit
    // at all.
    // tree-sitter reasoning: this whole span is one raw_string_literal
    // node (see src/tree-sitter-grammars.ts's own comment on its
    // contentTypes), so the entire thing -- prefix, embedded quotes,
    // "world" included -- is blanked wholesale in one pass.
    'let s = r#"hello "world" end"#;\n',
    blank(blank('let s = r#"hello "world" end"#;\n', "hello "), " end"),
    blank('let s = r#"hello "world" end"#;\n', 'r#"hello "world" end"#'),
  ),
  disagree(
    "a lifetime's lone tick: regex blanks the tick itself and reads the name as code, tree-sitter leaves the whole lifetime untouched",
    // Regex reasoning: isLoneTick sees the `'` in `&'a` has no partner on
    // the line, so it is read as code, not a string opener -- but the
    // branch that does that never assigns the tick character itself a
    // CODE kind, so it stays at the array's LITERAL default and gets
    // blanked, while "a" right after it is visited normally and stays
    // code. The real string, "x", is blanked the ordinary way, with its
    // quotes left visible; assert!(ok) is never touched, which is the
    // safety this lone-tick handling exists for in the first place (see
    // isLoneTick's own comment in src/code-mask.ts).
    // tree-sitter reasoning: `&'a str` parses as a reference_type holding
    // a real `lifetime` node, not a string type at all, so nothing in
    // src/tree-sitter-grammars.ts's rust literalTypes matches it and it
    // is never touched -- the tick stays visible along with the rest of
    // the lifetime. "x" is still a string_literal, blanked wholesale,
    // quotes included, unlike the regex scanner's delimiter-preserving
    // reading (see the harness's own AgreementCase comment for why that
    // difference alone is not treated as a disagreement elsewhere in
    // this file).
    "let l: &'a str = \"x\"; assert!(ok);\n",
    blank(blank("let l: &'a str = \"x\"; assert!(ok);\n", "'"), "x"),
    blank("let l: &'a str = \"x\"; assert!(ok);\n", '"x"'),
  ),
  disagree(
    "a byte string: regex keeps the b\" prefix and quotes visible, tree-sitter blanks the whole literal",
    'let b = b"bytes";\n',
    blank('let b = b"bytes";\n', "bytes"),
    blank('let b = b"bytes";\n', 'b"bytes"'),
  ),
  disagree(
    "a nested block comment: regex closes at the first */, tree-sitter tracks the nesting",
    // Regex reasoning: classify's block-comment case scans for the first
    // `*/` with no depth counter, so `/* /* nested */` is read as the
    // whole comment (the inner `/*` is just two characters inside it,
    // and the first `*/` two words later has no special meaning to a
    // scanner that never opened a second one); " still ok */" afterward
    // is read as ordinary code, trailing `*/` included, since it opens no
    // comment of its own.
    // tree-sitter reasoning: tree-sitter-rust's own comment rule nests
    // correctly, so the block_comment node spans from the outer `/*` to
    // the actual matching `*/` at the end, and the whole thing is
    // blanked in one pass.
    "/* /* nested */ still ok */\nfn f() {}\n",
    blank("/* /* nested */ still ok */\nfn f() {}\n", "/* /* nested */"),
    blank("/* /* nested */ still ok */\nfn f() {}\n", "/* /* nested */ still ok */"),
  ),
  disagree(
    "a `///` doc comment: tree-sitter's own node span swallows the trailing newline, regex's does not",
    // Regex reasoning: classify's line-comment case does not care what
    // follows the second `/`; `///` opens the same as `//` does, and the
    // whole line, marker included, is blanked up to but not onto the
    // newline -- that newline itself is left for the main loop's plain
    // fallthrough branch, which marks it CODE. The next line stays on
    // its own line, visible and untouched.
    // tree-sitter reasoning: verified directly against the grammar: a
    // `///` or `//!` line_comment node's own span runs through and
    // includes its trailing newline, unlike a plain `//` comment's
    // (below, where the newline survives). Blanking that whole span
    // erases the newline along with the comment text, so the following
    // line runs on right after it with no line break between them in
    // the masked text -- the kind of grammar-specific surprise this
    // phase's node-name verification exists to catch.
    "/// doc comment\nfn f() {}\n",
    blank("/// doc comment\nfn f() {}\n", "/// doc comment"),
    blank("/// doc comment\nfn f() {}\n", "/// doc comment\n"),
  ),
  disagree(
    "an `//!` inner doc comment: the same trailing-newline surprise as `///`",
    "//! doc\nfn f() {}\n",
    blank("//! doc\nfn f() {}\n", "//! doc"),
    blank("//! doc\nfn f() {}\n", "//! doc\n"),
  ),
  agree(
    "a plain `//` line comment with no doc marker: both scanners blank the same characters, and both leave its newline alone",
    "// plain\nfn f() {}\n",
  ),
  agree(
    "an ordinary string with no lifetime, no raw prefix, no nesting: both scanners agree on which characters are code",
    'let n = "ok"; assert_eq!(1, 1);\n',
  ),
];

runDifferentialCorpus(
  "rust",
  () => loadTreeSitterLanguageService(spec.packageName, spec.wasmFileName, spec.config),
  regexLanguageService,
  cases,
);

test("rust codeMask: a raw string's embedded 'world' is code to regex and not to tree-sitter", async () => {
  const service = await loadTreeSitterLanguageService(spec.packageName, spec.wasmFileName, spec.config);
  const text = 'let s = r#"hello "world" end"#;\n';
  const worldIndex = text.indexOf("world");
  assert.equal(regexCodeMask(text)[worldIndex], true, "regex reads 'world' as a real identifier between two strings");
  assert.equal(service.codeMask(text)[worldIndex], false, "tree-sitter reads the whole raw string as one literal");
});
