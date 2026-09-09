// Tests for src/code-mask.ts: which characters of a line are code, and what
// a line looks like once everything that is not code has been blanked out.
// Two tools read this one scanner, `adg mutate` to decide where a mutation
// may be applied and `adg test-diff` to decide where a weakening signal may
// be read, so a change here moves both and both are pinned below.

import { test } from "node:test";
import assert from "node:assert/strict";
import { codeMask, maskNonCode } from "../src/code-mask.ts";

// --- codeMask, moved here with src/mutate.ts's scanner -----------------------

test("codeMask marks string and comment characters as not code", () => {
  const text = "a + 'b + c' // d + e";
  const mask = codeMask(text);
  assert.equal(mask[2], true, "the first plus is code");
  assert.equal(mask[7], false, "the plus inside the string is not code");
  assert.equal(mask[16], false, "the plus inside the comment is not code");
});

test("codeMask counts a literal's own quotes as not code", () => {
  const mask = codeMask('f("x")');
  assert.equal(mask[1], true, "the opening paren is code");
  assert.equal(mask[2], false, "the opening quote is not code");
  assert.equal(mask[4], false, "the closing quote is not code");
  assert.equal(mask[5], true, "the closing paren is code");
});

test("codeMask marks a template literal and its interpolation as not code", () => {
  const text = "const t = `a ${b + c} d`;";
  const mask = codeMask(text);
  assert.equal(mask[8], true, "the assignment is code");
  assert.equal(mask[17], false, "the plus inside the interpolation is not code");
});

test("codeMask marks a regular expression literal as not code", () => {
  const text = "if (re.test(x) && /a + b/.test(y)) f();";
  const mask = codeMask(text);
  assert.equal(mask[15], true, "the connective is code");
  assert.equal(mask[21], false, "the plus inside the regex is not code");
});

// --- maskNonCode -------------------------------------------------------------

test("maskNonCode keeps the length and the columns of the original", () => {
  const line = '  assert.equal(x, "a long string");';
  assert.equal(maskNonCode(line).length, line.length);
});

test("maskNonCode blanks a string body and keeps its quotes", () => {
  assert.equal(maskNonCode('f("skip me")'), 'f("       ")');
  assert.equal(maskNonCode("f('skip me')"), "f('       ')");
});

test("maskNonCode blanks a template body and a regex body", () => {
  assert.equal(maskNonCode("f(`skip me`)"), "f(`       `)");
  assert.equal(maskNonCode("f(/skip me/)"), "f(/       /)");
});

test("maskNonCode blanks a trailing line comment and a block comment", () => {
  assert.equal(maskNonCode("f(x); // skip this"), "f(x);             ");
  assert.equal(maskNonCode("f(/* skip */ x);"), "f(           x);");
});

test("maskNonCode leaves ordinary code alone", () => {
  const line = "  assert.equal(shipping(two), 0);";
  assert.equal(maskNonCode(line), line);
});

test("maskNonCode leaves a Rust attribute alone: it is code, not a string", () => {
  assert.equal(maskNonCode("    #[ignore]"), "    #[ignore]");
  assert.equal(maskNonCode("#[cfg(test)]"), "#[cfg(test)]");
  assert.equal(maskNonCode("    assert_eq!(total, 3);"), "    assert_eq!(total, 3);");
});

test("maskNonCode blanks the body of a ${...} expression inside a template", () => {
  // Pinned as it is, not as it might be: a template literal is skipped
  // whole, interpolation and all, so a detector word written inside an
  // interpolated expression is blanked along with the template's text.
  // That direction loses a signal and invents none.
  assert.equal(maskNonCode("f(`a ${it.skip(1)} b`)"), "f(`                 `)");
});

test("maskNonCode cannot see a string that opened on an earlier line", () => {
  // The known limit, pinned so the bound is recorded and not merely
  // described. In its real file this line sits in the middle of a template
  // literal, so every character of it is string. Scanned on its own it
  // carries no opening backtick, so it reads as code, ".skip" stands, and
  // the signal fires anyway. The fixture marker is the answer for a file
  // where this is common.
  const middle = '  it.skip("x");';
  assert.equal(maskNonCode(middle), '  it.skip(" ");');
});

test("an unterminated quote blanks the rest of its own line and no more", () => {
  // A double quote with no partner still blanks to the line end. The single
  // quote case moved: a lone tick is code to maskNonCode now, because a Rust
  // lifetime carries one and reading it as a string hid the markers after it.
  assert.equal(maskNonCode('f("unclosed'), 'f("        ');
  assert.equal(maskNonCode("a\nb"), "a\nb");
});

test("codeMask keeps the cautious reading of a lone tick, and maskNonCode does not", () => {
  // codeMask decides what may be mutated, so a candidate invented inside a
  // string would produce text that does not compile. It stays cautious.
  const line = "let s: &'static str = f(); a + b";
  const mask = codeMask(line);
  const tick = line.indexOf("'");
  assert.equal(mask[tick + 1], false, "codeMask stopped treating a lone tick as a literal");
  assert.match(maskNonCode(line), /a \+ b/, "maskNonCode lost the code after a lone tick");
});

// A Rust lifetime is a tick with no partner. Read as a string opener it
// swallows the rest of the line, so a marker after it stops being visible to
// the checks that read Rust source. Found by masking a real Rust line and
// watching assert! disappear.
test("a tick with no partner on the line is code, not the start of a literal", () => {
  const line = `let s: &'static str = "x"; assert!(ok);`;
  const masked = maskNonCode(line);
  assert.match(masked, /assert!\(ok\)/, "a lifetime swallowed the rest of the line");
  assert.match(masked, /&\s?static str/, "the lifetime itself was not left as code");
});

test("a tick that does have a partner still opens a literal", () => {
  const cases: Array<[string, RegExp]> = [
    [`const s = 'a string with assert!(x) inside';`, /^const s = ' +';$/],
    [`let c = 'a'; assert!(ok);`, /assert!\(ok\)/],
    [`let n = '\\n'; assert!(ok);`, /assert!\(ok\)/],
  ];
  for (const [line, expected] of cases) {
    assert.match(maskNonCode(line), expected, `wrong masking for ${line}`);
  }
});

test("a literal's own quotes survive, because the rules match on them", () => {
  // DEFAULT_RULES carries fragments such as \bit\s+["'] and \bskip\s+["'].
  // Blanking the quote itself would stop those matching at all.
  assert.match(maskNonCode(`it 'adds numbers' do`), /it ' +' do/);
  assert.match(maskNonCode(`  skip "not ready"`), /skip " +"/);
});
