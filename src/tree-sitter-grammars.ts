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
    literalTypes: new Set(["line_comment", "block_comment", "string_literal", "raw_string_literal"]),
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
    literalTypes: new Set(["comment", "string", "string_array", "heredoc_body"]),
    // bare_string is %w[]'s own per-word wrapper; string_content is its
    // child holding the actual characters, and the actual word itself.
    contentTypes: new Set(["string_content", "escape_sequence", "bare_string", "heredoc_content", "heredoc_end"]),
  },
};

const php: GrammarSpec = {
  packageName: "tree-sitter-php",
  wasmFileName: "tree-sitter-php.wasm",
  config: {
    literalTypes: new Set(["comment", "string", "encapsed_string", "heredoc", "heredoc_body", "nowdoc", "nowdoc_body"]),
    // heredoc_start/heredoc_end are the `<<<EOT` tag's own name, repeated
    // at open and close; not code, and not blanked by accident either
    // way since nothing there could satisfy a detector, but listed for
    // the same reason as everything else here: an unlisted named child
    // gets reopened as code, and a heredoc's tag name is not that.
    contentTypes: new Set(["string_content", "escape_sequence", "nowdoc_string", "heredoc_start", "heredoc_end"]),
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
    // No interpolation type: Java has none.
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
