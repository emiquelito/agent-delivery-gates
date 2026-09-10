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
// PHP's `text` node (raw HTML outside a `<?php ... ?>` span) does NOT get
// this treatment, on purpose, after three rounds tried to give it some
// version of one and each round made things worse in a different
// direction. That history, and why it stops here, is worth recording in
// full so a fourth round does not have to rediscover it the hard way --
// and worth being exact about what "does NOT get this treatment" actually
// costs, which an earlier version of this account got wrong.
//
// `text` masking is really two independent effects sharing one node-type
// name: `text` as a bare child of `program` (leading HTML, trailing HTML,
// a template-only file with no `<?php` tag at all), and `text` as
// text_interpolation's own child (HTML sitting BETWEEN two `<?php ... ?>`
// spans -- PHP's most common templating form). Only the first of those
// is something this episode's rounds invented and then walked back. The
// second predates this episode by years: PHP's grammar config already
// listed `text` in contentTypes, alongside php_tag/php_end_tag, before
// Round 1 below ever ran, specifically so text_interpolation's own `text`
// child stayed masked. Round 1 folded both effects into one config change
// (moving `text` into literalTypes, so the bare-under-`program` form got
// covered too) without separating them, and every round since has treated
// `text` as one on/off switch instead of two. The practical upshot,
// understated by every prior version of this history: the current state
// does not merely leave leading/trailing/template-only HTML unmasked, as
// most of the account below focuses on -- it also stops masking HTML
// between two PHP spans, a years-old behaviour this episode did not set
// out to touch and ends up removing anyway, because both effects are
// controlled by the same `text` entry. That removal is deliberate, not
// collateral: see the second bullet below for why, and
// src/tree-sitter-grammars.ts's php entry for where this is recorded next
// to the actual config.
//
//   - Round 1 masked `text` wholesale, plus a per-node scan
//     (fillHtmlAwareLiteral, long since removed) that pattern-matched
//     <script>/<style> tags inside one `text` node's own span to carve
//     that content back out as code. Two defects followed directly from
//     scanning one node at a time: tree-sitter-php splits a single
//     <script>...</script> element into two separate `text` nodes
//     whenever a `<?php ... ?>` span sits between its open and close
//     tags, so neither half's scan ever saw both tags and an assertion
//     sitting between them vanished outright; and a fake `</script>`
//     inside the script's own JavaScript string closed the scan early,
//     blanking the real assertion that followed it. Both hid an
//     assertion that plain HTML masking had never hidden before -- the
//     one outcome this project exists to prevent.
//   - Round 2 reacted by pulling `text` out of masking entirely -- Route
//     B. That traded the hidden-assertion defect for a different real
//     cost: an ordinary documentation line sitting in template HTML,
//     quoting an assertion's own call form as prose, now read as live
//     code, and editing only its literal value tripped this project's own
//     gate at HIGH severity on a one-character edit.
//   - Round 3 went back to masking `text`, this time threading a shared
//     scan state across sibling `text` spans in document order so a
//     script element split by a PHP tag would be read as one continuous
//     element, and resolving an ambiguous close toward the LAST candidate
//     tag instead of the first. That fixed both defects Round 1 shipped
//     with -- checked against a committed fixture corpus, whole files at a
//     time. It still shipped broken, because of something neither Round 1
//     nor Round 3 checked: how this function is actually called.
//
// THE ROOT CAUSE. Every real call site (src/test-diff-separator.ts's
// `matching` and its handful of siblings) calls maskNonCode with ONE DIFF
// LINE AT A TIME, not a whole file -- that is what a unified diff hands a
// gate. classify() creates a fresh scan state on every call, so any
// cross-line state Round 3 built never survives from one line to the
// next; it worked only in that round's own corpus tests, which fed whole
// fixture files in, which is not how the gate is ever invoked in
// practice. Fed one line at a time instead, Round 3's fix regressed to
// worse than Round 1: an ordinary multi-line `<script>` block has its
// opening tag on its own line, so the line carrying the real assertion
// carries no tag of its own, reads with nothing open, and masks away
// silently -- CRITICAL, a hidden assertion, verified end to end through
// this same function. And Round 2's cost was never actually gone either:
// a one-line documentation string containing a matched <script>...
// </script> pair on a single line still read as code, reproducing the
// Route B false positive in a narrower window. A multi-line version of
// that same false positive happened not to reproduce, but only because
// the hidden-assertion defect above was quietly suppressing it -- two
// bugs cancelling by accident, not a fix.
//
// So: per line, both directions are unsafe. Masking `text` risks hiding
// an assertion inside an ordinary multi-line script block (CRITICAL,
// since the line that carries the assertion has no tag on it to signal
// "still open"). Not masking it risks a documentation line producing a
// commit-blocking false signal (HIGH). Neither failure is a scanner bug a
// cleverer scan can fix, because the scanner is never given enough text
// to be right -- the state a correct answer needs (was a <script> tag
// opened on some earlier line this call never sees?) does not exist at
// the call site. This is blocked on the gate reading whole files at the
// commit instead of individual diff hunks, a larger, separate change to
// the hook every existing user runs, already planned as its own phase of
// this project.
//
// UPDATE: that phase has shipped. src/test-diff-separator.ts's
// `readWholeFile` option (see its own doc comment, and the KNOWN LIMIT
// note this replaces in src/code-mask.ts's header) reads the file at the
// commit and masks it once, so the per-line blindness this section's own
// root-cause account describes is gone for a caller that supplies it --
// every production caller now does. That closes the blocker, but does NOT
// by itself make masking `text` safe again: reopening that question needs
// its own evidence against the corpus that broke three earlier rounds
// (tests/tree-sitter-php-script-style.test.ts), run with the whole-file
// mask actually in place, not an assumption that the earlier failures
// were only ever about line boundaries. `text` stays out of literalTypes
// and contentTypes below until that evidence exists; this update records
// that the blocker naming this file as the reason is lifted, nothing more.
//
// Given that, `text` is deliberately left out of both literalTypes and
// contentTypes below (Route B, same as Round 2): a false "still code"
// signal is visible in a diff and a person can dismiss it; a hidden
// assertion is neither visible nor dismissible. This is a wider change
// than Round 2 alone made, for the reason given further up: it also
// stops masking HTML between two PHP spans, the years-old, pre-episode
// behaviour that lived in contentTypes before Round 1 ever touched this
// file, because that effect shares the same `text` node-type name with
// the bare-under-`program` effect these rounds were actually chasing. See
// src/tree-sitter-grammars.ts's php entry for where `text` is (and is
// not) listed, and tests/tree-sitter-php-script-style.test.ts and
// tests/test-diff-separator.test.ts for the known-limitation tests that
// pin this file's actual behaviour instead of an aspiration for it.

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
      // A newline is kept verbatim even inside a literal span, so a
      // multi-line string or comment never merges two lines into one in
      // the masked output; see src/code-mask.ts's own maskNonCode for why
      // this matters to a whole-file caller.
      for (let i = 0; i < text.length; i++) out += kinds[i] === LITERAL && text[i] !== "\n" ? " " : text[i];
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
