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
  disagree(
    "HTML before the first `<?php` tag: regex misreads the closing `</` of the leading tag as an unterminated regex and blanks real PHP code along with it; tree-sitter leaves the HTML visible and blanks only the trailing `?>` tag",
    // A prior round put PHP's `text` in literalTypes so this bare, unwrapped
    // child of `program` (HTML before the first `<?php` tag has no
    // text_interpolation wrapper the way HTML between two PHP spans does)
    // would be masked. The round after found that masking a `text` node
    // wholesale hid a real assertion whenever an inline <script>/<style>
    // element -- which tree-sitter-php gives no child structure of its own
    // -- happened to sit inside one, most sharply when a `<?php ... ?>`
    // span split a single script element into two separate `text` nodes.
    // `text` was pulled back out of both literalTypes and contentTypes
    // entirely (see src/tree-sitter-grammars.ts's php entry), so leading
    // HTML now stays visible again, the same as it always did before that
    // round started.
    // Regex reasoning, unchanged: this project's own scanner reads a `/` as
    // opening a regular expression literal when what precedes it looks like
    // it cannot be a division (see src/code-mask.ts's own look-back
    // heuristic); the `/` in `</html>`'s closing tag qualifies, and no
    // further unescaped `/` appears anywhere in the rest of the text for it
    // to close on, so everything from that `/` to the end of the input is
    // misread as one unterminated regex literal and blanked -- the safe
    // direction this project's own known-limits comment describes, even
    // though it happens to blank real PHP code (`echo 1; ?>`) along with
    // the HTML this case is actually about.
    // tree-sitter reasoning: `text` is unlisted, so both the leading HTML
    // and `echo 1;` stay code, the ordinary walk default. Only the trailing
    // `?>` blanks, as php_end_tag, a content type of the text_interpolation
    // node that still wraps it -- unrelated to Finding 3 or its revert, the
    // same handling every other case in this corpus already exercises.
    "<html>LEADING_SECRET_TEXT</html><?php echo 1; ?>\n",
    blank("<html>LEADING_SECRET_TEXT</html><?php echo 1; ?>\n", "html><?php echo 1; ?>"),
    blank("<html>LEADING_SECRET_TEXT</html><?php echo 1; ?>\n", " ?>"),
  ),
  agree(
    "a template-only file with no `<?php` tag at all: both scanners leave it entirely visible",
    // A prior round masked this whole file as one bare `text` node under
    // literalTypes, and the round after reverted that (see the case above,
    // and src/tree-sitter-grammars.ts's php entry, for why): a template-only
    // file with no PHP tag at all now stays fully visible under
    // tree-sitter's own reading, agreeing with the regex scanner, which
    // never had anything here to recognise as a quote, a backtick, a `/`
    // following a token that could open a regex, or a C-family comment.
    "just plain html no php tag at all SECRET\n",
  ),
  disagree(
    "a backtick shell_command_expression with an interpolated $variable: regex reads it as a JS-style template literal, tree-sitter keeps the variable as code",
    // shell_command_expression coverage: PHP's own backtick shell-command
    // string, structurally identical to encapsed_string (string_content,
    // escape_sequence, and PHP's five interpolation forms).
    // Regex reasoning: this project's own scanner already treats a
    // backtick as a JS-style template literal's own delimiter; it finds
    // no `${...}` inside (PHP spells this `$var`, not `${var}` the way
    // this scanner's own JS-family template interpolation is spelled), so
    // the whole body between the backticks is blanked, the backticks
    // themselves left visible as delimiters.
    // tree-sitter reasoning: `ls ` (string_content) is blanked along with
    // both backticks (anonymous punctuation, part of the wholesale
    // fill), and `$DANGEROUS`, a variable_name child, is reopened as
    // code, the same way a bare `$var` inside an ordinary double-quoted
    // string already is.
    "<?php\n$out = `ls $DANGEROUS`;\n",
    blank("<?php\n$out = `ls $DANGEROUS`;\n", "ls $DANGEROUS"),
    blank(blank("<?php\n$out = `ls $DANGEROUS`;\n", "`ls "), "`"),
  ),
];

runDifferentialCorpus(
  "php",
  () => loadTreeSitterLanguageService(spec.packageName, spec.wasmFileName, spec.config),
  regexLanguageService,
  cases,
);
