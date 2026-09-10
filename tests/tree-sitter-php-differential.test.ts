// Differential test: the regex scanner in src/code-mask.ts against the
// tree-sitter-backed PHP service (src/tree-sitter-language-service.ts,
// configured by src/tree-sitter-grammars.ts's `php` entry). See
// tests/lib/tree-sitter-differential-harness.ts for what a "disagree" and
// an "agree" case each check and why.

import { regexLanguageService } from "../src/code-mask.ts";
import { loadTreeSitterLanguageService } from "../src/tree-sitter-language-service.ts";
import { GRAMMAR_SPECS } from "../src/tree-sitter-grammars.ts";
import { runDifferentialCorpus, blank, blankNth, type DifferentialCase } from "./lib/tree-sitter-differential-harness.ts";

const spec = GRAMMAR_SPECS[".php"];

function disagree(name: string, text: string, regexExpected: string, treeExpected: string): DifferentialCase {
  return { kind: "disagree", name, text, regexExpected, treeExpected };
}

function agree(name: string, text: string): DifferentialCase {
  return { kind: "agree", name, text };
}

const hashComment = "<?php\n# hash comment assert(1)\necho 1;\n";
const dollarInterp = '<?php\necho "hi $name!";\n';
const braceInterp = '<?php\necho "hi {$name}!";\n';
const heredoc = "<?php\n$h = <<<EOT\nheredoc $name assert\nEOT;\n";
const nowdoc = "<?php\n$n = <<<'EOT'\nnowdoc $name assert\nEOT;\n";

const cases: DifferentialCase[] = [
  disagree(
    "a `#` comment: regex does not know the form, tree-sitter reads it as the same `comment` type as `//`",
    // Regex reasoning: classify only knows `//` and `/* */`; a `#`
    // comment is ordinary code to it, the same gap this project already
    // documented for Python before this phase.
    // tree-sitter reasoning: tree-sitter-php gives `#`, `//`, and
    // `/* */` comments the same node type, `comment`, so this is blanked
    // exactly as a `//` comment would be.
    hashComment,
    hashComment,
    blank(hashComment, "# hash comment assert(1)"),
  ),
  disagree(
    "a bare $variable inside a double-quoted string: regex blanks it along with the rest, tree-sitter keeps it as code",
    // Regex reasoning: `"` opens an ordinary quoted string to classify;
    // `$name` inside is just more characters between the quotes.
    // tree-sitter reasoning: an `encapsed_string`'s `$name` is its own
    // `variable_name` node, a named child that is not in
    // src/tree-sitter-grammars.ts's php contentTypes, so it is reopened
    // to code and stays visible; "hi " and "!" on either side, plain
    // string_content, are blanked along with the surrounding quotes.
    dollarInterp,
    blank(dollarInterp, "hi $name!"),
    blank(blank(dollarInterp, '"hi '), '!"'),
  ),
  disagree(
    "a braced {$variable} inside a double-quoted string: same result as the bare form, opposite spelling",
    braceInterp,
    blank(braceInterp, "hi {$name}!"),
    blank(blank(braceInterp, '"hi {'), '}!"'),
  ),
  disagree(
    "a heredoc: regex sees nothing at all, tree-sitter masks its text but keeps the interpolated $name and the tag",
    // Regex reasoning: `<<<EOT` opens nothing the regex scanner
    // recognises, so the whole heredoc -- tag, body, "assert" included --
    // reads as ordinary code, untouched.
    // tree-sitter reasoning: the heredoc's own <<<EOT/EOT tags
    // (heredoc_start/heredoc_end) and its plain text (string_content)
    // are blanked; $name is a variable_name, reopened to code the same
    // way it is inside an ordinary double-quoted string, since PHP
    // heredocs interpolate exactly like a double-quoted string does.
    heredoc,
    heredoc,
    blank(blank(heredoc, "<<<EOT\nheredoc "), " assert\nEOT"),
  ),
  disagree(
    "a nowdoc: regex misreads the quoted tag as a string of its own, tree-sitter masks the whole thing including $name",
    // Regex reasoning: `<<<'EOT'` has a `'`-quoted `EOT` in it, which
    // classify reads as an ordinary single-quoted string in its own
    // right, blanking "EOT" between the ticks; the actual nowdoc body
    // afterward, "nowdoc $name assert", is never recognised as anything
    // but ordinary code and stays fully visible -- the same kind of false
    // reading a heredoc-in-an-XML-template produces for the per-line
    // caller described in src/code-mask.ts's own known-limits comment.
    // tree-sitter reasoning: a nowdoc never interpolates, by PHP's own
    // rule, so its whole body is one nowdoc_string leaf with no
    // variable_name child to reopen -- $name included, everything from
    // the tag through the body is blanked wholesale.
    nowdoc,
    blankNth(nowdoc, "EOT", 0),
    blank(nowdoc, "<<<'EOT'\nnowdoc $name assert\nEOT"),
  ),
  agree("an ordinary single-quoted string: both scanners agree on which characters are code", "<?php\n$x = 'plain';\n"),
  agree(
    "an ordinary double-quoted string with no interpolation: both scanners agree",
    '<?php\necho "plain assert";\n',
  ),
];

runDifferentialCorpus(
  "php",
  () => loadTreeSitterLanguageService(spec.packageName, spec.wasmFileName, spec.config),
  regexLanguageService,
  cases,
);
