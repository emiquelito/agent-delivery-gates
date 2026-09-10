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
 * Marks `node`'s span in `kinds`. Everything starts CODE (see `classify`),
 * so this only ever narrows: a `comment` or a `string` node's whole span
 * becomes LITERAL, a string's own quote punctuation becomes DELIMITER, and
 * an interpolation inside a string is reopened to CODE and walked again,
 * because it can itself contain another string, another comment is not
 * legal there but another interpolation is, and so on.
 */
function markNode(node: TSNode, kinds: Uint8Array): void {
  if (node.type === "comment") {
    fill(kinds, node.startIndex, node.endIndex, LITERAL);
    return;
  }
  if (node.type === "string") {
    fill(kinds, node.startIndex, node.endIndex, LITERAL);
    for (const child of node.children) {
      if (!child) continue;
      if (child.type === "interpolation") {
        fill(kinds, child.startIndex, child.endIndex, CODE);
        markNode(child, kinds);
      } else if (child.type === "string_start" || child.type === "string_end") {
        fill(kinds, child.startIndex, child.endIndex, DELIMITER);
      }
      // Any other child (string_content, escape_sequence) stays LITERAL,
      // from the whole-span fill above: there is nothing to recurse into.
    }
    return;
  }
  if (node.type === "format_specifier") {
    // An f-string replacement field's `:...` suffix, e.g. the `>` fill
    // character and width digits in `f"{x:>10}"`, or `.2f` in `f"{x:.2f}"`.
    // Most of that suffix is static text tree-sitter-python does not
    // break out into its own child node at all -- it is just part of
    // format_specifier's own span -- so leaving format_specifier
    // unhandled here left it CODE by the same default this file's own
    // generic recursion gives everything, and a fake format spec like
    // `f"{x:DANGEROUS}"` read straight through the mask. The one part of
    // a format specifier that is real code is a nested replacement field
    // inside it, `{width}` in `f"{x:>{width}}"`, tree-sitter's own
    // `format_expression`, which stays reopened the same way a string's
    // own `interpolation` child does.
    fill(kinds, node.startIndex, node.endIndex, LITERAL);
    for (const child of node.children) {
      if (!child) continue;
      if (child.type === "format_expression") {
        fill(kinds, child.startIndex, child.endIndex, CODE);
        markNode(child, kinds);
      }
      // The `:` itself and any other child stay LITERAL from the
      // whole-span fill above.
    }
    return;
  }
  for (const child of node.children) {
    if (child) markNode(child, kinds);
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
  markNode(tree.rootNode, kinds);
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
