// Differential test: the regex-and-heuristic scanner in src/code-mask.ts
// against the tree-sitter-backed Python service in
// src/tree-sitter-python-service.ts, run over the same corpus of Python
// source. The regex scanner was written for the C-family and
// JavaScript-family languages only; it has never known a `#` comment, a
// triple-quoted string, or an f-string, and Python's own doc comment in
// src/mutate.ts says as much ("Python is out on purpose"). Every case below
// where the two masks disagree is expected, not a failure: it is the
// evidence that the tree-sitter service earns its place, and the reasoning
// for each disagreement is recorded in that test's own comment.
//
// Every expected string in this file is typed out by hand, from reading
// Python's grammar directly (a triple-quoted string is everything between
// its matching `"""` pair; an f-string interpolation is a real expression;
// a `#` starts a comment that runs to the end of its line), never by
// calling codeMask/maskNonCode and copying back what came out. Rule
// expected-value-derived-apart.json is exactly about this: a check that
// reaches its expected value by the same route as the thing it checks can
// only ever agree with it, right or wrong.
//
// This corpus and its comparison run unconditionally, not only when
// available: web-tree-sitter and tree-sitter-python are devDependencies,
// and a devDependency is exactly what `npm test` already assumes is
// installed. Nothing here is fragile the way it would be if this test ran
// against an optional runtime path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { codeMask as regexCodeMask, maskNonCode as regexMaskNonCode } from "../src/code-mask.ts";
import { loadPythonLanguageService } from "../src/tree-sitter-python-service.ts";
import type { LanguageService } from "../src/code-mask.ts";

let python: LanguageService;

test.before(async () => {
  python = await loadPythonLanguageService();
});

// --- disagreements: the regex scanner gets these wrong -----------------------

/**
 * Blanks a known substring of `source` to the same number of spaces,
 * failing loudly if that substring is not found exactly once. Used below
 * to build an expected masked string from independent reasoning about
 * which substrings a scanner blanks, not by calling the scanner itself:
 * counting spaces out by hand is exactly the kind of transcription mistake
 * this sidesteps, since the space count always comes from the substring's
 * own length.
 */
function blank(source: string, substring: string): string {
  const at = source.indexOf(substring);
  assert.notEqual(at, -1, `expected to find ${JSON.stringify(substring)} in the fixture`);
  assert.equal(source.indexOf(substring, at + 1), -1, `${JSON.stringify(substring)} must appear exactly once`);
  return source.slice(0, at) + " ".repeat(substring.length) + source.slice(at + substring.length);
}

test("triple-quoted docstring: regex cannot see it at all, tree-sitter masks the whole thing", () => {
  const text = 'x = """line one\nline two "quoted" # not a comment\nline three"""\n';

  // Regex reasoning: the regex scanner only knows single `"` and `'`
  // strings (skipQuoted stops at the first matching quote or at the end of
  // its line). Reading `"""` as three quote characters: the first opens
  // and the second immediately closes it (an empty string, both quotes
  // kept visible as delimiters), then the third `"` opens a *second*
  // string that is never closed on that line, so skipQuoted stops at the
  // newline and blanks "line one" in between. That newline is then read
  // as ordinary code (classify falls through to `kinds[i] = CODE` for any
  // character that opened no literal), so it survives untouched, and
  // scanning resumes fresh on line two, which has its own ordinary quoted
  // string around "quoted" and a `#` comment classify does not know, left
  // as code. Line three's `line three"""` is ordinary code up to its own
  // `"""`: the same empty-string-then-unterminated-string reading applies,
  // so the trailing `"""` there is three visible delimiter quotes with
  // nothing left to blank before the text ends.
  const regexExpected = blank(blank(text, "line one"), "quoted");
  assert.equal(regexMaskNonCode(text), regexExpected, "regex scanner's own (wrong) reading of the triple quote");

  // tree-sitter reasoning: this is one `string` node from the opening
  // `"""` to the closing `"""`, so codeMask/maskNonCode treat everything
  // between them, embedded quotes, the `#` and the two newlines included,
  // as not code. The opening and closing `"""` stay visible (they are the
  // string's own delimiter punctuation), and the newline after the closing
  // `"""` is outside the string and stays a real newline.
  const docstringBody = 'line one\nline two "quoted" # not a comment\nline three';
  const treeExpected = blank(text, docstringBody);
  assert.equal(python.maskNonCode(text), treeExpected);

  assert.notEqual(regexMaskNonCode(text), python.maskNonCode(text));
});

test("f-string interpolation: regex blanks the live identifier, tree-sitter keeps it", () => {
  const text = 'greeting = f"hello {name}!"\n';

  // Regex reasoning: an f-string is still just a `"`-quoted string to this
  // scanner. It opens at the first `"` and closes at the matching one,
  // blanking everything between, `{name}` included, even though `name` is
  // a real identifier a mutation or a signal might need to see.
  const regexExpected = blank(text, "hello {name}!");
  assert.equal(regexMaskNonCode(text), regexExpected);

  // tree-sitter reasoning: tree-sitter-python exposes the `{name}` part as
  // an `interpolation` node holding a real `identifier` node, a child of
  // the `string` node, not string text. Recursing one level into it (see
  // markNode in src/tree-sitter-python-service.ts) keeps `{name}` as code
  // while `hello ` and `!` on either side, plain `string_content`, stay
  // masked, and the surrounding quotes stay visible as delimiters.
  const treeExpected = blank(blank(text, "hello "), "!");
  assert.equal(python.maskNonCode(text), treeExpected);

  assert.notEqual(regexMaskNonCode(text), python.maskNonCode(text));
});

test("f-string with a nested format expression: regex blanks the whole literal, tree-sitter keeps every nested expression", () => {
  const text = 'summary = f"{score!r:>{width}}"\n';

  const regexExpected = blank(text, "{score!r:>{width}}");
  assert.equal(regexMaskNonCode(text), regexExpected);

  // `{score!r:>{width}}` is one interpolation whose format specifier
  // itself nests another expression, `{width}`. Recursing into the
  // interpolation walks its whole subtree, so both `score` and the nested
  // `width` stay code; only the quotes are delimiter punctuation, so
  // nothing at all gets blanked here.
  const treeExpected = text;
  assert.equal(python.maskNonCode(text), treeExpected);

  assert.notEqual(regexMaskNonCode(text), python.maskNonCode(text));
});

test("a trailing `#` comment: regex leaves it as code, tree-sitter masks it", () => {
  const text = "total = a + b  # add the two together\n";

  // The regex scanner only knows `//` and `/* */`; a Python `#` comment is
  // ordinary code to it, so the whole line, comment included, stays
  // untouched.
  assert.equal(regexMaskNonCode(text), text);

  const treeExpected = blank(text, "# add the two together");
  assert.equal(python.maskNonCode(text), treeExpected);

  assert.notEqual(regexMaskNonCode(text), python.maskNonCode(text));
});

test("codeMask itself: an f-string's interpolated identifier is code to tree-sitter and not to regex", () => {
  const text = 'greeting = f"hello {name}!"\n';
  const nameIndex = text.indexOf("name");

  assert.equal(regexCodeMask(text)[nameIndex], false, "regex counts the identifier inside the string as not code");
  assert.equal(python.codeMask(text)[nameIndex], true, "tree-sitter counts it as real code");
});

// --- agreements: both scanners land on the same answer -----------------------
//
// Not every Python construct trips the regex scanner up. These are recorded
// too, because a differential test that only ever shows disagreement would
// hide how narrow the regex scanner's blind spot actually is: it is wrong
// about Python's own syntax (triple quotes, f-strings, `#` comments), not
// about ordinary quoting rules that both scanners share.

test("nested escaped quotes inside an ordinary string: both scanners agree", () => {
  const text = 'greeting = "she said \\"hi\\" to me"\n';
  assert.equal(regexMaskNonCode(text), python.maskNonCode(text));
});

test("a raw string: both scanners agree", () => {
  const text = 'pattern = r"C:\\new\\path"\n';
  assert.equal(regexMaskNonCode(text), python.maskNonCode(text));
});

test("a byte string: both scanners agree", () => {
  const text = 'header = b"\\x00\\x01"\n';
  assert.equal(regexMaskNonCode(text), python.maskNonCode(text));
});

test("a decorator with an ordinary string argument: both scanners agree", () => {
  const text = '@app.route("/health")\n';
  assert.equal(regexMaskNonCode(text), python.maskNonCode(text));
});
