// A prior round (Finding 5) put PHP's `text` node in literalTypes so
// leading and template-only HTML would be masked, then added a scan
// (fillHtmlAwareLiteral, since removed) to carve an inline <script>/<style>
// element's own content back out as visible code, since tree-sitter-php
// gives `text` no child structure of its own for that content to be
// reopened through the way a real interpolation is. A later round of
// review found that scan hid a real assertion in two ways:
//
//   - Finding 1 (CRITICAL): tree-sitter-php splits one physical
//     <script>...</script> element into two separate `text` nodes
//     whenever a `<?php ... ?>` span sits between its open and close tags.
//     A scan running per node, over one node's own span at a time, never
//     sees both tags in the same call: the node holding the opening tag
//     has no closing tag in its span to reopen on, and the node holding
//     the assertion and the closing tag has no opening tag in its span to
//     anchor on either. The assertion vanishes.
//   - Finding 1b: the scan closed on the first `</script>`/`</style>` it
//     found, even one sitting inside the script's own JavaScript string.
//     That is not harmless: everything after the fake close reverts to
//     being treated as HTML and gets blanked, including a real assertion
//     and the real closing tag that follow it.
//
// That round reacted by pulling `text` out of literalTypes and contentTypes
// entirely, so nothing about it was ever masked, by any means. The round
// after found the actual cost of that: an ordinary documentation line
// sitting in template HTML, quoting an assertion's own call form as prose,
// now read as live code, and editing only its literal value tripped this
// project's own gate at HIGH severity -- an exit-1 block on a documentation
// edit, not the cosmetic "a human can see and dismiss it" cost it had been
// described as (see tests/test-diff-separator.test.ts's own reviewer-finding
// test for the reproduction at the gate level).
//
// This round fixes the scan's two real defects instead of abandoning it:
// `text` is masked again (src/tree-sitter-grammars.ts's php entry lists it
// in the new `htmlTypes` bucket), with a script/style carve-out that tracks
// state across sibling `text` spans in document order -- fixing Finding 1 --
// and resolves an ambiguous close toward the LAST candidate in the current
// span instead of the first -- fixing Finding 1b. See
// src/tree-sitter-language-service.ts's own file header for the full
// account. Findings 1 and 1b below are unchanged as regression proof: they
// still pass, now because the fix actually handles them, not because there
// is nothing left to fool.

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTreeSitterLanguageService } from "../src/tree-sitter-language-service.ts";
import { GRAMMAR_SPECS } from "../src/tree-sitter-grammars.ts";

const spec = GRAMMAR_SPECS[".php"];
const servicePromise = loadTreeSitterLanguageService(spec.packageName, spec.wasmFileName, spec.config);

test("Finding 1: a <script> element split by a `<?php ... ?>` span no longer hides the assertion after it", async () => {
  const service = await servicePromise;
  const text = [
    "<html>",
    "<script>",
    "  var config = <?php echo json_encode($config); ?>;",
    "  assert.strictEqual(config.mode, 'prod');",
    "</script>",
    "",
  ].join("\n");
  const masked = service.maskNonCode(text);
  assert.ok(
    masked.includes("assert.strictEqual(config.mode, 'prod')"),
    `expected the assertion after the php tag to stay visible, got: ${JSON.stringify(masked)}`,
  );
});

test("Finding 1, short echo form: `<?= ... ?>` splits the script the same way and must not hide the assertion either", async () => {
  const service = await servicePromise;
  const text = [
    "<html>",
    "<script>",
    "  var config = <?= json_encode($config) ?>;",
    "  assert.strictEqual(config.mode, 'prod');",
    "</script>",
    "",
  ].join("\n");
  const masked = service.maskNonCode(text);
  assert.ok(
    masked.includes("assert.strictEqual(config.mode, 'prod')"),
    `expected the assertion after the short echo tag to stay visible, got: ${JSON.stringify(masked)}`,
  );
});

test("Finding 1b: a fake `</script>` inside the script's own JavaScript string no longer hides the real assertion that follows it", async () => {
  const service = await servicePromise;
  const text = ["<script>", "var s = '<script>nested</script>';", "assert.ok(x);", "</script>", ""].join("\n");
  const masked = service.maskNonCode(text);
  assert.ok(masked.includes("assert.ok(x)"), `expected the real assertion to stay visible, got: ${JSON.stringify(masked)}`);
});

test("an escaped `<\\/script>` inside the script's own string, the standard way to write it, does not hide the real assertion either", async () => {
  const service = await servicePromise;
  const text = ["<script>", 'document.write("<\\/script>");', "assert.ok(y);", "</script>", ""].join("\n");
  const masked = service.maskNonCode(text);
  assert.ok(masked.includes("assert.ok(y)"), `expected the real assertion to stay visible, got: ${JSON.stringify(masked)}`);
});

test("a <script> tag written inside a PHP string still masks as an ordinary PHP string, independent of any text handling", async () => {
  const service = await servicePromise;
  const text = ["<?php", '$x = "<script>NOT_REAL_JS_SHOULD_STAY_MASKED</script>";', "?>", ""].join("\n");
  const masked = service.maskNonCode(text);
  assert.ok(
    !masked.includes("NOT_REAL_JS_SHOULD_STAY_MASKED"),
    `expected the PHP string's own content to stay masked, got: ${JSON.stringify(masked)}`,
  );
});

test("leading and template-only HTML masks again, now that the scan tracks script/style content instead of being dropped entirely", async () => {
  const service = await servicePromise;
  const text = ["<!DOCTYPE html>", "<html><body>", "LEADING_HTML_TEXT", "</body></html>", "<?php echo 1; ?>", ""].join("\n");
  const masked = service.maskNonCode(text);
  assert.ok(
    !masked.includes("LEADING_HTML_TEXT"),
    `expected leading HTML to mask again, got: ${JSON.stringify(masked)}`,
  );
  assert.ok(masked.includes("echo 1;"), `expected the real PHP code to stay visible, got: ${JSON.stringify(masked)}`);
});

// Finding 3 (LOW): no test anywhere asserted that <style> content
// specifically -- not just <script> -- stays visible, restoring the
// coverage this file's own scanHtmlSpan carve-out needs for both element
// kinds, not only the one every other test here happens to exercise.
test("Finding 3: a <style> element's own content stays visible, the same carve-out <script> gets", async () => {
  const service = await servicePromise;
  const text = ["<html>", "<style>", "  .ok { color: red; } /* assert STYLE_MARKER visible */", "</style>", ""].join("\n");
  const masked = service.maskNonCode(text);
  assert.ok(
    masked.includes(".ok { color: red; } /* assert STYLE_MARKER visible */"),
    `expected style content to stay visible, got: ${JSON.stringify(masked)}`,
  );
});

test("Finding 3, split by a `<?php ... ?>` span: a <style> element also tracks state across sibling text spans", async () => {
  const service = await servicePromise;
  const text = [
    "<html>",
    "<style>",
    "  .box { width: <?php echo $w; ?>px; }",
    "  /* assert STYLE_AFTER_SPLIT_VISIBLE */",
    "</style>",
    "",
  ].join("\n");
  const masked = service.maskNonCode(text);
  assert.ok(
    masked.includes("assert STYLE_AFTER_SPLIT_VISIBLE"),
    `expected style content after the php tag to stay visible, got: ${JSON.stringify(masked)}`,
  );
});

// The reviewer's own reproduction, at this file's level: a plain
// documentation line, with no <script>/<style> tag anywhere in it, must
// mask entirely now that `text` is masked as HTML by default again. See
// tests/test-diff-separator.test.ts for the same finding reproduced through
// the actual gate.
test("an ordinary documentation line mentioning an assertion's call form, with no script/style tag in it, masks like any other HTML text", async () => {
  const service = await servicePromise;
  const text = "Usage: assert.strictEqual(response.code, 200); matches the API docs.";
  const masked = service.maskNonCode(text);
  assert.equal(masked, " ".repeat(text.length), `expected the whole line to mask, got: ${JSON.stringify(masked)}`);
});
