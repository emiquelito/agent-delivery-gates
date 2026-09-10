// Differential test: the regex scanner in src/code-mask.ts against the
// tree-sitter-backed Java service (src/tree-sitter-language-service.ts,
// configured by src/tree-sitter-grammars.ts's `java` entry). See
// tests/lib/tree-sitter-differential-harness.ts for what a "disagree" and
// an "agree" case each check and why.
//
// Java has no string interpolation, so the one construct the regex
// scanner cannot see at all is a `"""` text block.

import { regexLanguageService } from "../src/code-mask.ts";
import { loadTreeSitterLanguageService } from "../src/tree-sitter-language-service.ts";
import { GRAMMAR_SPECS } from "../src/tree-sitter-grammars.ts";
import { runDifferentialCorpus, blank, type DifferentialCase } from "./lib/tree-sitter-differential-harness.ts";

const spec = GRAMMAR_SPECS[".java"];

function disagree(name: string, text: string, regexExpected: string, treeExpected: string): DifferentialCase {
  return { kind: "disagree", name, text, regexExpected, treeExpected };
}

function agree(name: string, text: string): DifferentialCase {
  return { kind: "agree", name, text };
}

const textBlock = 'String s = """\n    assertTrue(x)\n    """;\n';

const cases: DifferentialCase[] = [
  disagree(
    "a text block: regex reads each `\"\"\"` as an empty string plus an unterminated one, tree-sitter masks the whole block",
    // Regex reasoning: classify only ever knows single `"` characters.
    // Reading the opening `"""` as three of them: the first opens and
    // the second immediately closes an empty string (both kept visible
    // as delimiters), then the third `"` opens a second string that is
    // never closed before the line ends -- skipQuoted stops at the
    // newline with nothing between the third quote and it, so nothing
    // on this line is blanked beyond the two delimiter quotes already
    // visible. The newline is then read as ordinary code, and scanning
    // resumes fresh on the next line, `    assertTrue(x)`, which carries
    // no quote of its own and stays fully visible -- this project's own
    // known-limits comment in src/code-mask.ts, about a string that
    // opened on an earlier line, applies here exactly, even though
    // nothing was actually blanked by it in this particular fixture.
    // The closing `"""` is read the same way: the first two quotes
    // again form an empty, fully-visible string, and the third opens an
    // unterminated one that swallows whatever comes before the next
    // newline -- here, the trailing `;`, which is inside that
    // unterminated string's consumed range and so is never visited by
    // the main scan at all, leaving it at the array's LITERAL default
    // and blanked to a space. The result: everything in this fixture
    // stays exactly as written except that one semicolon.
    // tree-sitter reasoning: this is one string_literal node from the
    // opening `"""` to the closing `"""`, so the whole thing --
    // `assertTrue(x)` and the two newlines inside it included -- is
    // blanked in one pass, and the trailing `;` (outside the node) is
    // untouched.
    textBlock,
    blank(textBlock, ";"),
    blank(textBlock, '"""\n    assertTrue(x)\n    """'),
  ),
  agree(
    "an ordinary double-quoted string: both scanners agree on which characters are code",
    'String t = "plain"; assertTrue(t.equals("plain"));\n',
  ),
  agree("a `//` line comment: both scanners agree", "// plain\nclass X {}\n"),
  agree("a `/* */` block comment: both scanners agree", "/* plain */\nclass X {}\n"),
];

runDifferentialCorpus(
  "java",
  () => loadTreeSitterLanguageService(spec.packageName, spec.wasmFileName, spec.config),
  regexLanguageService,
  cases,
);
