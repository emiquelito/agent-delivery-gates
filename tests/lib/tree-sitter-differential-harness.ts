// Shared harness for every tree-sitter-vs-regex differential test added
// after Python's (tests/tree-sitter-python-differential.test.ts, which
// predates this file and is left as its own bespoke test: it already
// exists, already passes, and touching it risks nothing gained). Every
// language added in this phase -- Rust, Ruby, PHP, Go, Java, C# -- uses
// this instead of writing its own copy of the same test scaffolding: a
// language's corpus is a plain array of cases, built with `blank`, and
// this file is the only place that knows how to run one.
//
// Rule expected-value-derived-apart.json: every expected value a case
// below carries is built with `blank`, from reading the language's own
// grammar (what a raw string's own delimiters are, what a heredoc's tag
// looks like, which named node is an interpolation and which is plain
// text), never by calling codeMask/maskNonCode and copying back what came
// out. See each language's own test file for that per-construct reasoning.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { LanguageService } from "../../src/code-mask.ts";

/**
 * Every character of `text` replaced with a space, except a newline, which
 * stays a newline. This is what maskNonCode actually blanks a literal span
 * to (see src/code-mask.ts's own maskNonCode): a newline is kept verbatim
 * even inside a multi-line string or comment, so a whole-file caller's line
 * numbers stay aligned with the raw text's own. Before that fix, a
 * newline inside a masked span was blanked to a space like everything
 * else, which is what every `blank`/`blankNth` call below used to
 * reproduce; a multi-line fixture's expected value must reproduce the
 * fixed behaviour instead.
 */
function blankedForm(text: string): string {
  return text.replace(/[^\n]/g, " ");
}

/**
 * Blanks a known substring of `source` to spaces, one newline in the
 * substring kept as a newline, failing loudly if that substring is not
 * found exactly once. The same helper
 * tests/tree-sitter-python-differential.test.ts defines for itself, lifted
 * here so every language's corpus can share it: counting spaces out by
 * hand is exactly the transcription mistake this sidesteps, since the
 * blanked form always comes from the substring's own text, not from
 * someone recounting characters in a fixture.
 */
export function blank(source: string, substring: string): string {
  const at = source.indexOf(substring);
  assert.notEqual(at, -1, `expected to find ${JSON.stringify(substring)} in the fixture`);
  assert.equal(source.indexOf(substring, at + 1), -1, `${JSON.stringify(substring)} must appear exactly once`);
  return source.slice(0, at) + blankedForm(substring) + source.slice(at + substring.length);
}

/**
 * The same approach as `blank` above, for the case `blank` itself refuses:
 * a substring that is expected to appear more than once, where the case
 * actually needs one particular occurrence blanked and not the others --
 * a heredoc or nowdoc's opening tag repeated verbatim as its closing tag,
 * most commonly, where only the opening one sits inside the construct a
 * case is reasoning about. `occurrence` is 0-based; still fails loudly,
 * instead of silently blanking nothing, if fewer occurrences exist than
 * asked for.
 */
export function blankNth(source: string, substring: string, occurrence: number): string {
  let at = -1;
  for (let i = 0; i <= occurrence; i++) {
    at = source.indexOf(substring, at + 1);
    assert.notEqual(at, -1, `expected at least ${occurrence + 1} occurrence(s) of ${JSON.stringify(substring)}`);
  }
  return source.slice(0, at) + blankedForm(substring) + source.slice(at + substring.length);
}

/**
 * A case where the regex scanner and the tree-sitter service disagree on
 * `maskNonCode(text)`, and the reasoning for each side's answer lives in
 * the case's own comment at its call site, the same way
 * tests/tree-sitter-python-differential.test.ts records it inline. Both
 * `regexExpected` and `treeExpected` are built with `blank`, independently
 * of each other and of the scanners themselves.
 */
export interface DisagreementCase {
  readonly kind: "disagree";
  readonly name: string;
  readonly text: string;
  readonly regexExpected: string;
  readonly treeExpected: string;
}

/**
 * A case where both scanners agree on which characters are code and
 * which are not -- compared through `codeMask`, not `maskNonCode`. The
 * six grammars added in this phase do not preserve a string's own quote
 * punctuation as a visible, un-blanked delimiter the way
 * src/tree-sitter-python-service.ts and the regex scanner both do (see
 * src/tree-sitter-language-service.ts's file header): an ordinary quoted
 * string's quotes are themselves blanked here, where the regex scanner
 * leaves them visible. That makes `maskNonCode` output disagree even on
 * a plain string with nothing tricky in it, which is a cosmetic
 * difference in what a masked line looks like, not a difference in what
 * either scanner treats as code -- `codeMask`'s boolean answer, which is
 * what `adg mutate` actually reads to decide where a mutation may land,
 * agrees. This case kind checks that agreement directly, so the choice
 * not to preserve delimiters here does not read as an accidental gap in
 * the corpus.
 */
export interface AgreementCase {
  readonly kind: "agree";
  readonly name: string;
  readonly text: string;
}

export type DifferentialCase = DisagreementCase | AgreementCase;

/**
 * Runs one language's corpus: loads its tree-sitter service once with
 * `loadService`, then checks every case against it and against
 * `regexService` (src/code-mask.ts's `regexLanguageService`, the same
 * scanner every file got before this phase and still gets for every
 * extension not in this project's tree-sitter registry).
 */
export function runDifferentialCorpus(
  languageName: string,
  loadService: () => Promise<LanguageService>,
  regexService: LanguageService,
  cases: readonly DifferentialCase[],
): void {
  let service: LanguageService;
  test.before(async () => {
    service = await loadService();
  });

  for (const c of cases) {
    if (c.kind === "disagree") {
      test(`${languageName}: ${c.name}`, () => {
        assert.equal(regexService.maskNonCode(c.text), c.regexExpected, "regex scanner's own reading");
        assert.equal(service.maskNonCode(c.text), c.treeExpected, "tree-sitter's own reading");
        assert.notEqual(
          regexService.maskNonCode(c.text),
          service.maskNonCode(c.text),
          "this case is recorded as a disagreement, so the two readings must actually differ",
        );
      });
    } else {
      test(`${languageName}: ${c.name}`, () => {
        assert.deepEqual(
          regexService.codeMask(c.text),
          service.codeMask(c.text),
          "both scanners must agree on which characters are code",
        );
      });
    }
  }
}
