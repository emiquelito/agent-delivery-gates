// Differential test: the regex scanner in src/code-mask.ts against the
// tree-sitter-backed C# service (src/tree-sitter-language-service.ts,
// configured by src/tree-sitter-grammars.ts's `csharp` entry). See
// tests/lib/tree-sitter-differential-harness.ts for what a "disagree" and
// an "agree" case each check and why.

import { regexLanguageService } from "../src/code-mask.ts";
import { loadTreeSitterLanguageService } from "../src/tree-sitter-language-service.ts";
import { GRAMMAR_SPECS } from "../src/tree-sitter-grammars.ts";
import { runDifferentialCorpus, blank, type DifferentialCase } from "./lib/tree-sitter-differential-harness.ts";

const spec = GRAMMAR_SPECS[".cs"];

function disagree(name: string, text: string, regexExpected: string, treeExpected: string): DifferentialCase {
  return { kind: "disagree", name, text, regexExpected, treeExpected };
}

function agree(name: string, text: string): DifferentialCase {
  return { kind: "agree", name, text };
}

const verbatim = 'string a = @"verbatim ""assert(1)"" end";\n';
const interpolated = 'string b = $"interp {x} assert";\n';
const rawTriple = 'string c = """raw {escaped} assert""";\n';
const utf8Suffix = 'var x = "hello"u8; assert(1);\n';

const cases: DifferentialCase[] = [
  disagree(
    "a verbatim string with a doubled-quote escape: regex reads each `\"\"` pair as closed-then-reopened, tree-sitter blanks the whole literal",
    // Regex reasoning: classify has no notion of `@"..."`'s own escaping
    // rule (a literal `"` written as `""`); it just tracks single `"`
    // characters. `@"verbatim "` closes at the first doubled quote's
    // first `"` (reading "verbatim " as the string), the second `"` of
    // that pair reopens a new string that runs to the first `"` of the
    // next doubled pair (blanking "assert(1)"), and so on: three
    // separate ordinary strings are read where there is actually one.
    // Content-wise the outcome happens to look similar (everything
    // between the outer `@"` and the final `"` is blanked either way),
    // but only because this fixture has no unescaped code sitting
    // between two of the doubled quotes the way Rust's raw-string
    // fixture does -- the quotes themselves stay visible under this
    // reading, where tree-sitter blanks them too.
    // tree-sitter reasoning: this whole span is one verbatim_string_literal
    // node with no children at all (see src/tree-sitter-grammars.ts's own
    // note on it), so it is blanked wholesale, doubled quotes and all.
    verbatim,
    blank(blank(blank(verbatim, "verbatim "), "assert(1)"), " end"),
    blank(verbatim, '@"verbatim ""assert(1)"" end"'),
  ),
  disagree(
    "an interpolated string: regex blanks the whole literal including {x}, tree-sitter keeps only the interpolated expression",
    // Regex reasoning: `$"..."` is still just a `"`-quoted string to
    // classify; the `$` prefix means nothing to it, and `{x}` inside is
    // blanked along with "interp " and " assert".
    // tree-sitter reasoning: `{x}` is its own `interpolation` node,
    // reopened to code by the walk in
    // src/tree-sitter-language-service.ts; "interp " and " assert" on
    // either side are plain string_content (a different node type than
    // an ordinary, non-interpolated string's string_literal_content --
    // see src/tree-sitter-grammars.ts's own note on why both had to be
    // listed), blanked along with the `$` prefix and surrounding quotes.
    interpolated,
    blank(interpolated, "interp {x} assert"),
    blank(blank(interpolated, '$"interp '), ' assert"'),
  ),
  disagree(
    "a raw string literal (C# 11): regex reads the triple quote as an empty string, the real content, then another empty string, tree-sitter blanks the whole thing",
    // Regex reasoning: three plain `"` characters, read one pair at a
    // time. The first two form an empty string (both visible as
    // delimiters, nothing between them to blank); the third opens a new
    // string that this time does find a real closing `"` later on the
    // same line -- the first of the closing `"""` -- so it correctly
    // captures "raw {escaped} assert" as its content and blanks it,
    // leaving that closing quote visible too. What is left of the
    // closing `"""`, its last two quotes, then forms one final empty
    // string the same way the opening pair did. The net effect on a
    // single-line fixture like this one happens to land on the right
    // content, all six quotes visible, nothing more blanked than the
    // actual raw string's text -- unlike Java's multi-line `"""` text
    // block fixture, where the same three-quotes-as-three-strings
    // reading runs into a newline mid-string and comes apart (see
    // tests/tree-sitter-java-differential.test.ts).
    // tree-sitter reasoning: this whole span is one raw_string_literal
    // node (raw_string_start/raw_string_content/raw_string_end, all
    // listed in src/tree-sitter-grammars.ts's csharp contentTypes),
    // blanked wholesale, quotes included -- no interpolation type
    // applies here, since this form has no `$` prefix.
    rawTriple,
    blank(rawTriple, "raw {escaped} assert"),
    blank(rawTriple, '"""raw {escaped} assert"""'),
  ),
  disagree(
    "a UTF-8 byte string literal's `u8` suffix: regex leaves it as code after the string, tree-sitter blanks it with the string",
    // Regex reasoning: `"hello"` is an ordinary `"`-quoted string to
    // classify, blanked between its (visible) quotes; the `u8` right
    // after it is just more code, no different than any other
    // identifier-like text following a string literal.
    // tree-sitter reasoning: `string_literal_encoding` is `u8`'s own
    // named node type, a sibling of string_literal_content inside the
    // same string_literal -- not an interpolation, so listing it in
    // contentTypes (see src/tree-sitter-grammars.ts's csharp entry) keeps
    // it blanked along with the rest of the literal instead of reopened
    // as code.
    utf8Suffix,
    blank(utf8Suffix, "hello"),
    blank(utf8Suffix, '"hello"u8'),
  ),
  agree(
    "an ordinary double-quoted string with an escape sequence: both scanners agree on which characters are code",
    'string d = "esc\\"aped"; assertTrue(d != null);\n',
  ),
  agree("a `//` line comment: both scanners agree", "// plain\nclass X {}\n"),
  agree("a `/* */` block comment: both scanners agree", "/* plain */\nclass X {}\n"),
];

runDifferentialCorpus(
  "csharp",
  () => loadTreeSitterLanguageService(spec.packageName, spec.wasmFileName, spec.config),
  regexLanguageService,
  cases,
);
