// Closes the class, not just the instances.
//
// Three node-type omissions have now been found in this project's config,
// across three separate rounds of review: Ruby's `bare_string` (a %W[]
// word's own interpolation, masked away as if it were plain text), Rust's
// doc-comment marker nodes, and Ruby's `delimited_symbol` (the interpolated
// `:"..."` symbol form, entirely unmasked). The first version of this file
// closed the first two by walking node-types.json's own children lists
// outward from whatever was already in a grammar's literalTypes and
// contentTypes, and asserting every named type it reached was accounted
// for. That caught a type reachable *through* something already
// configured. It could not catch a type that was never a child of
// anything else at all.
//
// `delimited_symbol` is exactly that: nothing in tree-sitter-ruby's own
// node-types.json ever lists it as a named child of any other type. Nor
// does anything list Ruby's own `comment`, or Rust's `line_comment`, or
// any grammar's own root literal type. A quick, damning proof: removing
// the top-level comment type from any of this project's six grammar
// configs in turn, under the old version of this file, left every single
// one of those six tests passing. The walk simply never visited the type
// that was missing, because nothing seeded it into the search in the first
// place. The one proof-of-failure test the old file shipped with only ever
// removed `bare_string`, which happens to be reachable as a child of
// `string_array` -- it did not generalise, and could not have caught the
// bug that was hiding in the same file at the same time.
//
// This version replaces that walk with a flat check: every named,
// concrete type a grammar's own node-types.json says it can produce --
// full stop, not "every type reachable from configuration" -- must be
// classified into exactly one of:
//
//   - literalTypes or contentTypes (src/tree-sitter-grammars.ts's own
//     config: a literal container, or plain text found inside one)
//   - EXCLUSIONS (a real, code-bearing construct -- an interpolation, most
//     commonly -- deliberately left out so the walk reopens it as code)
//   - CODE_TYPES (ordinary code with nothing to do with a literal at all:
//     a statement, an expression, a pattern, a declaration)
//
// A type in none of the four fails the test. Nothing is exempt by being
// unreachable from what is already configured, because nothing here is
// reached that way any more: this file no longer walks node-types.json's
// children lists outward from a seed set. It reads every entry the file
// has and requires all of them to be spoken for.
//
// Why not stop at "everything reachable from a literal container", fixed
// to also seed from a grammar's own root type? Because reachability
// through node-types.json's children lists cannot see `delimited_symbol`
// or `comment` at all, seeded from anywhere. Both are top-level
// alternatives inside a large "what can an expression be" or "what is an
// extra" choice, not a fixed field of some other rule, and neither shows
// up in any entry's own children.types anywhere in the file (checked
// directly against tree-sitter-ruby's own node-types.json: zero entries
// list `comment` as a child, zero list `delimited_symbol`). A grammar's
// node-types.json simply does not encode "how would a real parse ever
// produce this node" as a graph anyone can walk; it only encodes fixed
// parent/child field structures. There is no narrower graph-based rule that
// is still exhaustive for this. The only exhaustive option is the flat
// one this file now uses: read the whole list, require every entry in it
// to be spoken for.
//
// The trade-off that buys: CODE_TYPES is long -- most of a grammar is
// ordinary statements, expressions, and patterns that have nothing to do
// with a string or a comment, and ends up listed here anyway, once per
// grammar, so that "every named type is accounted for" actually means
// every one, not "every one this file's author found interesting". A
// grammar upgrade that adds a node type shows up as newly unaccounted
// here, forcing a deliberate decision -- literal, content, exclusion, or
// ordinary code -- instead of silently taking the default. That is what
// "drift-proof" costs.
//
// Every CODE_TYPES entry was reviewed before being added, not just copied
// from a diff: each grammar's own missing list was scanned by name for
// anything that could plausibly be text-bearing (string, char, comment,
// symbol, text, doc, quote, escape, interpolation, literal, heredoc,
// nowdoc, template, raw, region, pragma, label, tag, regex, pattern, and
// more), and every hit was inspected against the grammar's own
// node-types.json by hand, not dismissed by its name alone -- the reviewer
// finding that started this round said as much: "Be careful with any
// filter based on a type's NAME. `delimited_symbol` contains neither
// 'string' nor 'comment', which is precisely how it was missed." That
// review is what actually found this round's fixes, beyond delimited_symbol
// itself: Ruby's `regex` and `chained_string` (same child structure as
// `string`), Ruby's `uninterpreted` (`__END__` trailing data, entirely
// unmasked), Ruby's `character` (`?a`), Rust's `char_literal`, both
// grammars' `shebang`/`shebang_directive`, PHP's `text_interpolation`
// (raw HTML outside `<?php ?>`, entirely unmasked) and its own
// `shell_command_expression` (a backtick command, same structure as
// encapsed_string), and C#'s `interpolation_format_clause` and
// `preproc_arg` (a `#region` label's own free text, entirely unmasked).
// Every one of those is a real fix in src/tree-sitter-grammars.ts, not
// just a new line in this file's own accounting.
//
// That version of this file shipped with a defect of its own, found by
// the next round of review, and this file overstated what it covered
// until now: the flat check above proves every named type lands in
// *some* bucket. It never proved a type landed in the *right* one --
// CODE_TYPES and literalTypes were both just sets of strings to it, so a
// type filed into the wrong one passed exactly as cleanly as a correctly
// classified one would. Ruby's own `subshell` (the backtick and `%x{}`
// shell-command literal) sat in CODE_TYPES with the identical child
// structure as `string`, `regex`, and `delimited_symbol` --
// escape_sequence/interpolation/string_content -- in the very commit that
// moved those three out of CODE_TYPES for having those exact children, and
// this file's own completeness check passed anyway: subshell's name was
// present, just filed under the wrong heading. `findMisclassifiedCodeTypes`
// below closes that: it reads each CODE_TYPES entry's own children.types
// and flags one whose children mark it as a literal container, with a
// narrower marker set than "any child that could be text" (see that
// function's own comment for why PHP's interpolation forms could not be
// used as markers without flagging ordinary statements too). Any
// CODE_TYPES entry the check would otherwise flag as actually ordinary
// code is named in CORRECTNESS_EXCEPTIONS, with the reason recorded there
// instead of the check being narrowed further or silenced.
//
// The same round of review found this file's own Python half was
// decorative in a different way: PYTHON_MODEL was a hand-typed copy of
// what tree-sitter-python-service.ts's markNode actually did, not a check
// against markNode itself, so removing format_specifier's real handling
// from that file left the untouched copy here still green -- 15 of 15
// passing, including the test named for exactly this. PYTHON_MODEL below
// is now built from PYTHON_CONFIG, imported directly from
// tree-sitter-python-service.ts, which markNode reads at runtime: there is
// one object, not two that can drift apart. See that file's own header
// for why it needed a third classification bucket, delimiterTypes, that
// the other six grammars do not.
//
// A ceiling on the correctness check itself, worth stating plainly rather
// than leaving a reader to discover it: findMisclassifiedCodeTypes flags a
// CODE_TYPES entry by reading its own named children for a marker that says
// "this looks like a literal container", which means it can only ever flag
// a type that HAS named children to read. An atomic leaf -- no named
// children at all -- gives the check nothing to signal on, so a leaf
// misfiled into CODE_TYPES when it should have been a literal cannot be
// caught by this check, whatever else about it looks wrong. `comment`,
// `character`, `shebang`, `char_literal`, PHP's `text`, and C#'s
// `verbatim_string_literal` are all in that class across this file's six
// grammars: every one of them is a leaf in the grammar that defines it.
// Checked directly against each grammar's own node-types.json: none of
// them, or any other leaf type, sits in CODE_TYPES today, so nothing is
// misfiled and unreachable by this check right now -- but a future one
// would be, and this check alone would not be the thing to catch it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { GRAMMAR_SPECS, type GrammarSpec } from "../src/tree-sitter-grammars.ts";
import type { GrammarConfig } from "../src/tree-sitter-language-service.ts";
import { PYTHON_CONFIG } from "../src/tree-sitter-python-service.ts";

/** One named node type entry from a grammar's own node-types.json, pared
 * down to what this file reads: its own type name, whether it is a real
 * concrete node type or a supertype alias, and (unused now, kept only
 * because loadNodeTypes's return type still describes the file's actual
 * structure) its own named children. node-types.json also carries anonymous
 * (unnamed) type entries under the same "type" string for some grammars
 * (PHP's own `string` keyword token alongside its named `string` node,
 * for instance) -- those are filtered out by `named`, the same way
 * markNode itself only ever looks at `child.isNamed` children.
 *
 * `subtypes` marks a supertype alias -- tree-sitter's own grouping node
 * for a choice rule, such as Rust's `_literal` (grouping boolean_literal,
 * char_literal, string_literal, and so on) or C#'s `literal`. A supertype
 * entry is never itself the `.type` of a real produced node; a real parse
 * always shows the concrete alternative instead. Entries with `subtypes`
 * are excluded from this file's own accounting for exactly that reason:
 * asking whether `_literal` itself is "classified" is a category error,
 * since no node ever has that type at runtime.
 */
interface NodeTypeEntry {
  readonly type: string;
  readonly named?: boolean;
  readonly subtypes?: ReadonlyArray<{ readonly type: string }>;
  readonly children?: { readonly types?: ReadonlyArray<{ readonly type: string; readonly named?: boolean }> };
}

/** Where each grammar package keeps its own node-types.json, relative to
 * the package root resolved from its package.json -- not always
 * "src/node-types.json": tree-sitter-php ships two grammar variants
 * (php_only and the full php dialect that mixes in HTML), each with its
 * own node-types.json, and src/tree-sitter-grammars.ts's php spec loads
 * "tree-sitter-php.wasm", the full dialect, so this reads php/src/
 * node-types.json to match, not php_only's. */
const NODE_TYPES_SUBPATH: Readonly<Record<string, string>> = {
  ".rs": "src/node-types.json",
  ".rb": "src/node-types.json",
  ".php": "php/src/node-types.json",
  ".go": "src/node-types.json",
  ".java": "src/node-types.json",
  ".cs": "src/node-types.json",
  ".py": "src/node-types.json",
};

/**
 * Every named node type deliberately left out of both literalTypes and
 * contentTypes because it is a real, code-bearing construct -- most
 * commonly an interpolation -- that the generic walk in
 * src/tree-sitter-language-service.ts is supposed to reopen as code by
 * leaving it unlisted, not an oversight. Each entry names the actual
 * finding that put it here:
 *
 *   - ruby "interpolation": `#{...}` inside a string, a heredoc, a
 *     %W[]/%I[] word or symbol array, `delimited_symbol`, or `regex`.
 *   - ruby "hash_key_symbol" and "simple_symbol" (Finding 3c and its
 *     generalisation): a hash key (`assert_this:`) or a plain symbol
 *     (`:foo`) is a leaf, structurally an identifier, not text a diff
 *     author could hide anything inside -- masking it would flag
 *     ordinary Ruby syntax as though it were free text. Left unlisted on
 *     purpose, the same as an interpolation, so it stays code.
 *   - ruby "heredoc_beginning": a heredoc's own opening tag
 *     (`<<~SQL`), a sibling of heredoc_body, not a child of it.
 *     It is the tag's name, not content, and staying visible as code is
 *     correct, the same reason PHP's heredoc_start/heredoc_end (nested
 *     inside their own heredoc, unlike Ruby's) are content types instead:
 *     different node structure, same non-content role.
 *   - java "string_interpolation": `\{...}` inside a `STR."..."` string
 *     template.
 *   - csharp "interpolation": `{...}` inside a `$"..."` interpolated
 *     string.
 *   - csharp "interpolation_alignment_clause": the `,10` alignment clause
 *     in `{x,10}` can itself hold an arbitrary expression, per the
 *     grammar's own children list -- real code, not a format string.
 *   - csharp "interpolation_brace": the interpolation's own `{`/`}`,
 *     oddly given a real node type here instead of being anonymous
 *     punctuation like every other brace in this file. A leaf with
 *     nothing inside it; leaving it as code is harmless.
 *   - php's five: `$var`, `$obj->prop`, `$arr[key]`, and `${...}`/`{$...}`
 *     forms all parse to one of these five node types inside a
 *     string/encapsed_string/heredoc_body/shell_command_expression --
 *     "expression" is PHP's own supertype name covering the general
 *     `{$expr}` form, and the other four are its more specific unwrapped
 *     forms ($var, ->member, [subscript], and a dynamic ($$) variable
 *     name).
 *
 *     The false-positive reason above is why these five cannot join
 *     CONTENT_SHAPED_MARKERS (see that constant's own comment): "expression"
 *     alone is also the entire children list of 27 ordinary PHP statement
 *     types, so using it as a marker would flag every one of those as a
 *     literal container the moment it has any child at all. That leaves a
 *     real hole on the other side, put on the record here instead of only
 *     being implied by the exclusion: a *literal* container whose own children
 *     were exclusively these five forms would look, structurally, exactly
 *     like an ordinary statement to findMisclassifiedCodeTypes, and a
 *     future PHP literal type filed into CODE_TYPES by mistake, built that
 *     way, would pass the correctness check undetected -- the same failure
 *     class subshell was actually caught in, just for the one grammar this
 *     check cannot close it for. Checked directly against tree-sitter-php's
 *     own node-types.json at the time of this writing: no CODE_TYPES entry
 *     has a children list built exclusively from these five, so the hole is
 *     real but empty today, not exploited.
 */
const EXCLUSIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  ".rs": new Set(),
  ".rb": new Set(["interpolation", "hash_key_symbol", "simple_symbol", "heredoc_beginning"]),
  ".php": new Set(["expression", "variable_name", "member_access_expression", "subscript_expression", "dynamic_variable_name"]),
  ".go": new Set(),
  ".java": new Set(["string_interpolation"]),
  ".cs": new Set(["interpolation", "interpolation_alignment_clause", "interpolation_brace"]),
};

/**
 * Every other named, concrete type each grammar can produce: ordinary
 * statements, expressions, declarations, and patterns that have nothing to
 * do with a literal or a comment, generated once from that grammar's own
 * node-types.json (see this file's header for the review process each
 * list went through) and pinned here so a *new* type showing up in a
 * grammar upgrade fails this file instead of silently landing in neither
 * bucket. This is the "obvious, verbose" half of the exhaustive approach
 * this file's header discusses: most of each list below is exactly as
 * uninteresting as it looks, and that is the point -- nothing here was
 * worth a per-type comment, but every one of them still had to be looked
 * at once to end up here instead of in literalTypes, contentTypes, or
 * EXCLUSIONS.
 */
const CODE_TYPES: Readonly<Record<string, ReadonlySet<string>>> = {
  ".rs": new Set([
    "abstract_type", "arguments", "array_expression", "array_type", "assignment_expression", "associated_type",
    "async_block", "attribute", "attribute_item", "await_expression", "base_field_initializer", "binary_expression",
    "block", "boolean_literal", "bounded_type", "bracketed_type", "break_expression", "call_expression",
    "captured_pattern", "closure_expression", "closure_parameters", "compound_assignment_expr", "const_block",
    "const_item", "const_parameter", "continue_expression", "crate", "declaration_list", "dynamic_type",
    "else_clause", "empty_statement", "enum_item", "enum_variant", "enum_variant_list", "expression_statement",
    "extern_crate_declaration", "extern_modifier", "field_declaration", "field_declaration_list", "field_expression",
    "field_identifier", "field_initializer", "field_initializer_list", "field_pattern", "float_literal",
    "for_expression", "for_lifetimes", "foreign_mod_item", "fragment_specifier", "function_item",
    "function_modifiers", "function_signature_item", "function_type", "gen_block", "generic_function",
    "generic_pattern", "generic_type", "generic_type_with_turbofish", "higher_ranked_trait_bound", "identifier",
    "if_expression", "impl_item", "index_expression", "inner_attribute_item", "integer_literal", "label",
    "let_chain", "let_condition", "let_declaration", "lifetime", "lifetime_parameter", "loop_expression",
    "macro_definition", "macro_invocation", "macro_rule", "match_arm", "match_block", "match_expression",
    "match_pattern", "metavariable", "mod_item", "mut_pattern", "mutable_specifier", "negative_literal",
    "never_type", "or_pattern", "ordered_field_declaration_list", "parameter", "parameters",
    "parenthesized_expression", "pointer_type", "primitive_type", "qualified_type", "range_expression",
    "range_pattern", "ref_pattern", "reference_expression", "reference_pattern", "reference_type",
    "remaining_field_pattern", "removed_trait_bound", "return_expression", "scoped_identifier",
    "scoped_type_identifier", "scoped_use_list", "self", "self_parameter", "shorthand_field_identifier",
    "shorthand_field_initializer", "slice_pattern", "source_file", "static_item", "struct_expression",
    "struct_item", "struct_pattern", "super", "token_binding_pattern", "token_repetition",
    "token_repetition_pattern", "token_tree", "token_tree_pattern", "trait_bounds", "trait_item", "try_block",
    "try_expression", "tuple_expression", "tuple_pattern", "tuple_struct_pattern", "tuple_type", "type_arguments",
    "type_binding", "type_cast_expression", "type_identifier", "type_item", "type_parameter", "type_parameters",
    "unary_expression", "union_item", "unit_expression", "unit_type", "unsafe_block", "use_as_clause",
    "use_bounds", "use_declaration", "use_list", "use_wildcard", "variadic_parameter", "visibility_modifier",
    "where_clause", "where_predicate", "while_expression", "yield_expression",
  ]),
  ".rb": new Set([
    "alias", "alternative_pattern", "argument_list", "array", "array_pattern", "as_pattern", "assignment",
    "begin", "begin_block", "binary", "block", "block_argument", "block_body", "block_parameter",
    "block_parameters", "body_statement", "break", "call", "case", "case_match", "class", "class_variable",
    "complex", "conditional", "constant", "destructured_left_assignment", "destructured_parameter", "do",
    "do_block", "element_reference", "else", "elsif", "empty_statement", "encoding", "end_block", "ensure",
    "exception_variable", "exceptions", "expression_reference_pattern", "false", "file", "find_pattern",
    "float", "for", "forward_argument", "forward_parameter", "global_variable", "hash", "hash_pattern",
    "hash_splat_argument", "hash_splat_nil", "hash_splat_parameter", "identifier", "if", "if_guard",
    "if_modifier", "in", "in_clause", "instance_variable", "integer", "keyword_parameter", "keyword_pattern",
    "lambda", "lambda_parameters", "left_assignment_list", "line", "match_pattern", "method",
    "method_parameters", "module", "next", "nil", "operator", "operator_assignment", "optional_parameter",
    "pair", "parenthesized_pattern", "parenthesized_statements", "pattern", "program", "range", "rational",
    "redo", "rescue", "rescue_modifier", "rest_assignment", "retry", "return", "right_assignment_list",
    "scope_resolution", "self", "setter", "singleton_class", "singleton_method", "splat_argument",
    "splat_parameter", "super", "superclass", "test_pattern", "then", "true", "unary", "undef",
    "unless", "unless_guard", "unless_modifier", "until", "until_modifier", "variable_reference_pattern",
    "when", "while", "while_modifier", "yield",
  ]),
  ".php": new Set([
    "abstract_modifier", "anonymous_class", "anonymous_function", "anonymous_function_use_clause", "argument",
    "arguments", "array_creation_expression", "array_element_initializer", "arrow_function", "assignment_expression",
    "attribute", "attribute_group", "attribute_list", "augmented_assignment_expression", "base_clause",
    "binary_expression", "boolean", "bottom_type", "break_statement", "by_ref", "case_statement",
    "cast_expression", "cast_type", "catch_clause", "class_constant_access_expression", "class_declaration",
    "class_interface_clause", "clone_expression", "colon_block", "compound_statement", "conditional_expression",
    "const_declaration", "const_element", "continue_statement", "declaration_list", "declare_directive",
    "declare_statement", "default_statement", "disjunctive_normal_form_type", "do_statement", "echo_statement",
    "else_clause", "else_if_clause", "empty_statement", "enum_case", "enum_declaration", "enum_declaration_list",
    "error_suppression_expression", "exit_statement", "expression_statement", "final_modifier", "finally_clause",
    "float", "for_statement", "foreach_statement", "formal_parameters", "function_call_expression",
    "function_definition", "function_static_declaration", "global_declaration", "goto_statement", "if_statement",
    "include_expression", "include_once_expression", "integer", "interface_declaration", "intersection_type",
    "list_literal", "match_block", "match_condition_list", "match_conditional_expression", "match_default_expression",
    "match_expression", "member_call_expression", "method_declaration", "name", "named_label_statement",
    "named_type", "namespace_definition", "namespace_name", "namespace_use_clause", "namespace_use_declaration",
    "namespace_use_group", "null", "nullsafe_member_access_expression", "nullsafe_member_call_expression",
    "object_creation_expression", "operation", "optional_type", "pair", "parenthesized_expression",
    "primitive_type", "print_intrinsic", "program", "property_declaration", "property_element", "property_hook",
    "property_hook_list", "property_promotion_parameter", "qualified_name", "readonly_modifier",
    "reference_assignment_expression", "reference_modifier", "relative_name", "relative_scope",
    "require_expression", "require_once_expression", "return_statement", "scoped_call_expression",
    "scoped_property_access_expression", "sequence_expression", "simple_parameter", "static_modifier",
    "static_variable_declaration", "switch_block", "switch_statement", "throw_expression", "trait_declaration",
    "try_statement", "type_list", "unary_op_expression", "union_type", "unset_statement", "update_expression",
    "use_as_clause", "use_declaration", "use_instead_of_clause", "use_list", "var_modifier", "variadic_parameter",
    "variadic_placeholder", "variadic_unpacking", "visibility_modifier", "while_statement", "yield_expression",
  ]),
  ".go": new Set([
    "argument_list", "array_type", "assignment_statement", "binary_expression", "blank_identifier", "block",
    "break_statement", "call_expression", "channel_type", "communication_case", "composite_literal",
    "const_declaration", "const_spec", "continue_statement", "dec_statement", "default_case", "defer_statement",
    "dot", "empty_statement", "expression_case", "expression_list", "expression_statement",
    "expression_switch_statement", "fallthrough_statement", "false", "field_declaration", "field_declaration_list",
    "field_identifier", "float_literal", "for_clause", "for_statement", "func_literal", "function_declaration",
    "function_type", "generic_type", "go_statement", "goto_statement", "identifier", "if_statement",
    "imaginary_literal", "implicit_length_array_type", "import_declaration", "import_spec", "import_spec_list",
    "inc_statement", "index_expression", "int_literal", "interface_type", "iota", "keyed_element", "label_name",
    "labeled_statement", "literal_element", "literal_value", "map_type", "method_declaration", "method_elem",
    "negated_type", "nil", "package_clause", "package_identifier", "parameter_declaration", "parameter_list",
    "parenthesized_expression", "parenthesized_type", "pointer_type", "qualified_type", "range_clause",
    "receive_statement", "return_statement", "select_statement", "selector_expression", "send_statement",
    "short_var_declaration", "slice_expression", "slice_type", "source_file", "statement_list", "struct_type",
    "true", "type_alias", "type_arguments", "type_assertion_expression", "type_case", "type_constraint",
    "type_conversion_expression", "type_declaration", "type_elem", "type_identifier", "type_instantiation_expression",
    "type_parameter_declaration", "type_parameter_list", "type_spec", "type_switch_statement", "unary_expression",
    "var_declaration", "var_spec", "var_spec_list", "variadic_argument", "variadic_parameter_declaration",
  ]),
  ".java": new Set([
    "annotated_type", "annotation", "annotation_argument_list", "annotation_type_body", "annotation_type_declaration",
    "annotation_type_element_declaration", "argument_list", "array_access", "array_creation_expression",
    "array_initializer", "array_type", "assert_statement", "assignment_expression", "asterisk", "binary_expression",
    "binary_integer_literal", "block", "boolean_type", "break_statement", "cast_expression", "catch_clause",
    "catch_formal_parameter", "catch_type", "class_body", "class_declaration", "class_literal",
    "compact_constructor_declaration", "constant_declaration", "constructor_body", "constructor_declaration",
    "continue_statement", "decimal_floating_point_literal", "decimal_integer_literal", "dimensions",
    "dimensions_expr", "do_statement", "element_value_array_initializer", "element_value_pair",
    "enhanced_for_statement", "enum_body", "enum_body_declarations", "enum_constant", "enum_declaration",
    "explicit_constructor_invocation", "exports_module_directive", "expression_statement", "extends_interfaces",
    "false", "field_access", "field_declaration", "finally_clause", "floating_point_type", "for_statement",
    "formal_parameter", "formal_parameters", "generic_type", "guard", "hex_floating_point_literal",
    "hex_integer_literal", "identifier", "if_statement", "import_declaration", "inferred_parameters",
    "instanceof_expression", "integral_type", "interface_body", "interface_declaration", "labeled_statement",
    "lambda_expression", "local_variable_declaration", "marker_annotation", "method_declaration",
    "method_invocation", "method_reference", "modifiers", "module_body", "module_declaration", "null_literal",
    "object_creation_expression", "octal_integer_literal", "opens_module_directive", "package_declaration",
    "parenthesized_expression", "pattern", "permits", "program", "provides_module_directive", "receiver_parameter",
    "record_declaration", "record_pattern", "record_pattern_body", "record_pattern_component", "requires_modifier",
    "requires_module_directive", "resource", "resource_specification", "return_statement", "scoped_identifier",
    "scoped_type_identifier", "spread_parameter", "static_initializer", "super", "super_interfaces", "superclass",
    "switch_block", "switch_block_statement_group", "switch_expression", "switch_label", "switch_rule",
    "synchronized_statement", "template_expression", "ternary_expression", "this", "throw_statement", "throws",
    "true", "try_statement", "try_with_resources_statement", "type_arguments", "type_bound", "type_identifier",
    "type_list", "type_parameter", "type_parameters", "type_pattern", "unary_expression", "underscore_pattern",
    "update_expression", "uses_module_directive", "variable_declarator", "void_type", "while_statement",
    "wildcard", "yield_statement",
  ]),
  ".cs": new Set([
    "accessor_declaration", "accessor_list", "alias_qualified_name", "and_pattern", "anonymous_method_expression",
    "anonymous_object_creation_expression", "argument", "argument_list", "array_creation_expression",
    "array_rank_specifier", "array_type", "arrow_expression_clause", "as_expression", "assignment_expression",
    "attribute", "attribute_argument", "attribute_argument_list", "attribute_list", "attribute_target_specifier",
    "await_expression", "base_list", "binary_expression", "block", "boolean_literal", "bracketed_argument_list",
    "bracketed_parameter_list", "break_statement", "calling_convention", "cast_expression", "catch_clause",
    "catch_declaration", "catch_filter_clause", "checked_expression", "checked_statement", "class_declaration",
    "collection_element", "collection_expression", "compilation_unit", "conditional_access_expression",
    "conditional_expression", "constant_pattern", "constructor_constraint", "constructor_declaration",
    "constructor_initializer", "continue_statement", "conversion_operator_declaration", "declaration_expression",
    "declaration_list", "declaration_pattern", "default_expression", "delegate_declaration",
    "destructor_declaration", "discard", "do_statement", "element_access_expression", "element_binding_expression",
    "empty_statement", "enum_declaration", "enum_member_declaration", "enum_member_declaration_list",
    "event_declaration", "event_field_declaration", "explicit_interface_specifier", "expression_element",
    "expression_statement", "extern_alias_directive", "field_declaration", "file_scoped_namespace_declaration",
    "finally_clause", "fixed_statement", "for_statement", "foreach_statement", "from_clause",
    "function_pointer_parameter", "function_pointer_type", "generic_name", "global_attribute", "global_statement",
    "goto_statement", "group_clause", "identifier", "if_statement", "implicit_array_creation_expression",
    "implicit_object_creation_expression", "implicit_parameter", "implicit_stackalloc_expression", "implicit_type",
    "indexer_declaration", "initializer_expression", "integer_literal", "interface_declaration",
    "invocation_expression", "is_expression", "is_pattern_expression", "join_clause", "join_into_clause",
    "labeled_statement", "lambda_expression", "let_clause", "list_pattern", "local_declaration_statement",
    "local_function_statement", "lock_statement", "makeref_expression", "member_access_expression",
    "member_binding_expression", "method_declaration", "modifier", "namespace_declaration", "negated_pattern",
    "null_literal", "nullable_type", "object_creation_expression", "operator_declaration", "or_pattern",
    "order_by_clause", "parameter", "parameter_list", "parenthesized_expression", "parenthesized_pattern",
    "parenthesized_variable_designation", "pointer_type", "positional_pattern_clause", "postfix_unary_expression",
    "predefined_type", "prefix_unary_expression", "preproc_define", "preproc_elif", "preproc_else",
    "preproc_endregion", "preproc_error", "preproc_if", "preproc_if_in_attribute_list", "preproc_line",
    "preproc_nullable", "preproc_pragma", "preproc_region", "preproc_undef", "preproc_warning",
    "primary_constructor_base_type", "property_declaration", "property_pattern_clause", "qualified_name",
    "query_expression", "range_expression", "real_literal", "record_declaration", "recursive_pattern",
    "ref_expression", "ref_type", "reftype_expression", "refvalue_expression", "relational_pattern",
    "return_statement", "scoped_type", "select_clause", "sizeof_expression", "spread_element",
    "stackalloc_expression", "struct_declaration", "subpattern", "switch_body", "switch_expression",
    "switch_expression_arm", "switch_section", "switch_statement", "throw_expression", "throw_statement",
    "try_statement", "tuple_element", "tuple_expression", "tuple_pattern", "tuple_type", "type_argument_list",
    "type_parameter", "type_parameter_constraint", "type_parameter_constraints_clause", "type_parameter_list",
    "type_pattern", "typeof_expression", "unary_expression", "unsafe_statement", "using_directive",
    "using_statement", "var_pattern", "variable_declaration", "variable_declarator", "when_clause", "where_clause",
    "while_statement", "with_expression", "with_initializer", "yield_statement",
  ]),
};

/**
 * Python's own tree-sitter service, src/tree-sitter-python-service.ts,
 * predates GrammarConfig and is not driven by one -- but it is driven by
 * its own PYTHON_CONFIG, a plain data object markNode reads instead of a
 * chain of `if (node.type === ...)` branches, imported directly below
 * instead of retyped here. That import is the actual fix for a defect a
 * prior round of review found: this file used to keep its own hand-typed
 * copy of what markNode did (PYTHON_MODEL), and removing format_specifier's
 * real handling from the service left that copy untouched and this test
 * still green -- 15 of 15 passing, including the one whose name claimed to
 * account for the hardcoded walk. A model built apart from the code it
 * checks can only ever agree with its own memory of that code, not with
 * what the code actually does now. Importing PYTHON_CONFIG closes that
 * gap: the set this file checks against and the set markNode actually
 * reads from are the same object, so a change to one is necessarily a
 * change to the other. PYTHON_CONFIG's own contentTypes only lists
 * string_content/escape_sequence -- string_start/string_end are a third
 * bucket, delimiterTypes, that none of the other six grammars need (see
 * that file's own doc comment) -- so they are unioned into `contentTypes`
 * here purely for this file's own accounting, which only needs to know
 * a type is spoken for, not which of markNode's three outcomes it gets.
 */
const PYTHON_MODEL: GrammarConfig = {
  literalTypes: PYTHON_CONFIG.literalTypes,
  contentTypes: new Set([...PYTHON_CONFIG.contentTypes, ...PYTHON_CONFIG.delimiterTypes]),
};
const PYTHON_EXCLUSIONS = new Set(["interpolation", "format_expression"]);
const PYTHON_CODE_TYPES = new Set([
  "aliased_import", "argument_list", "as_pattern", "assert_statement", "assignment", "attribute",
  "augmented_assignment", "await", "binary_operator", "block", "boolean_operator", "break_statement", "call",
  "case_clause", "case_pattern", "chevron", "class_definition", "class_pattern", "comparison_operator",
  "complex_pattern", "concatenated_string", "conditional_expression", "constrained_type", "continue_statement",
  "decorated_definition", "decorator", "default_parameter", "delete_statement", "dict_pattern", "dictionary",
  "dictionary_comprehension", "dictionary_splat", "dictionary_splat_pattern", "dotted_name", "elif_clause",
  "ellipsis", "else_clause", "escape_interpolation", "except_clause", "exec_statement", "expression_list",
  "expression_statement", "false", "finally_clause", "float", "for_in_clause", "for_statement",
  "function_definition", "future_import_statement", "generator_expression", "generic_type", "global_statement",
  "identifier", "if_clause", "if_statement", "import_from_statement", "import_prefix", "import_statement",
  "integer", "keyword_argument", "keyword_pattern", "keyword_separator", "lambda", "lambda_parameters",
  "line_continuation", "list", "list_comprehension", "list_pattern", "list_splat", "list_splat_pattern",
  "match_statement", "member_type", "module", "named_expression", "none", "nonlocal_statement", "not_operator",
  "pair", "parameters", "parenthesized_expression", "parenthesized_list_splat", "pass_statement", "pattern_list",
  "positional_separator", "print_statement", "raise_statement", "relative_import", "return_statement", "set",
  "set_comprehension", "slice", "splat_pattern", "splat_type", "subscript", "true", "try_statement", "tuple",
  "tuple_pattern", "type", "type_alias_statement", "type_conversion", "type_parameter", "typed_default_parameter",
  "typed_parameter", "unary_operator", "union_pattern", "union_type", "while_statement", "wildcard_import",
  "with_clause", "with_item", "with_statement", "yield",
]);

function loadNodeTypes(packageName: string, subpath: string): readonly NodeTypeEntry[] {
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve(`${packageName}/package.json`);
  const path = join(dirname(packageJsonPath), subpath);
  return JSON.parse(readFileSync(path, "utf8")) as NodeTypeEntry[];
}

/**
 * Every named, concrete type in `nodeTypes` -- excludes both anonymous
 * entries (an unnamed token sharing a type string with a named node, see
 * NodeTypeEntry's own doc) and supertype aliases (an entry with its own
 * `subtypes` list, never itself a real node's `.type`).
 */
function concreteNamedTypes(nodeTypes: readonly NodeTypeEntry[]): ReadonlySet<string> {
  const types = new Set<string>();
  for (const entry of nodeTypes) {
    if (entry.named !== true) continue;
    if (entry.subtypes !== undefined) continue;
    types.add(entry.type);
  }
  return types;
}

/**
 * Every concrete named type `nodeTypes` says this grammar can produce
 * that is not accounted for by `config`'s literalTypes/contentTypes,
 * `exclusions`, or `codeTypes`. Empty means all four together cover
 * everything this grammar can actually produce; a non-empty result names
 * exactly what to go add somewhere -- see this file's own header for what
 * each of the four buckets means and why a flat check across all of them,
 * not a reachability walk from any of them, is what actually closes this
 * defect class.
 */
function findUnclassifiedTypes(
  nodeTypes: readonly NodeTypeEntry[],
  config: GrammarConfig,
  exclusions: ReadonlySet<string>,
  codeTypes: ReadonlySet<string>,
): string[] {
  const known = new Set([...config.literalTypes, ...config.contentTypes, ...exclusions, ...codeTypes]);
  const missing = [...concreteNamedTypes(nodeTypes)].filter((t) => !known.has(t));
  return missing.sort();
}

for (const [ext, spec] of Object.entries(GRAMMAR_SPECS) as Array<[string, GrammarSpec]>) {
  test(`${ext}: src/tree-sitter-grammars.ts's config accounts for every named type ${spec.packageName}'s own node-types.json says it can produce`, () => {
    const nodeTypes = loadNodeTypes(spec.packageName, NODE_TYPES_SUBPATH[ext]);
    const missing = findUnclassifiedTypes(nodeTypes, spec.config, EXCLUSIONS[ext], CODE_TYPES[ext]);
    assert.deepEqual(
      missing,
      [],
      `${ext}: ${spec.packageName}'s node-types.json can produce ${JSON.stringify(missing)}, and none of them is in ` +
        "this grammar's literalTypes, contentTypes, or this file's own EXCLUSIONS or CODE_TYPES. Add each one to " +
        "whichever bucket is actually correct for it: literalTypes/contentTypes if it can hold static text that " +
        "must be masked, EXCLUSIONS if it is real code deliberately left for the walk to reopen, or CODE_TYPES if " +
        "it is ordinary code with nothing to do with a literal at all.",
    );
  });
}

test(".py: src/tree-sitter-python-service.ts's real PYTHON_CONFIG accounts for every named type tree-sitter-python's own node-types.json says it can produce", () => {
  const nodeTypes = loadNodeTypes("tree-sitter-python", NODE_TYPES_SUBPATH[".py"]);
  const missing = findUnclassifiedTypes(nodeTypes, PYTHON_MODEL, PYTHON_EXCLUSIONS, PYTHON_CODE_TYPES);
  assert.deepEqual(
    missing,
    [],
    `.py: tree-sitter-python's node-types.json can produce ${JSON.stringify(missing)}, unaccounted for in the real ` +
      "PYTHON_CONFIG imported from src/tree-sitter-python-service.ts, or in this file's own PYTHON_EXCLUSIONS or " +
      "PYTHON_CODE_TYPES. If markNode needs to change to handle it, that change to PYTHON_CONFIG is what this test " +
      "reads -- there is no separate copy left to fall out of sync.",
  );
});

// Finding 2, reproduced directly: the reviewer proved this file's old
// PYTHON_MODEL was a hand-typed copy of markNode's behaviour, not a check
// against markNode itself, by removing format_specifier's real handling
// from the service and watching PYTHON_MODEL -- untouched -- keep this
// test green. Now that PYTHON_MODEL is built from the real, imported
// PYTHON_CONFIG, the same removal has to fail here, because there is only
// one object left to remove it from.
test("removing format_specifier from the real PYTHON_CONFIG.literalTypes is caught (Finding 2, red before green)", () => {
  const nodeTypes = loadNodeTypes("tree-sitter-python", NODE_TYPES_SUBPATH[".py"]);
  assert.ok(PYTHON_CONFIG.literalTypes.has("format_specifier"), "sanity check: the real service must actually handle format_specifier");
  const brokenConfig: GrammarConfig = {
    literalTypes: new Set([...PYTHON_CONFIG.literalTypes].filter((t) => t !== "format_specifier")),
    contentTypes: new Set([...PYTHON_CONFIG.contentTypes, ...PYTHON_CONFIG.delimiterTypes]),
  };
  const missing = findUnclassifiedTypes(nodeTypes, brokenConfig, PYTHON_EXCLUSIONS, PYTHON_CODE_TYPES);
  assert.ok(
    missing.includes("format_specifier"),
    "removing format_specifier's real handling must be caught, the same defect the old hand-typed PYTHON_MODEL let through silently",
  );
});

// --- proof this file's own method can fail, not just pass ------------------

// Finding 3b, reproduced directly: delimited_symbol (Ruby's interpolated
// `:"..."` symbol form) dropped from ruby's config entirely -- neither
// literalTypes, contentTypes, nor EXCLUSIONS names it, the exact state the
// config was actually in before this round's fix. delimited_symbol is
// itself a concrete named type tree-sitter-ruby's own node-types.json
// produces, so the flat check above must report it, unprompted by any
// reachability from something else. This is red-before-green for the fix
// in src/tree-sitter-grammars.ts: this exact assertion, run against the
// pre-fix config, is what proves the omission before it was corrected.
test("findUnclassifiedTypes reports delimited_symbol when it is missing from ruby's config (Finding 3b, red before green)", () => {
  const rubySpec = GRAMMAR_SPECS[".rb"];
  const nodeTypes = loadNodeTypes(rubySpec.packageName, NODE_TYPES_SUBPATH[".rb"]);
  const brokenConfig: GrammarConfig = {
    literalTypes: new Set([...rubySpec.config.literalTypes].filter((t) => t !== "delimited_symbol")),
    contentTypes: rubySpec.config.contentTypes,
  };
  const missing = findUnclassifiedTypes(nodeTypes, brokenConfig, EXCLUSIONS[".rb"], CODE_TYPES[".rb"]);
  assert.ok(missing.includes("delimited_symbol"), "a dropped literal-container type is reported, not silently accepted");
});

// The regression the old, reachability-based version of this file could
// never catch: a root type, never a listed child of anything else in its
// own grammar, dropped from literalTypes. The reviewer proved this failed
// silently for all six of this project's GRAMMAR_SPECS languages, using
// each one's own top-level comment type -- and the same blind spot applies
// to Python's bespoke model, which is why it is proven here too, for all
// seven. Removing any of these seven types must make the check above
// report it; if it doesn't, this file has regressed back to reachability.
const ROOT_LITERAL_TYPE: Readonly<Record<string, string>> = {
  ".rs": "line_comment",
  ".rb": "comment",
  ".php": "comment",
  ".go": "comment",
  ".java": "line_comment",
  ".cs": "comment",
  ".py": "comment",
};

// --- correctness, not just completeness -------------------------------

// The completeness check above proves every named type lands in *some*
// bucket. It cannot prove a type landed in the *right* bucket: CODE_TYPES
// and literalTypes are both just sets of strings to it, so a literal
// misfiled into CODE_TYPES -- exactly what happened to Ruby's `subshell`,
// in the same commit that fixed nine other instances of this bug class --
// passes it just as cleanly as a correctly classified type would. Nothing
// above reads a single type's own children.types; it only reads whether
// the type's name is present somewhere.
//
// The signal that was sitting in the data the whole time: a literal
// container's own node-types.json entry lists named children that are
// plain content or an interpolation, and nothing else structural. Ruby's
// `subshell` has exactly the same three named children as `string`,
// `regex`, and `delimited_symbol` -- escape_sequence, interpolation,
// string_content -- because tree-sitter-ruby gives all four literal forms
// that identical structure. A type in CODE_TYPES whose own children include one
// of these content-or-interpolation markers is, structurally, the same
// kind of node as a literal this file already knows how to recognise; it
// just was not classified as one.
//
// This check is deliberately narrower than "any named child that could
// plausibly be text": PHP's own interpolation forms are named
// `expression`, `variable_name`, `member_access_expression`,
// `subscript_expression`, and `dynamic_variable_name` -- and `expression`
// in particular is also the ordinary operand of dozens of ordinary
// statements (`return_statement`, `echo_statement`, `break_statement`, and
// more all have exactly one child, `expression`, and nothing else). Using
// PHP's own EXCLUSIONS as markers here would flag every one of those as a
// false "literal in disguise" the moment it has any child at all, since
// their entire children list would trivially satisfy "includes a marker".
// So the marker set below is each grammar's own contentTypes (the
// actually unambiguous "this is plain text, not an expression" child
// types) plus, only where the grammar gives the concept an unambiguous
// name never reused for an ordinary code operand, its interpolation node
// type: Ruby's, C#'s, and Java's `interpolation`/`string_interpolation`,
// and Python's `interpolation`/`format_expression`. PHP and Go get no such
// addition -- PHP because its interpolation forms are not unambiguous
// (see above), Go because it has no interpolation concept at all.
const CONTENT_SHAPED_MARKERS: Readonly<Record<string, ReadonlySet<string>>> = {
  ".rs": new Set(["string_content", "escape_sequence"]),
  ".rb": new Set(["string_content", "escape_sequence", "heredoc_content", "heredoc_end", "interpolation"]),
  ".php": new Set(["string_content", "escape_sequence", "nowdoc_string", "heredoc_start", "heredoc_end", "text", "php_tag", "php_end_tag"]),
  ".go": new Set(["interpreted_string_literal_content", "raw_string_literal_content", "escape_sequence"]),
  ".java": new Set(["string_fragment", "multiline_string_fragment", "escape_sequence", "string_interpolation"]),
  ".cs": new Set([
    "string_literal_content", "string_content", "character_literal_content", "raw_string_start",
    "raw_string_content", "raw_string_end", "string_literal_encoding", "interpolation_start",
    "interpolation_quote", "escape_sequence", "interpolation",
  ]),
};

/**
 * Every CODE_TYPES entry (or, for Python, PYTHON_CODE_TYPES entry) that
 * `nodeTypes` says has at least one named child in `markers`, excluding
 * any name in `deliberateExceptions` -- a type considered and kept in
 * CODE_TYPES on purpose, not one nobody looked at. See this file's own
 * header comment above for what counts as a marker and why the set is
 * narrower than "any child that could be text".
 */
function findMisclassifiedCodeTypes(
  nodeTypes: readonly NodeTypeEntry[],
  codeTypes: ReadonlySet<string>,
  markers: ReadonlySet<string>,
  deliberateExceptions: ReadonlySet<string>,
): string[] {
  const flagged: string[] = [];
  for (const entry of nodeTypes) {
    if (entry.named !== true) continue;
    if (entry.subtypes !== undefined) continue;
    if (!codeTypes.has(entry.type)) continue;
    if (deliberateExceptions.has(entry.type)) continue;
    const childTypes = (entry.children?.types ?? []).map((c) => c.type);
    if (childTypes.some((t) => markers.has(t))) flagged.push(entry.type);
  }
  return flagged.sort();
}

/**
 * Deliberate exceptions to the correctness check, per grammar: a
 * CODE_TYPES entry the check above would otherwise flag, kept in
 * CODE_TYPES anyway because it is actually ordinary code and not a
 * literal in disguise, with the reason recorded here instead of the
 * check being silenced or its markers narrowed further. Empty for a
 * grammar means the check finds nothing to except.
 */
const CORRECTNESS_EXCEPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  ".rs": new Set(),
  ".rb": new Set(),
  // program, PHP's own root node, is the one type this check flags that
  // is not a literal in disguise: per tree-sitter-php's own node-types.json,
  // `program`'s children can be `php_tag`, `statement`, or a bare `text`
  // node directly -- so "some child is a content marker" is trivially true
  // of the root of every PHP file that has any HTML in it at all, the same
  // way it would be true of any container that legitimately mixes code and
  // text as siblings instead of being a text container itself. The actual
  // bug this pointed at was real, though: that bare `text` child (Finding
  // 3, leading HTML before the first `<?php` tag, or a template-only file
  // with none at all) was never masked, because nothing in literalTypes
  // matched it and `program` itself is not a literal container to recurse
  // out of. The fix is `text` itself joining php's literalTypes in
  // src/tree-sitter-grammars.ts, not relabelling `program`, which stays
  // ordinary code -- masking `program` itself would blank an entire file's
  // real statements along with its HTML.
  ".php": new Set(["program"]),
  ".go": new Set(),
  ".java": new Set(),
  ".cs": new Set(),
};
const PYTHON_CORRECTNESS_EXCEPTIONS = new Set<string>();

for (const [ext, spec] of Object.entries(GRAMMAR_SPECS) as Array<[string, GrammarSpec]>) {
  test(`${ext}: no CODE_TYPES entry in this file has a child that marks it as a literal (correctness, not just completeness)`, () => {
    const nodeTypes = loadNodeTypes(spec.packageName, NODE_TYPES_SUBPATH[ext]);
    const flagged = findMisclassifiedCodeTypes(nodeTypes, CODE_TYPES[ext], CONTENT_SHAPED_MARKERS[ext], CORRECTNESS_EXCEPTIONS[ext]);
    assert.deepEqual(
      flagged,
      [],
      `${ext}: CODE_TYPES contains ${JSON.stringify(flagged)}, each with a named child that marks a literal container ` +
        "(a content type or an unambiguous interpolation type). Move each one to literalTypes, or add it to this " +
        "file's own CORRECTNESS_EXCEPTIONS with a reason if it is actually ordinary code.",
    );
  });
}

test(".py: no PYTHON_CODE_TYPES entry has a child that marks it as a literal (correctness, not just completeness)", () => {
  const nodeTypes = loadNodeTypes("tree-sitter-python", NODE_TYPES_SUBPATH[".py"]);
  const pythonMarkers = new Set(["string_content", "escape_sequence", "interpolation", "format_expression"]);
  const flagged = findMisclassifiedCodeTypes(nodeTypes, PYTHON_CODE_TYPES, pythonMarkers, PYTHON_CORRECTNESS_EXCEPTIONS);
  assert.deepEqual(flagged, [], `.py: PYTHON_CODE_TYPES contains ${JSON.stringify(flagged)}, each looking like a literal in disguise.`);
});

// Finding 1, reproduced directly: subshell (Ruby's backtick and %x{}
// shell-command literal) has the identical child structure as `string`,
// `regex`, and `delimited_symbol` -- escape_sequence, interpolation,
// string_content -- per tree-sitter-ruby's own node-types.json. It sat in
// CODE_TYPES, not literalTypes, and the completeness check above passed
// anyway: CODE_TYPES is still just a set of names to that check, and
// subshell's name was in it. Verified live before the fix: `` cmd =
// `echo DANGEROUS_SECRET_TOKEN` `` masked to itself, unchanged. This is
// red-before-green for the correctness check itself: run against
// CODE_TYPES as it stood with subshell still in it, findMisclassifiedCodeTypes
// must report subshell, unprompted, the same way the completeness check's
// own delimited_symbol proof works above.
test("findMisclassifiedCodeTypes reports subshell when it is left in ruby's CODE_TYPES (Finding 1, red before green)", () => {
  const rubySpec = GRAMMAR_SPECS[".rb"];
  const nodeTypes = loadNodeTypes(rubySpec.packageName, NODE_TYPES_SUBPATH[".rb"]);
  const brokenCodeTypes = new Set([...CODE_TYPES[".rb"], "subshell"]);
  const flagged = findMisclassifiedCodeTypes(nodeTypes, brokenCodeTypes, CONTENT_SHAPED_MARKERS[".rb"], CORRECTNESS_EXCEPTIONS[".rb"]);
  assert.ok(flagged.includes("subshell"), "a literal misfiled into CODE_TYPES is reported, not silently accepted");
});

for (const [ext, rootType] of Object.entries(ROOT_LITERAL_TYPE)) {
  test(`removing the root literal type ${JSON.stringify(rootType)} from ${ext}'s config is caught (proof for all seven languages, including the case that passed silently before)`, () => {
    const isPython = ext === ".py";
    const spec = isPython ? undefined : GRAMMAR_SPECS[ext];
    const packageName = isPython ? "tree-sitter-python" : (spec as GrammarSpec).packageName;
    const baseConfig = isPython ? PYTHON_MODEL : (spec as GrammarSpec).config;
    const exclusions = isPython ? PYTHON_EXCLUSIONS : EXCLUSIONS[ext];
    const codeTypes = isPython ? PYTHON_CODE_TYPES : CODE_TYPES[ext];

    assert.ok(baseConfig.literalTypes.has(rootType), `sanity check: ${ext}'s config must actually list ${rootType}`);

    const nodeTypes = loadNodeTypes(packageName, NODE_TYPES_SUBPATH[ext]);
    // Sanity check on the property under test, before removing anything:
    // node-types.json never actually lists this type as a named child of
    // any other entry, which is exactly why the old reachability-based
    // walk could never have found it no matter what it was seeded with.
    const listedAsAChildAnywhere = nodeTypes.some((entry) => (entry.children?.types ?? []).some((c) => c.type === rootType));
    assert.equal(listedAsAChildAnywhere, false, `${ext}: ${rootType} is expected to be unreachable as a child in node-types.json`);

    const brokenConfig: GrammarConfig = {
      literalTypes: new Set([...baseConfig.literalTypes].filter((t) => t !== rootType)),
      contentTypes: baseConfig.contentTypes,
    };
    const missing = findUnclassifiedTypes(nodeTypes, brokenConfig, exclusions, codeTypes);
    assert.ok(
      missing.includes(rootType),
      `${ext}: removing ${rootType} from literalTypes must be caught, the same as any other dropped type -- ` +
        "this is exactly the check that silently passed before this round's fix",
    );
  });
}
