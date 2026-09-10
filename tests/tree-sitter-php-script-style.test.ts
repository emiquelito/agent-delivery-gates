// Finding 5: adding PHP's `text` to literalTypes (see src/tree-sitter-grammars.ts's
// php entry) correctly masks leading and template-only HTML, but
// tree-sitter-php gives that same `text` node no further structure --
// everything outside a `<?php ?>` span is one undifferentiated leaf, script
// and style content included. Masking `text` wholesale therefore blanks a
// real assertion sitting inside an inline `<script>` block along with the
// surrounding HTML, and assertionWeakenedSignals in
// src/test-diff-separator.ts can no longer see it.
//
// This file proves the detector can still see such an assertion after the
// fix, and separately proves a `<script>` tag written inside a PHP string
// (a different node entirely, already masked on its own) cannot fool the
// scan that keeps real script/style content visible.

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTreeSitterLanguageService } from "../src/tree-sitter-language-service.ts";
import { GRAMMAR_SPECS } from "../src/tree-sitter-grammars.ts";

const spec = GRAMMAR_SPECS[".php"];
const servicePromise = loadTreeSitterLanguageService(spec.packageName, spec.wasmFileName, spec.config);

test("a template-only PHP file with an inline <script> keeps the assertion inside it visible after masking", async () => {
  const service = await servicePromise;
  const text = [
    "<!DOCTYPE html>",
    "<html><body>",
    "<script>",
    "  assert.strictEqual(result, expected);",
    "</script>",
    "</body></html>",
    "",
  ].join("\n");
  const masked = service.maskNonCode(text);
  assert.ok(
    masked.includes("assert.strictEqual(result, expected);"),
    `expected the inline <script> assertion to stay visible after masking, got: ${JSON.stringify(masked)}`,
  );
  // The surrounding HTML is still masked: this is not "give up and leave
  // the whole file visible", it is "keep script/style content visible
  // while the HTML around it stays blanked".
  assert.ok(!masked.includes("DOCTYPE"), `expected the surrounding HTML to stay masked, got: ${JSON.stringify(masked)}`);
  assert.ok(!masked.includes("<html>"), `expected the surrounding HTML to stay masked, got: ${JSON.stringify(masked)}`);
});

test("an inline <style> block's content stays visible too, the same as <script>'s", async () => {
  const service = await servicePromise;
  const text = ["<html><head>", "<style>", "  .secret-class { color: DANGEROUS_TOKEN; }", "</style>", "</head></html>", ""].join(
    "\n",
  );
  const masked = service.maskNonCode(text);
  assert.ok(
    masked.includes("DANGEROUS_TOKEN"),
    `expected inline <style> content to stay visible after masking, got: ${JSON.stringify(masked)}`,
  );
});

test("a <script> tag written inside a PHP string cannot fool the scan into treating unrelated HTML as script content", async () => {
  const service = await servicePromise;
  // The <script>...</script> text below lives entirely inside a PHP
  // double-quoted string -- its own node, already masked wholesale on its
  // own terms -- never inside the bare `text` node the fix's script/style
  // scan actually looks at. A scan that ran over the whole raw file
  // instead of one isolated `text` node's own substring could be fooled by
  // this into either leaving the string's content visible, or by using it
  // to mis-pair with a real closing tag elsewhere in the file. Neither
  // happens here because the scan never sees text belonging to a different
  // node at all.
  const text = [
    "<?php",
    '$x = "<script>NOT_REAL_JS_SHOULD_STAY_MASKED</script>";',
    "?>",
    "<script>",
    "  assert.strictEqual(real, code);",
    "</script>",
    "",
  ].join("\n");
  const masked = service.maskNonCode(text);
  assert.ok(
    !masked.includes("NOT_REAL_JS_SHOULD_STAY_MASKED"),
    `expected the PHP string's own <script> text to stay masked, got: ${JSON.stringify(masked)}`,
  );
  assert.ok(
    masked.includes("assert.strictEqual(real, code);"),
    `expected the real inline <script> block's assertion to stay visible, got: ${JSON.stringify(masked)}`,
  );
});

test("mixed content: HTML on both sides of a php tag still masks correctly with a real <script> block present", async () => {
  const service = await servicePromise;
  const text = ["<html>", "<script>assert.ok(SIGNAL_HERE);</script>", "<?php echo 1; ?>", "</html>", ""].join("\n");
  const masked = service.maskNonCode(text);
  assert.ok(masked.includes("assert.ok(SIGNAL_HERE)"), `expected the script content to stay visible, got: ${JSON.stringify(masked)}`);
  assert.ok(!masked.includes("<html>"), `expected surrounding HTML to stay masked, got: ${JSON.stringify(masked)}`);
});
