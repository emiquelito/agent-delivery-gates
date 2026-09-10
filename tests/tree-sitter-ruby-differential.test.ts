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
const percentBigW = "x = %W[a#{DANGEROUS}b c]\n";
const percentBigI = "x = %I[a#{DANGEROUS}b c]\n";
const interpolated = 'greeting = "hi #{name}!"\n';
const interpolatedWithComment = 'greeting = "hi #{name}!"  # trailing\n';
const delimitedSymbol = 'x = :"foo#{DANGEROUS}bar"\n';
const plainDelimitedSymbol = 'x = :"plain symbol"\n';
const chainedString = 'x = "a" "b#{DANGEROUS}c"\n';
const hashKeySymbol = "h = {assert_this: 1}\n";
const regexLiteral = "x = /foo#{DANGEROUS}bar/\n";
const endData = "puts 1\n__END__\nDANGEROUS raw text here\n";

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
    "a %W[] interpolating word array: regex reads it all as code, tree-sitter blanks the words and keeps the interpolation",
    // Reviewer finding: bare_string, %w[]/%W[]'s own per-word wrapper, was
    // once listed in contentTypes, which blanked it wholesale without
    // ever recursing into it -- so an interpolation written inside a %W
    // word was masked away as if it were plain text, along with the
    // surrounding word. `%W[a#{DANGEROUS}b c]` masked to blank spaces
    // from `%W[` through the closing `]`, DANGEROUS included, live code
    // treated as though it were the array's own literal text.
    // Regex reasoning: %W[] is not a form classify knows at all (no
    // quote, backtick, or C-family comment syntax matches it), so every
    // character is read as ordinary code, unchanged.
    // tree-sitter reasoning, after the fix: bare_string is now in
    // literalTypes, not contentTypes, so the walk recurses into each
    // word instead of blanking it whole. "a" and "b" (plain
    // string_content) stay blanked, the space separator and the
    // surrounding %W[ ] punctuation stay blanked (anonymous, part of the
    // wholesale string_array/bare_string span), and #{DANGEROUS} (a named
    // interpolation child, still not in contentTypes) is reopened as
    // code, exactly as it already was for an ordinary interpolated
    // string.
    percentBigW,
    percentBigW,
    blank(blank(percentBigW, "%W[a"), "b c]"),
  ),
  disagree(
    "a %I[] interpolating symbol array: regex reads it all as code, tree-sitter blanks the words and keeps the interpolation",
    // Same bug and same fix as %W[] above, for the symbol-array form: the
    // config had no symbol_array/bare_symbol entry at all before this
    // fix, so %i[]/%I[] were left as pure code, interpolation and all --
    // not the "masked as literal" failure mode %W[] had, but the same
    // class of omission this project's node-types.json conformance test
    // now exists to catch (see tests/tree-sitter-node-types-conformance.test.ts).
    percentBigI,
    percentBigI,
    blank(blank(percentBigI, "%I[a"), "b c]"),
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
  disagree(
    "an interpolated symbol, `:\"...\"`: regex reads it as an ordinary quoted string, tree-sitter keeps the interpolation",
    // Finding 3b: delimited_symbol, the `:"..."` interpolated symbol form,
    // was in none of literalTypes, contentTypes, or the node-types
    // conformance test's EXCLUSIONS -- structurally invisible to the old
    // version of that test the same way a root type like Ruby's own
    // `comment` was, since neither was ever a listed child of anything
    // already configured. Its child structure is identical to a plain
    // `string` (escape_sequence, interpolation, string_content), so
    // `:"foo#{DANGEROUS}bar"` masked to nothing at all: the interpolation
    // read straight through as though it were static text.
    // Regex reasoning: the leading `:` is just another code character to
    // classify; the `"` after it opens an ordinary quoted string, closed
    // at the matching `"`, with everything between blanked, DANGEROUS
    // included.
    // tree-sitter reasoning, after the fix: delimited_symbol is now in
    // literalTypes, so the walk blanks its own span (the `:` and both
    // quotes are anonymous, part of the wholesale fill) and then recurses
    // into its named children the same way it does for `string`: "foo"
    // and "bar" (string_content) stay blanked, and `#{DANGEROUS}` (an
    // interpolation child, not in contentTypes) is reopened as code.
    delimitedSymbol,
    blank(delimitedSymbol, "foo#{DANGEROUS}bar"),
    blank(blank(delimitedSymbol, ':"foo'), 'bar"'),
  ),
  disagree(
    "a plain interpolated-symbol literal with no interpolation: regex blanks only the quoted interior, tree-sitter blanks the symbol's own punctuation too",
    // Same delimited_symbol fix as above, without an interpolation to
    // exercise the recursion: this case instead shows the difference in
    // how much of the literal each scanner treats as not-code.
    // Regex reasoning: as above, the `:` stays code and only the
    // quoted interior is blanked.
    // tree-sitter reasoning: delimited_symbol's whole span -- the `:`,
    // both quotes, and the text between -- is blanked wholesale, the
    // same as a plain `string` literal's own quotes are.
    plainDelimitedSymbol,
    blank(plainDelimitedSymbol, "plain symbol"),
    blank(plainDelimitedSymbol, ':"plain symbol"'),
  ),
  disagree(
    "an implicit string concatenation, `\"a\" \"b#{x}c\"`: regex blanks each quoted piece separately, tree-sitter recurses through the wrapper into the second string's own interpolation",
    // chained_string (Finding 3c) is a passthrough container whose only
    // child is a `string`; it was unreachable the same way delimited_symbol
    // was, and adding it to literalTypes lets the walk recurse into its
    // `string` child exactly as it already does for any other nested
    // literal (an interpolation's own nested string, for instance).
    // Regex reasoning: `"a"` and `"b#{DANGEROUS}c"` are each read as an
    // independent quoted string; both are blanked in full, DANGEROUS
    // included.
    // tree-sitter reasoning: chained_string's span is blanked wholesale,
    // then its `string` child is reopened and walked again, which blanks
    // "b" and "c" (string_content) but keeps #{DANGEROUS} (interpolation)
    // as code -- the same outcome a bare `"b#{DANGEROUS}c"` string gets on
    // its own.
    chainedString,
    blank(blank(chainedString, "a"), "b#{DANGEROUS}c"),
    blank(blank(chainedString, '"a" "b'), 'c"'),
  ),
  agree(
    "a hash key written as a symbol, `assert_this:`: both scanners leave it as code",
    // Finding 3c, the other half: hash_key_symbol is a leaf node with no
    // named children, structurally the same structure as an ordinary
    // identifier. Its span is deliberately left out of literalTypes --
    // masking a hash key would blank ordinary Ruby syntax as though it
    // were free text, and would make a key like `assert_this:` sitting in
    // a diff look like something worth flagging when it is just a key
    // name. Both scanners agree by leaving it untouched: the regex
    // scanner because nothing about `assert_this:` looks like a string or
    // comment to it, and tree-sitter because hash_key_symbol is not in
    // literalTypes and produces no named children to recurse into either.
    hashKeySymbol,
  ),
  disagree(
    "a regex literal, `/foo#{x}bar/`: regex reads it as ordinary code hidden between slashes, tree-sitter blanks it and keeps the interpolation",
    // regex (the node type, not this project's own regex scanner) has the
    // identical child structure to `string` and `delimited_symbol`:
    // escape_sequence, interpolation, string_content. It was unlisted
    // anywhere in the config before this fix, for the same reason
    // delimited_symbol was: nothing already configured ever has it as a
    // child.
    // Regex reasoning (this project's own scanner, not the Ruby node
    // type it is masking): classify does recognise `/.../ ` as a literal
    // and blanks its interior, DANGEROUS included, the same as it would
    // for a quoted string; it just has no notion of an interpolation
    // inside one, so #{DANGEROUS} is blanked along with everything else.
    // tree-sitter reasoning, after the fix: regex is now in literalTypes,
    // so its span is blanked wholesale (both `/`s are anonymous) and its
    // string_content children ("foo", "bar") stay blanked while its
    // interpolation child is reopened as code.
    regexLiteral,
    blank(regexLiteral, "foo#{DANGEROUS}bar"),
    blank(blank(regexLiteral, "/foo"), "bar/"),
  ),
  disagree(
    "a `__END__` data section: regex reads the trailing data as ordinary code, tree-sitter masks it as not-code",
    // Finding 3, generalised: uninterpreted is Ruby's own name for
    // whatever text follows a `__END__` line -- never parsed as Ruby at
    // all, and as unreachable in the config as a root type like `comment`
    // is, since nothing else in the grammar ever has it as a child. It
    // was entirely unmasked before this fix: static trailing data in a
    // file, able to hide anything its author put there, read straight
    // through as live code.
    // Regex reasoning: `__END__` is just another identifier-like token
    // to classify, and everything after it is ordinary code, unchanged.
    // tree-sitter reasoning, after the fix: `__END__` itself stays code
    // (it is not part of the uninterpreted node), but everything from the
    // newline right after it through the end of the file is now
    // uninterpreted, in literalTypes, and gets blanked wholesale.
    endData,
    endData,
    blank(endData, "\nDANGEROUS raw text here\n"),
  ),
  disagree(
    "a subshell literal with no interpolation, `` `echo assert_this` ``: regex reads it as a JS-style template literal, tree-sitter reads it as Ruby's own subshell",
    // Finding 1: subshell (the backtick and `%x{}` shell-command literal)
    // has the identical child structure as `string`, `regex`, and
    // `delimited_symbol` -- escape_sequence, interpolation, string_content
    // -- and was left in CODE_TYPES, ordinary code, instead of
    // literalTypes, in the very commit that moved those three out for
    // having those exact children. Verified live before this fix: `` cmd =
    // `echo DANGEROUS_SECRET_TOKEN` `` masked to itself, unchanged.
    // Regex reasoning: this project's own scanner already treats a
    // backtick as a JS-style template literal's own delimiter (see
    // src/code-mask.ts), so it reads this the same way it would read any
    // JS template: the backticks stay visible as delimiters, and
    // everything between them -- with no `${...}` for it to recognise --
    // is blanked whole.
    // tree-sitter reasoning, after the fix: subshell is now in
    // literalTypes, so its whole span, both backticks included (anonymous
    // punctuation, part of the wholesale fill), is blanked; there is no
    // interpolation child here to reopen.
    "cmd = `echo assert_this`\n",
    blank("cmd = `echo assert_this`\n", "echo assert_this"),
    blank("cmd = `echo assert_this`\n", "`echo assert_this`"),
  ),
  disagree(
    "a subshell literal with an interpolation, `` `echo #{x}` ``: regex blanks the whole thing since it does not know Ruby's #{} form, tree-sitter keeps the interpolation",
    // Same subshell fix as above, exercising the interpolation child
    // subshell shares with `string` and `regex`: DANGEROUS stays visible
    // as code once subshell is correctly classified.
    // Regex reasoning: still reading this as a JS template literal, this
    // scanner only ever recognises `${...}` as an interpolation opener,
    // never Ruby's own `#{...}`, so `#{DANGEROUS}` is just more literal
    // text between the backticks to it, blanked along with "echo ".
    // tree-sitter reasoning, after the fix: `#{DANGEROUS}` is subshell's
    // own interpolation child, reopened to code the same way it already
    // is inside a plain `string`; "echo " (string_content) stays blanked
    // along with both backticks.
    "cmd = `echo #{DANGEROUS}`\n",
    blank("cmd = `echo #{DANGEROUS}`\n", "echo #{DANGEROUS}"),
    blank(blank("cmd = `echo #{DANGEROUS}`\n", "`echo "), "`"),
  ),
];

runDifferentialCorpus(
  "ruby",
  () => loadTreeSitterLanguageService(spec.packageName, spec.wasmFileName, spec.config),
  regexLanguageService,
  cases,
);
