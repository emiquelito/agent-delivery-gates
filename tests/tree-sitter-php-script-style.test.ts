// A prior round (Finding 5) put PHP's `text` node in literalTypes so
// leading and template-only HTML would be masked, then added a scan
// (fillHtmlAwareLiteral) to carve an inline <script>/<style> element's own
// content back out as visible code, since tree-sitter-php gives `text` no
// child structure of its own for that content to be reopened through the
// way a real interpolation is. A later round of review found that scan
// hid a real assertion in two ways, both reproduced here first as failing
// (red) proof, then as regression tests against the fix:
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
// The fix (see src/tree-sitter-language-service.ts's own file header, and
// src/tree-sitter-grammars.ts's php entry) is not a smarter scan: `text` is
// pulled back out of literalTypes and contentTypes entirely, so it is never
// masked at all, by any means. This file's tests below now all pass
// trivially -- there is no scan left to fool -- which is the point: masking
// PHP's `text` node can no longer hide an assertion, because it no longer
// hides anything.

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

test("leading and template-only HTML now stays visible, the accepted trade-off of dropping the text scan entirely", async () => {
  const service = await servicePromise;
  const text = ["<!DOCTYPE html>", "<html><body>", "LEADING_HTML_TEXT", "</body></html>", "<?php echo 1; ?>", ""].join("\n");
  const masked = service.maskNonCode(text);
  assert.ok(
    masked.includes("LEADING_HTML_TEXT"),
    `expected leading HTML to stay visible now that PHP's text node is never masked, got: ${JSON.stringify(masked)}`,
  );
});
