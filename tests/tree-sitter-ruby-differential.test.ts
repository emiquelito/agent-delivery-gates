// Differential test: the regex scanner in src/code-mask.ts against the
// tree-sitter-backed Ruby service (src/tree-sitter-language-service.ts,
// configured by src/tree-sitter-grammars.ts's `ruby` entry). See
// tests/lib/tree-sitter-differential-harness.ts for what a "disagree" and
// an "agree" case each check and why.

import { regexLanguageService } from "../src/code-mask.ts";
import { loadTreeSitterLanguageService } from "../src/tree-sitter-language-service.ts";
import { GRAMMAR_SPECS } from "../src/tree-sitter-grammars.ts";
import { runDifferentialCorpus, blank, type DifferentialCase } from "./lib/tree-sitter-differential-harness.ts";

const spec = GRAMMAR_SPECS[".rb"];

function disagree(name: string, text: string, regexExpected: string, treeExpected: string): DifferentialCase {
  return { kind: "disagree", name, text, regexExpected, treeExpected };
}

function agree(name: string, text: string): DifferentialCase {
  return { kind: "agree", name, text };
}

const heredoc = "x = <<~HEREDOC\n  hello\nHEREDOC\nassert_equal(1, 2)\n";
const blockComment = "=begin\nblock comment\n=end\nassert_equal(1, 2)\n";
const percentW = "w = %w[a b assert]\n";
const percentQ = "q = %q(assert this)\n";
const interpolated = 'greeting = "hi #{name}!"\n';
const interpolatedWithComment = 'greeting = "hi #{name}!"  # trailing\n';

const cases: DifferentialCase[] = [
  disagree(
    "a <<~ heredoc: regex has no notion of one at all, tree-sitter masks its body and keeps its tag",
    // Regex reasoning: `<<~HEREDOC` opens no string or comment the regex
    // scanner knows (backticks, quotes, and C-family comments are all it
    // has), so every line of the heredoc's own body is read as ordinary
    // code, untouched, all the way through.
    // tree-sitter reasoning: `<<~HEREDOC` on the opening line stays a
    // separate heredoc_beginning node, still code; the body that follows
    // -- from the newline right after it through the closing HEREDOC tag
    // -- is its own heredoc_body node, blanked wholesale (see
    // src/tree-sitter-grammars.ts's ruby contentTypes for why the closing
    // tag, heredoc_end, is included in that blank instead of reopened as
    // code). This is the sharper of the two readings: a detector word
    // written inside heredoc text is real signal to neither scanner
    // (regex reads it as ordinary code, so it is never even isolated as
    // literal text at all), but the heredoc's *body* itself is where
    // this project's known-limits comment in src/code-mask.ts already
    // says a per-line caller can be fooled by an unclosed literal, and
    // tree-sitter is what actually closes that gap for a Ruby heredoc.
    heredoc,
    heredoc,
    blank(heredoc, "\n  hello\nHEREDOC"),
  ),
  disagree(
    "an =begin/=end block comment: regex does not know the form exists, tree-sitter masks the whole block",
    // Regex reasoning: `=begin` and `=end` are not `/*`, `*/`, or `//` to
    // classify, so this whole block reads as ordinary code, line by
    // line, exactly like any other statement would.
    // tree-sitter reasoning: this whole span, `=begin` through `=end`, is
    // one `comment` node -- the same node type Ruby gives a `#` line
    // comment -- blanked wholesale.
    blockComment,
    blockComment,
    blank(blockComment, "=begin\nblock comment\n=end"),
  ),
  disagree(
    "a %w[] word-array literal: regex reads its words as code, tree-sitter blanks the whole literal",
    percentW,
    percentW,
    blank(percentW, "%w[a b assert]"),
  ),
  disagree(
    "a %q() literal: regex reads its content as code, tree-sitter blanks the whole literal",
    percentQ,
    percentQ,
    blank(percentQ, "%q(assert this)"),
  ),
  disagree(
    "string interpolation: regex blanks the whole literal including #{name}, tree-sitter keeps only the interpolated expression",
    // Regex reasoning: `"` opens an ordinary quoted string to classify,
    // closing at the matching `"`; `#{name}` inside is just more
    // characters between the quotes, blanked along with "hi " and "!".
    // tree-sitter reasoning: `#{name}` is its own `interpolation` node, a
    // named child of the `string` node holding a real `identifier`;
    // reopened to code by the walk in src/tree-sitter-language-service.ts,
    // it stays visible while "hi " and "!" on either side, plain
    // string_content, are blanked along with the surrounding quotes.
    interpolated,
    blank(interpolated, "hi #{name}!"),
    blank(blank(interpolated, '"hi '), '!"'),
  ),
  disagree(
    "the same interpolation with a trailing `#` comment: regex leaves the comment as code too, tree-sitter masks it as well",
    // Same reasoning as the interpolation case above for the string
    // itself; the `# trailing` comment afterward is invisible to the
    // regex scanner (it does not know `#` comments, the same gap noted
    // for Python before this phase) and stays visible code to it, while
    // tree-sitter reads it as its own comment node and blanks it too.
    interpolatedWithComment,
    blank(interpolatedWithComment, "hi #{name}!"),
    blank(blank(blank(interpolatedWithComment, '"hi '), '!"'), "# trailing"),
  ),
  agree(
    "an ordinary string with no interpolation and no heredoc: both scanners agree on which characters are code",
    'name = "plain"; assert_equal(name, "plain")\n',
  ),
  agree(
    "nested escaped quotes inside an ordinary string: both scanners agree",
    'greeting = "she said \\"hi\\" to me"\n',
  ),
];

runDifferentialCorpus(
  "ruby",
  () => loadTreeSitterLanguageService(spec.packageName, spec.wasmFileName, spec.config),
  regexLanguageService,
  cases,
);
