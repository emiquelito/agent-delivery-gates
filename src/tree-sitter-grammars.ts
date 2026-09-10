// Data only: for each language added after Python, the npm package that
// ships its grammar, the plain wasm file inside it, and the node type
// names src/tree-sitter-language-service.ts's generic walk needs to tell
// a comment or a string from ordinary code. Nothing here imports
// web-tree-sitter or evaluates a wasm file; that stays true even for a
// process that reads this file, so listing all six languages' configs
// here up front costs nothing at module load. Loading the grammar itself
// happens only from src/code-mask.ts's registry, and only once a file of
// that language has actually been seen (see warmLanguageServices there).
//
// Every node type name below was read out of an actual parse, not out of
// a grammar's own docs: see this project's six tests/tree-sitter-*-differential.test.ts
// files for the samples each one came from. Two families of surprise
// showed up doing that:
//
//   - The same construct gets a different node type per grammar. Python
//     and PHP call every comment form "comment"; Rust and Java instead
//     have two separate types, "line_comment" and "block_comment"; Ruby
//     and Go also use one "comment" type but for different reasons again
//     (Ruby's covers `#` and `=begin`/`=end` both; Go's covers `//` and
//     `/* */` both).
//   - A comment can itself contain named children that are not code.
//     Rust's `///` and `//!` doc comments are not a plain leaf: tree-sitter
//     nests an `outer_doc_comment_marker` or `inner_doc_comment_marker`
//     plus a `doc_comment` node inside the `line_comment`/`block_comment`
//     span. Left off contentTypes, the generic walk in
//     tree-sitter-language-service.ts would treat those as an
//     interpolation surprise and reopen them as code, which would
//     have left every Rust doc comment showing as live code. No other
//     grammar here nests anything inside a comment.
import type { GrammarConfig } from "./tree-sitter-language-service.ts";

/** One language's grammar package plus the config its walk needs. */
export interface GrammarSpec {
  packageName: string;
  wasmFileName: string;
  config: GrammarConfig;
}

const rust: GrammarSpec = {
  packageName: "tree-sitter-rust",
  wasmFileName: "tree-sitter-rust.wasm",
  config: {
    // char_literal (`'a'`, `'\n'`) joins the string types for the same
    // reason Ruby's `character` does: it is a quoted literal like any
    // other, just one scalar wide, and is masked for consistency rather
    // than because a single character is a realistic hiding place.
    //
    // shebang is a script's own `#!/usr/bin/env ...` first line -- a
    // directive rustc itself ignores, the same kind of "not code, just
    // static text next to the code" as a comment.
    literalTypes: new Set([
      "line_comment",
      "block_comment",
      "string_literal",
      "raw_string_literal",
      "char_literal",
      "shebang",
    ]),
    // No interpolation type: `format!("{x}")`'s braces are ordinary string
    // text to this grammar, not a parsed expression, so nothing here is
    // ever reopened as code inside a Rust string.
    contentTypes: new Set([
      "string_content",
      "escape_sequence",
      "outer_doc_comment_marker",
      "inner_doc_comment_marker",
      "doc_comment",
    ]),
  },
};

const ruby: GrammarSpec = {
  packageName: "tree-sitter-ruby",
  wasmFileName: "tree-sitter-ruby.wasm",
  config: {
    // heredoc_body is its own node type, not a child of some outer
    // "heredoc" wrapper: a `<<~HEREDOC` line opens a sibling
    // heredoc_beginning node elsewhere in the tree, and the body that
    // follows is heredoc_body on its own.
    //
    // bare_string and bare_symbol are %w[]/%W[]'s and %i[]/%I[]'s own
    // per-word wrapper, one per word inside the array. Both belong here in
    // literalTypes, not in contentTypes: per tree-sitter-ruby's own
    // node-types.json, a bare_string/bare_symbol can itself hold a named
    // `interpolation` child (only %W and %I actually produce one; %w and
    // %i cannot interpolate, but the grammar gives all four the same node
    // structure). Listing bare_string/bare_symbol in contentTypes, as an
    // earlier version of this file did, blanks that child wholesale along
    // with the rest of the word instead of recursing into it, so a `%W[a#{
    // DANGEROUS}b]` interpolation was masked as literal text and never
    // reopened as code. Listing them here instead makes the walk recurse
    // into each word exactly as it already does for `string`: the word's
    // own plain-text children (string_content/escape_sequence) stay
    // blanked, and an interpolation child, unlisted anywhere, is reopened.
    //
    // delimited_symbol (`:"foo#{x}bar"`, the interpolated symbol form) and
    // chained_string (an implicit-concatenation `"a" "b"`, whose only child
    // is another `string`) join literalTypes for the same reason
    // bare_string/bare_symbol do: each is a container a plain `string`
    // shares its child structure with (escape_sequence/interpolation/
    // string_content, or in chained_string's case just a nested `string`
    // to recurse into), and each was reachable in a real parse without
    // being reachable through anything already in this config -- the
    // defect this file's own conformance test, tests/tree-sitter-node-types
    // -conformance.test.ts, now checks for directly instead of relying on
    // a hand walk of node-types.json to notice.
    //
    // regex (`/foo#{x}bar/`) has the identical child structure again --
    // escape_sequence/interpolation/string_content -- and the same
    // interpolation risk a plain string has.
    //
    // subshell (the backtick and `%x{}` shell-command literal) has that
    // same identical child structure a fourth time -- escape_sequence/
    // interpolation/string_content -- and was left in the node-types
    // conformance test's own CODE_TYPES list instead, ordinary code, not
    // a literal container, in the very commit that moved regex,
    // delimited_symbol, and chained_string out of it for having those
    // exact children. Verified live before this fix: `` cmd = `echo
    // DANGEROUS_SECRET_TOKEN` `` masked to itself, unchanged. The
    // completeness check in tests/tree-sitter-node-types-conformance.test.ts
    // could not have caught this on its own -- subshell's name was
    // present, just in the wrong bucket -- which is why that file now
    // also checks each CODE_TYPES entry's own children for exactly this
    // structure.
    //
    // uninterpreted is Ruby's own name for whatever text follows a
    // `__END__` line: a script's own trailing data section, never parsed
    // as Ruby at all. It is exactly as much "not code" as a comment, and
    // was entirely unmasked before this entry -- a `__END__` block hiding
    // instructions read straight through the mask.
    //
    // character is Ruby's `?a`/`?\n` single-character-literal form, a
    // leaf with no named children. Masked here for the same reason a
    // one-character string still counts as a literal: consistency with
    // how every other quoted literal in this file is treated, not because
    // one character is a realistic place to hide much text.
    literalTypes: new Set([
      "comment",
      "string",
      "string_array",
      "symbol_array",
      "bare_string",
      "bare_symbol",
      "heredoc_body",
      "delimited_symbol",
      "chained_string",
      "regex",
      "subshell",
      "uninterpreted",
      "character",
    ]),
    contentTypes: new Set(["string_content", "escape_sequence", "heredoc_content", "heredoc_end"]),
  },
};

const php: GrammarSpec = {
  packageName: "tree-sitter-php",
  wasmFileName: "tree-sitter-php.wasm",
  config: {
    // text_interpolation is this grammar's own name for the raw, non-PHP
    // text a `.php` file can hold outside any `<?php ... ?>` span --
    // ordinary surrounding HTML, most commonly. It is not Ruby-style
    // "extra" metadata about the file; it is a real named node the parser
    // produces, and before this entry it was entirely unmasked: static
    // text sitting right next to PHP code, invisible to this file's own
    // "not code" accounting.
    literalTypes: new Set([
      "comment",
      "string",
      "encapsed_string",
      "heredoc",
      "heredoc_body",
      "nowdoc",
      "nowdoc_body",
      "text_interpolation",
      // shell_command_expression is a backtick `` `echo $x` `` command
      // string: the grammar gives it the exact same child structure as
      // encapsed_string (string_content, escape_sequence, and PHP's five
      // interpolation forms), so it needs the same treatment.
      "shell_command_expression",
    ]),
    // PHP's `text` (raw HTML outside a `<?php ... ?>` span) is deliberately
    // NOT listed here, in contentTypes below, or anywhere else in this
    // config. That removes TWO independent masking effects, not one, and
    // they have different histories -- a prior version of this comment
    // conflated them and claimed the state was unchanged from before this
    // episode, which is false for one of the two:
    //
    //   - `text` as a bare child of `program` masks leading HTML, trailing
    //     HTML, and a template-only file with no `<?php` tag at all. This
    //     effect did not exist before this episode: `text` was not a
    //     literalType and had no way to be masked in that position. It was
    //     added by this episode's own first round and is removed here for
    //     the reasons below.
    //   - `text` as text_interpolation's own child masks HTML sitting
    //     BETWEEN two `<?php ... ?>` spans, PHP's most common templating
    //     form. This effect predates this episode by years: `text` sat in
    //     contentTypes for exactly this reason before any of the five
    //     rounds below started. Removing it here is a deliberate change
    //     from that years-old behaviour, not a restoration of it. It goes
    //     because a `<script>`/`<style>` element sitting between two php
    //     spans has its content inside a `text` node with no child
    //     structure of its own to reopen the way a real interpolation
    //     does, so masking that `text` node hid a real assertion inside
    //     it -- a hidden assertion, the one failure mode this project
    //     exists to prevent.
    //
    // Stated plainly because every earlier note here understated it: ALL
    // HTML in a `.php` file -- leading, trailing, template-only, AND
    // between two php spans -- now scans as live code. That is a real
    // regression from the years-old, pre-episode behaviour for the
    // between-tags case specifically, accepted on purpose because the
    // alternative is a hidden assertion inside an inline script/style
    // block. Full account of the three rounds that tried other answers in
    // src/tree-sitter-language-service.ts's own file header; the pinned
    // reproduction of the between-tags case is
    // tests/test-diff-separator.test.ts's own known-limitation test.
    // Between the two ways a false signal can go, this project keeps the
    // one whose failure is visible: a false "still code" signal shows up
    // in a diff for a person to see and dismiss, where a hidden assertion
    // does not.
    //
    // heredoc_start/heredoc_end are the `<<<EOT` tag's own name, repeated
    // at open and close; not code, and not blanked by accident either
    // way since nothing there could satisfy a detector, but listed for
    // the same reason as everything else here: an unlisted named child
    // gets reopened as code, and a heredoc's tag name is not that.
    //
    // php_tag and php_end_tag are text_interpolation's own literal `<?php`/
    // `?>` tags bracketing its actual content; neither is code, so both
    // stay blanked instead of being reopened. `text`, text_interpolation's
    // third possible child and the actual raw HTML itself, was listed here
    // for years before this episode -- it is what kept HTML between two
    // PHP spans masked -- and is now deliberately absent, for the same
    // reason it is out of literalTypes above: masking it hid a real
    // assertion inside an inline <script>/<style> block sitting between
    // two PHP spans, since tree-sitter-php gives that `text` node no child
    // structure for such a block to be reopened through. It now reopens as
    // ordinary code under this walk's default, the same as any other
    // unlisted named child -- which means an inline script/style block
    // stays visible, but so does every other piece of HTML sitting between
    // two PHP spans, not only script/style content.
    contentTypes: new Set(["string_content", "escape_sequence", "nowdoc_string", "heredoc_start", "heredoc_end", "php_tag", "php_end_tag"]),
  },
};

const go: GrammarSpec = {
  packageName: "tree-sitter-go",
  wasmFileName: "tree-sitter-go.wasm",
  config: {
    literalTypes: new Set(["comment", "interpreted_string_literal", "raw_string_literal", "rune_literal"]),
    // No interpolation type: Go has none.
    contentTypes: new Set(["interpreted_string_literal_content", "raw_string_literal_content", "escape_sequence"]),
  },
};

const java: GrammarSpec = {
  packageName: "tree-sitter-java",
  wasmFileName: "tree-sitter-java.wasm",
  config: {
    // string_literal covers both an ordinary "..." string and a """..."""
    // text block; the grammar gives them the same node type and tells
    // them apart only by which content-fragment type is inside.
    literalTypes: new Set(["line_comment", "block_comment", "string_literal", "character_literal"]),
    // Deliberately not listed: `string_interpolation`, the grammar's node
    // type for a `STR."value is \{expr}"` string template's `\{...}`
    // span. An earlier version of this comment said "No interpolation
    // type: Java has none", which was wrong -- the shipped grammar does
    // define string_interpolation -- and was a landmine for exactly the
    // maintainer who goes looking for it: finding an interpolation node
    // and reading this comment, they would have "fixed" the surprise
    // by adding string_interpolation to contentTypes, which blanks it
    // wholesale and hides the very expression that should stay visible as
    // code. Left unlisted here on purpose, the same as every other named
    // child not accounted for: an unlisted named child is reopened as
    // code by the walk's default, which is exactly the right answer for
    // an interpolation. Verified live: 'var x = STR."value is \{DANGEROUS}
    // ";' masks to keep \{DANGEROUS} visible and blank everything else.
    contentTypes: new Set(["string_fragment", "multiline_string_fragment", "escape_sequence"]),
  },
};

const csharp: GrammarSpec = {
  packageName: "tree-sitter-c-sharp",
  wasmFileName: "tree-sitter-c_sharp.wasm",
  config: {
    literalTypes: new Set([
      "comment",
      "string_literal",
      "verbatim_string_literal",
      "raw_string_literal",
      "interpolated_string_expression",
      "character_literal",
      // interpolation_format_clause is the `:...` suffix of an
      // interpolation, e.g. the `yyyy-MM-dd` in `$"{d:yyyy-MM-dd}"`. It is
      // a leaf with no named children of its own, and reads as free-form
      // static text -- a custom .NET format string can hold arbitrary
      // literal characters -- so it is masked here the same as any other
      // literal, not left to fall through as ordinary code the way its
      // sibling interpolation_alignment_clause (a real expression) does.
      "interpolation_format_clause",
      // preproc_arg is the free-text argument of a preprocessor directive
      // this grammar treats as an "extra" -- most visibly, the label after
      // `#region`/`#endregion`. Unmasked, a `#region` label is exactly the
      // same kind of static text as everything else in this file: visible
      // in a diff, not code, and able to hide anything its author writes
      // there.
      "preproc_arg",
      // shebang_directive is a script's own `#!/usr/bin/env ...` first
      // line, the same kind of ignored, static directive text as Rust's
      // `shebang` and this same list's own comment above it.
      "shebang_directive",
    ]),
    // interpolation_start ("$" or "$@") and interpolation_quote (the
    // opening/closing quote of an interpolated string, `"`/`"""`) are
    // both their own named node types here, unlike every other grammar
    // above where a string's own quote is anonymous punctuation; left off
    // contentTypes they would be misread as an interpolation and
    // reopened as code.
    contentTypes: new Set([
      // string_literal_content is a plain "..." string's own text;
      // string_content is the distinct type the grammar gives that same
      // plain-text role *inside* an interpolated_string_expression --
      // two different node type names for what reads as the same thing,
      // and missing either one leaves that string's plain-text runs
      // reopened as code instead of masked.
      "string_literal_content",
      "string_content",
      "character_literal_content",
      "raw_string_start",
      "raw_string_content",
      "raw_string_end",
      // string_literal_encoding is the "u8" suffix on a UTF-8 byte string
      // literal, `"foo"u8`, a named sibling of string_literal_content
      // inside the same string_literal node. Unlisted, it read as an
      // unrecognised named child, and the walk reopened it as code:
      // `"hello"u8` masked to `       u8`, with the suffix showing as
      // live code after a string that was otherwise blanked.
      "string_literal_encoding",
      "interpolation_start",
      "interpolation_quote",
      "escape_sequence",
    ]),
  },
};

/** Every language this project masks with tree-sitter after Python, keyed
 * by the lowercase file extension it owns. JavaScript and TypeScript are
 * deliberately absent: the regex scanner in src/code-mask.ts was written
 * for exactly those two languages and stays their answer, on purpose, for
 * this phase (see this project's history for why switching them needs
 * its own commit and its own differential, not a place in this table). */
export const GRAMMAR_SPECS: Readonly<Record<string, GrammarSpec>> = {
  ".rs": rust,
  ".rb": ruby,
  ".php": php,
  ".go": go,
  ".java": java,
  ".cs": csharp,
};

/**
 * The npm devDependency each tree-sitter-backed extension needs to get a
 * working grammar, for a user-facing message that names something they
 * can actually do about it: `npm install --save-dev <name> web-tree-sitter`
 * in their own project reaches these packages today, independent of
 * whether this project's own package.json ever lists them as a runtime
 * dependency (see src/code-mask.ts's STOP-GAP comment above
 * grammarAbsentExtensions for why it currently does not). Derived from
 * GRAMMAR_SPECS, plus ".py", which keeps its own bespoke loader
 * (src/tree-sitter-python-service.ts) and so is not itself a GrammarSpec.
 */
export const GRAMMAR_PACKAGE_NAMES: Readonly<Record<string, string>> = {
  ".py": "tree-sitter-python",
  ...Object.fromEntries(Object.entries(GRAMMAR_SPECS).map(([ext, spec]) => [ext, spec.packageName])),
};

/** The `adg lang add` name for each extension -- see
 * src/tree-sitter-grammar-store.ts's LANGUAGES for the table this mirrors.
 * Kept as a second, small table here, not imported from that file:
 * src/tree-sitter-grammar-store.ts itself imports GRAMMAR_SPECS from this
 * file, so importing back from there would open the same kind of import
 * cycle src/code-mask.ts's own file header warns against. */
const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  ".py": "python",
  ".rs": "rust",
  ".rb": "ruby",
  ".php": "php",
  ".go": "go",
  ".java": "java",
  ".cs": "csharp",
};

/**
 * The `adg lang add` line a user can actually run today to get a working
 * grammar for every extension in `extensions`: every language named for
 * them, deduplicated. This fetches just the plain wasm files those
 * languages need, not the full grammar packages `npm install` would pull
 * in (native prebuilds and vendored duplicates included) -- see
 * src/tree-sitter-grammar-store.ts for why that distinction matters. Every
 * production consumer of `grammarAbsentExtensions` (see
 * src/test-diff-separator.ts's SeparateResult) builds its own warning text
 * around this one line, so the actual command stays in one place.
 */
export function installHintFor(extensions: readonly string[]): string {
  const names = new Set<string>();
  for (const ext of extensions) {
    const name = LANGUAGE_NAMES[ext];
    if (name !== undefined) names.add(name);
  }
  return `npx adg lang add ${[...names].sort().join(" ")}`;
}
