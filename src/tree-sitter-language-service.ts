// A generic tree-sitter-backed LanguageService, shared by every grammar
// added after Python: Rust, Ruby, PHP, Go, Java, and C#. Python's own
// service (src/tree-sitter-python-service.ts) predates this file and is
// left exactly as it is -- it already works, and every one of the 1199
// tests this project had before this phase pins some part of its
// behaviour, for no gain from folding it in here. What this file adds is
// the walk that six more grammars turned out to share: blank a comment or
// a string node wholesale, and reopen as code whichever of its own named
// children actually holds a nested expression instead of plain text.
//
// What "reopen" means, concretely: a string's own quote punctuation is
// always an anonymous token (tree-sitter gives it no grammar rule name),
// so it is never touched here and stays part of the wholesale blank.
// Among a string node's *named* children, most are plain text with a
// grammar-rule name anyway (Python calls it string_content, Go calls it
// interpreted_string_literal_content, and so on) -- GrammarConfig's
// contentTypes lists exactly those, per language, so they stay blanked
// too. A named child that is not in that list is real code sitting
// inside a literal -- an interpolation's expression, most commonly -- and
// gets its span reopened to CODE and walked again with this same
// function, which is what lets a string nested one level inside an
// interpolation (Python's f"{d['key']}"`, Ruby's `"#{d['key']}"`, PHP's
// `"{$d['key']}"`) get masked correctly too: the inner string node is
// still in literalTypes, so recursing into it blanks it again from
// scratch.
//
// A round of review found this file once carried a second layer for PHP
// specifically: PHP's `text` node (raw HTML outside `<?php ?>`) has no
// child structure of its own, so an inline <script>/<style> element sitting
// inside it had no node to reopen the way a real interpolation does, and a
// scan (fillHtmlAwareLiteral) tried to carve that content back out by
// pattern-matching <script>/<style> tags inside one `text` node's own
// span. Two defects followed directly from scanning one node at a time:
// tree-sitter-php splits a single <script>...</script> element into two
// separate `text` nodes whenever a `<?php ... ?>` span sits between its
// open and close tags, so neither half's scan ever saw both tags and the
// assertion in between vanished; and a fake `</script>` inside the
// script's own JavaScript string closed the scan early, blanking the real
// assertion that followed. Both hid an assertion that plain HTML masking
// had never hidden before -- exactly the outcome this project exists to
// prevent. Fixing that scan correctly needs cross-node state (tracking
// whether a script/style element is still open as the walk moves from one
// `text` node to the next in document order) with any ambiguity resolved
// toward leaving content visible, which is real complexity bought for
// keeping *incidental* HTML masked. Simpler, and argued for directly: PHP's
// `text` node no longer has any special handling here at all, and
// src/tree-sitter-grammars.ts's php entry no longer lists `text` in either
// literalTypes or contentTypes, so raw HTML in a `.php` file -- leading,
// trailing, template-only, or holding a real inline <script>/<style> block
// -- stays visible under this walk's ordinary default the same way it did
// for years before that work started. The trade a static HTML page might
// now read as a false "still code" signal a human can see and dismiss;
// nothing about it can ever read as a false "nothing here", which hiding
// an assertion would.

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Parser, Language, type Node as TSNode } from "web-tree-sitter";
import type { LanguageService } from "./code-mask.ts";

/** Inside a string or a comment. */
const LITERAL = 0;
/** Ordinary code. */
const CODE = 1;

function fill(kinds: Uint8Array, start: number, end: number, value: number): void {
  for (let i = start; i < end; i++) kinds[i] = value;
}

/**
 * One grammar's answer to "what counts as not-code". `literalTypes` names
 * every node type that is a whole comment or a whole string/heredoc/nowdoc
 * container, blanked wholesale the moment one is found. `contentTypes`
 * names the named child node types, found *inside* one of those
 * containers, that are themselves still plain text -- an escape sequence,
 * a heredoc's own start/end tag, a run of literal characters -- so they
 * stay blanked instead of being mistaken for a nested construct and
 * reopened as code. Anything named that is in neither set, found inside a
 * literal container, is assumed to be real code (an interpolation, most
 * often) and is reopened and walked again.
 */
export interface GrammarConfig {
  literalTypes: ReadonlySet<string>;
  contentTypes: ReadonlySet<string>;
}

/**
 * Marks `node`'s span in `kinds`. See the file header for what "reopen"
 * means; this is the same kind of walk as
 * src/tree-sitter-python-service.ts's markNode, generalised from one
 * hardcoded pair of node types ("comment", "string") to a per-language
 * `GrammarConfig`.
 */
function markNode(node: TSNode, kinds: Uint8Array, config: GrammarConfig): void {
  if (config.literalTypes.has(node.type)) {
    fill(kinds, node.startIndex, node.endIndex, LITERAL);
    for (const child of node.children) {
      if (!child) continue;
      if (!child.isNamed) continue; // anonymous punctuation: stays blanked
      if (config.contentTypes.has(child.type)) continue; // plain text: stays blanked
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
 * everywhere, for the same reason src/tree-sitter-python-service.ts does:
 * a parse tree covers every character with some node, so it is markNode's
 * job to say which spans are not code, not to say which are.
 */
function classify(parser: Parser, text: string, config: GrammarConfig): Uint8Array {
  const kinds = new Uint8Array(text.length).fill(CODE);
  if (text.length === 0) return kinds;
  const tree = parser.parse(text);
  if (!tree) {
    kinds.fill(LITERAL);
    return kinds;
  }
  markNode(tree.rootNode, kinds, config);
  return kinds;
}

function makeService(parser: Parser, config: GrammarConfig): LanguageService {
  return {
    codeMask(text: string): boolean[] {
      const kinds = classify(parser, text, config);
      const mask = new Array<boolean>(text.length);
      for (let i = 0; i < text.length; i++) mask[i] = kinds[i] === CODE;
      return mask;
    },
    maskNonCode(text: string): string {
      const kinds = classify(parser, text, config);
      let out = "";
      for (let i = 0; i < text.length; i++) out += kinds[i] === LITERAL ? " " : text[i];
      return out;
    },
  };
}

/** The on-disk path of a grammar package's plain wasm file, resolved
 * through the package's own package.json instead of a hardcoded relative
 * path, the same way src/tree-sitter-python-service.ts resolves
 * tree-sitter-python's. */
function resolveWasmPath(packageName: string, wasmFileName: string): string {
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve(`${packageName}/package.json`);
  return join(dirname(packageJsonPath), wasmFileName);
}

/**
 * Builds one language's LanguageService: initialises web-tree-sitter's
 * WASM runtime (safe to call more than once per process; web-tree-sitter
 * memoizes its own module load), loads `packageName`'s `wasmFileName`
 * grammar, and returns a service bound to one parser instance reused for
 * every call. Called at most once per language per process, from
 * src/code-mask.ts's registry, and only once a file of that language has
 * actually been seen.
 */
export async function loadTreeSitterLanguageService(
  packageName: string,
  wasmFileName: string,
  config: GrammarConfig,
): Promise<LanguageService> {
  await Parser.init();
  const language = await Language.load(resolveWasmPath(packageName, wasmFileName));
  const parser = new Parser();
  parser.setLanguage(language);
  return makeService(parser, config);
}
