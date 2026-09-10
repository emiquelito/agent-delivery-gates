// The tree-sitter-backed LanguageService for Python.
//
// web-tree-sitter and tree-sitter-python are devDependencies only: nothing
// this package ships to a user depends on them at runtime, and the README,
// the npm description, and the site all still say zero dependencies.
// That claim survives this file for one reason: every import below is a
// normal, static, top-of-file import, but this module itself is never
// imported that way. src/code-mask.ts reaches it through a dynamic
// `import()`, and only after deciding a `.py` file is actually in play (see
// `warmLanguageServices` there). A process that never touches a `.py` file
// never evaluates this file at all, so it never touches these packages
// either. A process that does touch a `.py` file but has neither package
// installed hits a rejected dynamic import, which the caller in
// code-mask.ts catches and answers by falling back to the regex scanner:
// the same scanner every file got before this one existed.
//
// What follows is a walk of tree-sitter's parse tree, not a line-by-line
// scan: every string and comment node is marked as not-code, wholesale.
// The one wrinkle is an f-string's interpolation. tree-sitter exposes
// `f"hello {name}"` as a `string` node whose children include an
// `interpolation` node wrapping a real `identifier`, not string text. A
// mask that stops recursing the moment it sees a `string` node blanks that
// identifier along with the quotes around it, which is exactly the kind of
// live code this project exists to keep mutable and readable. Recursing
// one level deeper, into the interpolation, keeps it code.
//
// The walk itself is driven by PYTHON_CONFIG below, a plain data object,
// not a chain of `if (node.type === "...")` branches: a prior round of
// review found tests/tree-sitter-node-types-conformance.test.ts checking
// its own hand-typed copy of what this file's markNode did, instead of
// checking markNode itself, and that copy went stale the moment
// format_specifier's real handling was removed here and left untouched
// there. PYTHON_CONFIG is exported and imported directly by that test now,
// so there is exactly one place that says what Python's walk classifies,
// not two that can drift apart.

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Parser, Language, type Node as TSNode } from "web-tree-sitter";
import type { LanguageService } from "./code-mask.ts";

/** Inside a string or a comment. */
const LITERAL = 0;
/** Ordinary code. */
const CODE = 1;
/** The opening or closing punctuation of a string: `"`, `'''`, the `f"`
 * prefix, and so on. Not code, but not blanked by `maskNonCode` either,
 * for the same reason src/code-mask.ts keeps a JS string's quotes visible:
 * a pattern that recognises a literal by the quote after it would lose the
 * quote along with the text if this were blanked too. */
const DELIMITER = 2;

function fill(kinds: Uint8Array, start: number, end: number, value: number): void {
  for (let i = start; i < end; i++) kinds[i] = value;
}

/**
 * Python's own answer to src/tree-sitter-grammars.ts's GrammarConfig,
 * plus one bucket the other six grammars never need: `delimiterTypes`.
 * Every other grammar here leaves a string's own quote anonymous (no
 * grammar-rule name at all), so its wholesale LITERAL fill blanks the
 * quote along with the text. tree-sitter-python instead gives the quote
 * real named node types, `string_start` and `string_end` -- an f-string's
 * own `f"` prefix is part of that span too -- so those two need a third
 * outcome, visible-but-not-code, instead of being folded into either
 * LITERAL or CODE.
 *
 * This exists, and is exported, so this file's own hardcoded classification
 * is a single data object instead of a set of `if (node.type === ...)`
 * branches scattered through markNode: tests/tree-sitter-node-types
 * -conformance.test.ts imports PYTHON_CONFIG directly instead of keeping
 * its own hand-typed copy, so a change here is a change to what that test
 * checks, not two edits that can drift apart. That is the gap a prior
 * round of review found: the test's old PYTHON_MODEL was retyped by hand
 * from what markNode did, and a change here (removing format_specifier's
 * handling) left that copy untouched and the test still green.
 */
export interface PythonGrammarConfig {
  literalTypes: ReadonlySet<string>;
  contentTypes: ReadonlySet<string>;
  delimiterTypes: ReadonlySet<string>;
}

/**
 * comment: a `#` line comment, blanked wholesale, no named children.
 *
 * string: covers every quoted form (`"..."`, `'''...'''`, `f"..."`,
 * `r"..."`, `b"..."`, and combinations), all one node type in this
 * grammar. string_content and escape_sequence, its own plain-text
 * children, stay blanked; string_start/string_end (the quote, and any
 * `f`/`r`/`b` prefix) go to DELIMITER instead, visible but not code; an
 * interpolation child (an f-string's `{expr}`) is reopened as code.
 *
 * format_specifier: an f-string replacement field's `:...` suffix, e.g.
 * the `>` fill character and width digits in `f"{x:>10}"`, or `.2f` in
 * `f"{x:.2f}"`. Most of that suffix is static text tree-sitter-python
 * does not break out into its own child node at all -- it is just part
 * of format_specifier's own span -- so leaving it unhandled left it CODE
 * by this walk's own generic-recursion default, and a fake format spec
 * like `f"{x:DANGEROUS}"` read straight through the mask. The one part of
 * a format specifier that is real code is a nested replacement field
 * inside it, `{width}` in `f"{x:>{width}}"`, tree-sitter's own
 * `format_expression`, reopened the same way a string's own
 * `interpolation` child is.
 */
export const PYTHON_CONFIG: PythonGrammarConfig = {
  literalTypes: new Set(["comment", "string", "format_specifier"]),
  contentTypes: new Set(["string_content", "escape_sequence"]),
  delimiterTypes: new Set(["string_start", "string_end"]),
};

/**
 * Marks `node`'s span in `kinds`. Everything starts CODE (see `classify`),
 * so this only ever narrows: a type in `config.literalTypes` gets its
 * whole span filled LITERAL, then each of its own named children is
 * either left LITERAL (a content type), turned DELIMITER (a delimiter
 * type), or reopened to CODE and walked again (anything else -- an
 * interpolation or a nested format expression, most often, which can
 * itself contain another string, another comment is not legal there but
 * another interpolation is, and so on). This is the same walk
 * src/tree-sitter-language-service.ts's markNode uses for the other six
 * grammars, generalised with the one extra DELIMITER outcome Python's own
 * named quote-punctuation types need and the other six do not.
 */
function markNode(node: TSNode, kinds: Uint8Array, config: PythonGrammarConfig): void {
  if (config.literalTypes.has(node.type)) {
    fill(kinds, node.startIndex, node.endIndex, LITERAL);
    for (const child of node.children) {
      if (!child) continue;
      if (!child.isNamed) continue; // anonymous punctuation: stays LITERAL
      if (config.delimiterTypes.has(child.type)) {
        fill(kinds, child.startIndex, child.endIndex, DELIMITER);
        continue;
      }
      if (config.contentTypes.has(child.type)) continue; // plain text: stays LITERAL
      fill(kinds, child.startIndex, child.endIndex, CODE);
      markNode(child, kinds, config);
    }
    return;
  }
  for (const child of node.children) {
    if (child) markNode(child, kinds, config);
  }
}

/**
 * Classifies every character of `text` from a fresh parse. Starts CODE
 * everywhere, the opposite default from the regex scanner's LITERAL-first
 * pass in src/code-mask.ts, because a parse tree covers every character of
 * the input with some node: it is markNode's job to say which spans are
 * not code, not to say which are.
 *
 * A parser that cannot produce a tree at all (never observed against the
 * corpus this file was built from, but not provable never to happen) is
 * answered the safe direction stated throughout src/code-mask.ts: nothing
 * is code, so nothing is mutated and nothing is read as a signal, rather
 * than everything being code and a candidate being invented out of text
 * that was never actually a program.
 */
function classify(parser: Parser, text: string): Uint8Array {
  const kinds = new Uint8Array(text.length).fill(CODE);
  if (text.length === 0) return kinds;
  const tree = parser.parse(text);
  if (!tree) {
    kinds.fill(LITERAL);
    return kinds;
  }
  markNode(tree.rootNode, kinds, PYTHON_CONFIG);
  return kinds;
}

function makeService(parser: Parser): LanguageService {
  return {
    codeMask(text: string): boolean[] {
      const kinds = classify(parser, text);
      const mask = new Array<boolean>(text.length);
      for (let i = 0; i < text.length; i++) mask[i] = kinds[i] === CODE;
      return mask;
    },
    maskNonCode(text: string): string {
      const kinds = classify(parser, text);
      let out = "";
      for (let i = 0; i < text.length; i++) out += kinds[i] === LITERAL ? " " : text[i];
      return out;
    },
  };
}

/** The on-disk path of tree-sitter-python's prebuilt wasm grammar, resolved
 * through the package's own package.json instead of a hardcoded relative
 * path, so this keeps working if that package ever changes its layout. */
function resolveWasmPath(): string {
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve("tree-sitter-python/package.json");
  return join(dirname(packageJsonPath), "tree-sitter-python.wasm");
}

/**
 * Builds the Python LanguageService: initialises web-tree-sitter's WASM
 * runtime, loads the tree-sitter-python grammar, and returns a service
 * bound to one parser instance reused for every call. Called at most once
 * per process, from src/code-mask.ts's `warmLanguageServices`, and only
 * once a `.py` file has actually been seen.
 */
export async function loadPythonLanguageService(): Promise<LanguageService> {
  await Parser.init();
  const language = await Language.load(resolveWasmPath());
  const parser = new Parser();
  parser.setLanguage(language);
  return makeService(parser);
}
