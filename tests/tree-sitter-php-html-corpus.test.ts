// A committed corpus of PHP/HTML fixtures, and the comparison a prior
// round's "95 fixtures, 12 categories, 0 regressions, 35 improvements"
// claim never left in the repository (Finding 4 of the round that added
// src/tree-sitter-grammars.ts's php `htmlTypes` carve-out). That claim
// could not be checked by anyone who did not already trust it: the corpus
// it was generated from, and the comparison run over it, were both
// ephemeral. This file is the real version -- a fixed, readable corpus
// (below) and a comparison (further down) that actually runs as part of
// `npm test`, so a future reviewer can rerun it, extend it, and see
// exactly what it found.
//
// The corpus is 20 fixtures across the categories this project's PHP/HTML
// masking history has actually turned up a defect or an edge case in:
// leading HTML, trailing HTML, a template-only file, a script or style
// block on its own, one split by a `<?php ... ?>` or `<?= ... ?>` span
// (Finding 1), one closed early by a fake tag inside its own string
// (Finding 1b) or safely past one written the standard escaped way, a
// `<script>` tag sitting inside a real PHP string (must never be read as
// HTML), an HTML comment wrapping a fake tag (a known, accepted miss),
// several script/style blocks and tag-attribute/case variations in one
// file, and text_interpolation's own form (HTML between two PHP spans,
// not only the bare-under-`program` form leading/trailing HTML use) -- the
// two node positions Requirement 4 of this round names explicitly.
//
// Two things run over this corpus:
//
//   1. A per-fixture invariant check: every marker in `mustStayVisible`
//      must appear, verbatim, in the real service's maskNonCode output.
//      This is the absolute invariant this round's masking exists to hold
//      -- a real assertion, or text standing in for one, must never be
//      hidden -- checked directly against the actual GRAMMAR_SPECS[".php"]
//      config, the same one src/code-mask.ts loads at runtime.
//   2. A symmetric, whole-corpus regression comparison against a frozen
//      reconstruction of the buggy per-node scan this project actually
//      shipped in commit a1cba26 (see that test's own comment for why that
//      baseline, not the currently shipped one, is the informative
//      comparison). Unlike the one-directional check the round that
//      reverted a1cba26 used -- which only ever watched for a character
//      that read as code turning into a character that reads as masked --
//      this reports BOTH directions: newly hidden (must be empty, the
//      safety property) and newly visible (must land on exactly the
//      Finding 1/1b fixtures, checked by name, not just assumed zero
//      everywhere the way a one-directional check effectively would).
//
// See src/tree-sitter-language-service.ts's own file header and
// src/tree-sitter-grammars.ts's php entry for the fix this corpus checks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Parser, Language, type Node as TSNode } from "web-tree-sitter";
import { loadTreeSitterLanguageService, type GrammarConfig } from "../src/tree-sitter-language-service.ts";
import { GRAMMAR_SPECS } from "../src/tree-sitter-grammars.ts";

interface Fixture {
  name: string;
  text: string;
  /** Substrings that must appear, verbatim and unmasked, in the real service's output. */
  mustStayVisible: string[];
  /** Substrings that must NOT appear, verbatim, in the real service's output: plain HTML that must mask. */
  mustStayMasked?: string[];
}

const FIXTURES: Fixture[] = [
  {
    name: "leading HTML with a documentation line naming an assertion's call form",
    text: ["<!DOCTYPE html>", "<html><body>", "Usage: assert.strictEqual(response.code, 200); matches the API docs.", "</body></html>", "<?php echo 1; ?>", ""].join("\n"),
    mustStayVisible: [],
    mustStayMasked: ["Usage: assert.strictEqual(response.code, 200); matches the API docs."],
  },
  {
    name: "trailing HTML after the last PHP tag",
    text: ["<?php", "echo 1;", "?>", "<p>TRAILING_HTML_DOC_TEXT assert.ok(1)</p>", ""].join("\n"),
    mustStayVisible: [],
    mustStayMasked: ["TRAILING_HTML_DOC_TEXT assert.ok(1)"],
  },
  {
    name: "a template-only file with no PHP tag at all",
    text: "just a static page, no PHP anywhere, assert.ok(should_not_matter)\n",
    mustStayVisible: [],
    mustStayMasked: ["assert.ok(should_not_matter)"],
  },
  {
    name: "a <script> block with a real assertion and no PHP tag inside it",
    text: ["<html>", "<script>", "assert.strictEqual(CORPUS_SCRIPT_PLAIN, 1);", "</script>", ""].join("\n"),
    mustStayVisible: ["assert.strictEqual(CORPUS_SCRIPT_PLAIN, 1);"],
  },
  {
    name: "a <style> block with a marker and no PHP tag inside it",
    text: ["<html>", "<style>", "/* assert CORPUS_STYLE_PLAIN visible */", "</style>", ""].join("\n"),
    mustStayVisible: ["/* assert CORPUS_STYLE_PLAIN visible */"],
  },
  {
    name: "Finding 1: a <script> element split by a `<?php ... ?>` span",
    text: ["<script>", "  var c = <?php echo $c; ?>;", "  assert.strictEqual(CORPUS_SCRIPT_SPLIT, 1);", "</script>", ""].join("\n"),
    mustStayVisible: ["assert.strictEqual(CORPUS_SCRIPT_SPLIT, 1);"],
  },
  {
    name: "Finding 1, style variant: a <style> element split by a `<?php ... ?>` span",
    text: ["<style>", "  .c { width: <?php echo $w; ?>px; }", "  /* assert CORPUS_STYLE_SPLIT visible */", "</style>", ""].join("\n"),
    mustStayVisible: ["/* assert CORPUS_STYLE_SPLIT visible */"],
  },
  {
    name: "Finding 1, short echo form: a <script> element split by `<?= ... ?>`",
    text: ["<script>", "  var c = <?= $c ?>;", "  assert.strictEqual(CORPUS_SCRIPT_SHORT_ECHO_SPLIT, 1);", "</script>", ""].join("\n"),
    mustStayVisible: ["assert.strictEqual(CORPUS_SCRIPT_SHORT_ECHO_SPLIT, 1);"],
  },
  {
    name: "a <script> element split into THREE text nodes by two PHP spans",
    text: [
      "<script>",
      "  var a = <?php echo $a; ?>;",
      "  var b = <?php echo $b; ?>;",
      "  assert.strictEqual(CORPUS_SCRIPT_TRIPLE_SPLIT, 1);",
      "</script>",
      "",
    ].join("\n"),
    mustStayVisible: ["assert.strictEqual(CORPUS_SCRIPT_TRIPLE_SPLIT, 1);"],
  },
  {
    name: "Finding 1b: a fake `</script>` inside the script's own JavaScript string",
    text: ["<script>", "var s = '<script>nested</script>';", "assert.strictEqual(CORPUS_SCRIPT_FAKE_CLOSE, 1);", "</script>", ""].join("\n"),
    mustStayVisible: ["assert.strictEqual(CORPUS_SCRIPT_FAKE_CLOSE, 1);"],
  },
  {
    name: "Finding 1b, style variant: a fake `</style>` inside the style block's own content",
    text: ["<style>", "/* pretend: </style> */", "/* assert CORPUS_STYLE_FAKE_CLOSE visible */", "</style>", ""].join("\n"),
    mustStayVisible: ["/* assert CORPUS_STYLE_FAKE_CLOSE visible */"],
  },
  {
    name: "an escaped `<\\/script>`, the standard way to write it, inside the script's own string",
    text: ["<script>", 'document.write("<\\/script>");', "assert.strictEqual(CORPUS_SCRIPT_ESCAPED_CLOSE, 1);", "</script>", ""].join("\n"),
    mustStayVisible: ["assert.strictEqual(CORPUS_SCRIPT_ESCAPED_CLOSE, 1);"],
  },
  {
    name: "a <script> tag written inside a real PHP string must never be read as HTML",
    text: ["<?php", '$x = "<script>CORPUS_PHP_STRING_SCRIPT_TAG_MUST_STAY_MASKED</script>";', "?>", ""].join("\n"),
    mustStayVisible: [],
    mustStayMasked: ["CORPUS_PHP_STRING_SCRIPT_TAG_MUST_STAY_MASKED"],
  },
  {
    name: "an HTML comment wrapping a fake <script> tag: a known, accepted miss (reopens as code, never hides anything)",
    text: ["<html>", "<!-- <script>CORPUS_COMMENTED_FAKE_SCRIPT</script> -->", "<p>trailing doc text, unrelated</p>", ""].join("\n"),
    // Not asserted as a mustStayVisible marker: this is the documented miss
    // (reads as code when it should stay masked HTML), not a hidden-assertion
    // risk. Recorded here only so the corpus comparison below accounts for it.
    mustStayVisible: [],
  },
  {
    name: "two separate <script> blocks in one text span",
    text: ["<html>", "<script>assert.strictEqual(CORPUS_SCRIPT_FIRST, 1);</script>", "<script>assert.strictEqual(CORPUS_SCRIPT_SECOND, 2);</script>", ""].join("\n"),
    mustStayVisible: ["assert.strictEqual(CORPUS_SCRIPT_FIRST, 1);", "assert.strictEqual(CORPUS_SCRIPT_SECOND, 2);"],
  },
  {
    name: "a <script> tag with attributes",
    text: ["<html>", '<script type="text/javascript" defer>', "assert.strictEqual(CORPUS_SCRIPT_WITH_ATTRS, 1);", "</script>", ""].join("\n"),
    mustStayVisible: ["assert.strictEqual(CORPUS_SCRIPT_WITH_ATTRS, 1);"],
  },
  {
    name: "an uppercase <SCRIPT> tag",
    text: ["<html>", "<SCRIPT>", "assert.strictEqual(CORPUS_SCRIPT_UPPERCASE, 1);", "</SCRIPT>", ""].join("\n"),
    mustStayVisible: ["assert.strictEqual(CORPUS_SCRIPT_UPPERCASE, 1);"],
  },
  {
    name: "text_interpolation position: a <script> block sitting between two PHP spans, not leading/trailing",
    text: ["<?php echo 1; ?>", "<script>assert.strictEqual(CORPUS_SCRIPT_BETWEEN_PHP_SPANS, 1);</script>", "<?php echo 2; ?>", ""].join("\n"),
    mustStayVisible: ["assert.strictEqual(CORPUS_SCRIPT_BETWEEN_PHP_SPANS, 1);"],
  },
  {
    name: "text_interpolation position, split further: a <script> block between two PHP spans, itself split by a third",
    text: [
      "<?php echo 1; ?>",
      "<script>",
      "  var a = <?php echo $a; ?>;",
      "  assert.strictEqual(CORPUS_SCRIPT_BETWEEN_SPANS_ALSO_SPLIT, 1);",
      "</script>",
      "<?php echo 2; ?>",
      "",
    ].join("\n"),
    mustStayVisible: ["assert.strictEqual(CORPUS_SCRIPT_BETWEEN_SPANS_ALSO_SPLIT, 1);"],
  },
  {
    name: "ordinary trailing HTML after a script block closes cleanly",
    text: [
      "<script>assert.strictEqual(CORPUS_SCRIPT_THEN_HTML, 1);</script>",
      "<p>Usage: assert.strictEqual(response.code, 200); trailing doc text.</p>",
      "",
    ].join("\n"),
    mustStayVisible: ["assert.strictEqual(CORPUS_SCRIPT_THEN_HTML, 1);"],
  },
];

const spec = GRAMMAR_SPECS[".php"];

// The config this project shipped immediately before this round (commit
// aeb05b6): identical in every other respect, but with `text` unmasked
// entirely. The corpus-wide regression check further below compares
// against a different, more informative baseline instead: see its own
// comment for why.
const newServicePromise = loadTreeSitterLanguageService(spec.packageName, spec.wasmFileName, spec.config);

for (const fixture of FIXTURES) {
  test(`corpus: ${fixture.name}`, async () => {
    const service = await newServicePromise;
    const masked = service.maskNonCode(fixture.text);
    for (const marker of fixture.mustStayVisible) {
      assert.ok(masked.includes(marker), `expected ${JSON.stringify(marker)} to stay visible, got: ${JSON.stringify(masked)}`);
    }
    for (const marker of fixture.mustStayMasked ?? []) {
      assert.ok(!masked.includes(marker), `expected ${JSON.stringify(marker)} to stay masked, got: ${JSON.stringify(masked)}`);
    }
  });
}

// --- the symmetric regression check ---------------------------------------
//
// Comparing the new config against the currently shipped one (Route B,
// `text` unmasked entirely) is not, on its own, a useful "regression"
// signal: Route A intentionally masks a large amount of HTML that Route B
// left as code, so a plain code-to-masked count is large and positive on
// almost every fixture by design, not by mistake. What actually matters,
// and what Finding 1 of this round showed a one-directional check cannot
// see, is a comparison against a DIFFERENT prior state: the buggy per-node
// scan this project shipped in commit a1cba26, which masked `text` as HTML
// too, but carved a <script>/<style> element's own content back out by
// matching open and close tags inside ONE node's own span at a time, with
// no state carried to the next sibling `text` node, and closing on the
// FIRST candidate close tag, not the last. That scan is reproduced
// below, frozen, for comparison only -- it is not used anywhere real, and
// touching it should never make this file's own tests change meaning.
//
// Comparing the new, fixed scan against that frozen old one, over the same
// corpus, in both directions at once, is what closes the actual blind
// spot: a hidden-assertion regression (content the old scan correctly
// showed as code, now masked) must still be impossible, AND a fix (content
// the old scan wrongly hid, now correctly visible) must show up exactly
// where this round's own fixtures for Finding 1 and Finding 1b say it
// should, not just be asserted zero everywhere the way the prior round's
// one-directional check effectively treated every position.

/** Inside a string, a comment, or (this file's own concern) masked HTML. */
const LEGACY_LITERAL = 0;
/** Ordinary code, including a carved-out script/style element's content. */
const LEGACY_CODE = 1;

function legacyFill(kinds: Uint8Array, start: number, end: number, value: number): void {
  for (let i = start; i < end; i++) kinds[i] = value;
}

// Reproduced verbatim from commit a1cba26's fillHtmlAwareLiteral: matches
// one <script>...</script> or <style>...</style> element per call, with a
// NON-GREEDY content group, so a real regex engine's own leftmost-match
// behaviour closes on the FIRST candidate close tag, not the last -- this
// is Finding 1b, reproduced structurally, not asserted by name.
const LEGACY_SCRIPT_OR_STYLE_ELEMENT_RE = /(<(?:script|style)\b[^>]*>)([\s\S]*?)(<\/(?:script|style)\s*>)/gi;

function legacyFillHtmlAwareLiteral(text: string, kinds: Uint8Array, start: number, end: number): void {
  legacyFill(kinds, start, end, LEGACY_LITERAL);
  const span = text.slice(start, end);
  LEGACY_SCRIPT_OR_STYLE_ELEMENT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LEGACY_SCRIPT_OR_STYLE_ELEMENT_RE.exec(span)) !== null) {
    const [, openTag, content] = match;
    const contentStart = start + match.index + openTag.length;
    const contentEnd = contentStart + content.length;
    legacyFill(kinds, contentStart, contentEnd, LEGACY_CODE);
  }
}

// Reproduced from a1cba26's markNode: the same walk as today's, except the
// html-aware carve-out runs PER NODE, over that node's own span alone --
// no state of any kind is threaded from one `text` node to the next, which
// is Finding 1's cross-node blindness, reproduced structurally, not
// asserted by name.
function legacyMarkNode(node: TSNode, kinds: Uint8Array, config: GrammarConfig, text: string): void {
  if (config.htmlTypes?.has(node.type)) {
    legacyFillHtmlAwareLiteral(text, kinds, node.startIndex, node.endIndex);
    return;
  }
  if (config.literalTypes.has(node.type)) {
    legacyFill(kinds, node.startIndex, node.endIndex, LEGACY_LITERAL);
    for (const child of node.children) {
      if (!child) continue;
      if (!child.isNamed) continue;
      if (config.htmlTypes?.has(child.type)) {
        legacyFillHtmlAwareLiteral(text, kinds, child.startIndex, child.endIndex);
        continue;
      }
      if (config.contentTypes.has(child.type)) continue;
      legacyFill(kinds, child.startIndex, child.endIndex, LEGACY_CODE);
      legacyMarkNode(child, kinds, config, text);
    }
    return;
  }
  for (const child of node.children) {
    if (child) legacyMarkNode(child, kinds, config, text);
  }
}

const legacyConfig: GrammarConfig = {
  literalTypes: spec.config.literalTypes,
  contentTypes: spec.config.contentTypes,
  htmlTypes: new Set(["text"]),
};

let legacyParserPromise: Promise<Parser> | undefined;
async function legacyParser(): Promise<Parser> {
  if (legacyParserPromise === undefined) {
    legacyParserPromise = (async () => {
      await Parser.init();
      const require = createRequire(import.meta.url);
      const packageJsonPath = require.resolve(`${spec.packageName}/package.json`);
      const wasmPath = join(dirname(packageJsonPath), spec.wasmFileName);
      const language = await Language.load(wasmPath);
      const parser = new Parser();
      parser.setLanguage(language);
      return parser;
    })();
  }
  return legacyParserPromise;
}

async function legacyCodeMask(text: string): Promise<boolean[]> {
  const parser = await legacyParser();
  const kinds = new Uint8Array(text.length).fill(LEGACY_CODE);
  if (text.length === 0) return [];
  const tree = parser.parse(text);
  if (!tree) return new Array<boolean>(text.length).fill(false);
  legacyMarkNode(tree.rootNode, kinds, legacyConfig, text);
  return Array.from(kinds, (k) => k === LEGACY_CODE);
}

/** One corpus-wide diff between the new scan and the frozen a1cba26-style one, for the same text. */
interface CorpusDelta {
  fixture: string;
  /** Was CODE under the old scan, now LITERAL under the new one: a real regression. Must be empty. */
  newlyHidden: number;
  /** Was LITERAL under the old scan (wrongly hidden, Findings 1/1b), now CODE under the new one: a fix. */
  newlyVisible: number;
}

test("corpus regression: symmetric comparison against the buggy per-node scan this project shipped in a1cba26", async () => {
  const newService = await newServicePromise;
  const deltas: CorpusDelta[] = [];
  for (const fixture of FIXTURES) {
    const oldMask = await legacyCodeMask(fixture.text);
    const newMask = newService.codeMask(fixture.text);
    assert.equal(oldMask.length, newMask.length, `${fixture.name}: mask length must match text length`);
    let newlyHidden = 0;
    let newlyVisible = 0;
    for (let i = 0; i < oldMask.length; i++) {
      if (oldMask[i] && !newMask[i]) newlyHidden++;
      else if (!oldMask[i] && newMask[i]) newlyVisible++;
    }
    deltas.push({ fixture: fixture.name, newlyHidden, newlyVisible });
  }

  // The safety direction: nothing the old, buggy scan already correctly
  // showed as code may read as masked under the fix.
  const regressed = deltas.filter((d) => d.newlyHidden > 0);
  assert.deepEqual(regressed, [], `a fix must never hide content the old scan already showed as code: ${JSON.stringify(regressed)}`);

  // The fix direction, reported and checked by name, not assumed: exactly
  // the fixtures built around Finding 1 (a script/style element split by a
  // PHP span) and Finding 1b (a fake close tag inside the element's own
  // string) should show newly visible content, because those are the two
  // cases the old scan is reproduced above to get wrong. Every other
  // fixture -- a script/style block the old scan never had any trouble
  // with, plain HTML, a PHP string, the documented HTML-comment miss --
  // should show zero, because there is nothing for the fix to have
  // changed there.
  const expectedFixed = new Set([
    "Finding 1: a <script> element split by a `<?php ... ?>` span",
    "Finding 1, style variant: a <style> element split by a `<?php ... ?>` span",
    "Finding 1, short echo form: a <script> element split by `<?= ... ?>`",
    "a <script> element split into THREE text nodes by two PHP spans",
    "Finding 1b: a fake `</script>` inside the script's own JavaScript string",
    "Finding 1b, style variant: a fake `</style>` inside the style block's own content",
    "text_interpolation position, split further: a <script> block between two PHP spans, itself split by a third",
    // Not a Finding 1/1b case, but still newly visible under the fix, for a
    // related reason worth naming instead of lumping it in silently: taking
    // the LAST close tag in the current open run (the fix for Finding 1b)
    // means two back-to-back <script> elements in the same span, with
    // nothing but whitespace between the first close and the second open,
    // have that whole run -- including the boundary tags themselves --
    // read as one open run instead of two. The old scan's non-greedy regex
    // told the two apart correctly; the fix trades that precision away on
    // purpose, since the alternative (closing on the first candidate) is
    // exactly the choice that hid Finding 1b's real assertion. Nothing is
    // ever hidden by this either way -- more characters than strictly
    // necessary read as code, never fewer -- so it stays on the accepted
    // side of the invariant this file exists to hold.
    "two separate <script> blocks in one text span",
  ]);
  const actuallyFixed = new Set(deltas.filter((d) => d.newlyVisible > 0).map((d) => d.fixture));
  assert.deepEqual(
    [...actuallyFixed].sort(),
    [...expectedFixed].sort(),
    `expected newly-visible content in exactly the Finding 1/1b fixtures; deltas: ${JSON.stringify(deltas, null, 2)}`,
  );
});
