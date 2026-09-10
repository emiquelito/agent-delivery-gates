// A static check that every test file cleans up the temporary directories
// it creates, on the failing path as well as the passing one.
//
// A reviewer found two files with mkdtempSync calls and no cleanup at all,
// leaking 12 real directories on every clean run of this suite. The rest of
// the suite turned out to clean up, but a lot of it only did so with a bare
// rmSync call at the end of the test body -- code a thrown assertion would
// skip right over, which is the same defect in a smaller dose. Both classes
// were fixed by hand across every file in tests/. This test exists so the
// next file that adds an mkdtempSync call without matching it to one of the
// idioms that survive a throw (t.after, try/finally, .finally(), or a
// suite-level after()/afterEach() hook) fails a test instead of leaking
// quietly again.
//
// This checks presence, not a one-to-one pairing: a file that makes several
// mkdtempSync calls and cleans them all up in a single shared try/finally
// (tests/path-allowlist.test.ts does exactly this, for two directories at
// once) is not a defect, so the bar is "at least one idiom that survives a
// throw appears somewhere in the file", not "one idiom per call". That
// misses a file which protects most of its mkdtempSync calls but not all
// of them. The alternative -- matching each mkdtempSync to its own cleanup
// by position -- is exactly the kind of nearest-line heuristic this
// project's own diff-separator gate warns produces false positives on
// reindented code, and a cheap, honest presence check that can still fail
// on the case that actually happened here (a whole file with zero cleanup
// of any kind) is worth more than a precise pairing that cannot be
// trusted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));

// This file's own name, so it does not have to explain its own
// mkdtempSync-free existence to itself, and mutate-runner.test.ts's own
// name in the same spirit -- see the comment beside SUITE_LEVEL_HOOK below.
const SELF = "tmp-cleanup-hygiene.test.ts";

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

test("every test file that calls mkdtempSync also uses a cleanup idiom that survives a throw", () => {
  const files = readdirSync(TESTS_DIR).filter((name) => name.endsWith(".test.ts") && name !== SELF);
  assert.ok(files.length > 10, "expected to find the rest of the suite beside this file");

  const offenders: string[] = [];
  for (const name of files) {
    const text = readFileSync(join(TESTS_DIR, name), "utf8");
    const mkdtempCount = countOccurrences(text, "mkdtempSync(");
    if (mkdtempCount === 0) continue;

    // A suite-level after()/afterEach() hook (registered once, outside any
    // individual test, the way site.test.ts uses `before`/`after` to build
    // and remove one shared scratch directory for the whole file) also
    // counts: it runs whether or not any test in the file passed.
    const hasCleanupIdiom =
      text.includes("t.after(") ||
      text.includes("} finally {") ||
      text.includes(".finally(") ||
      /\bafter\(\s*\(/.test(text) ||
      /\bafterEach\(\s*\(/.test(text);

    if (!hasCleanupIdiom) {
      offenders.push(`${name}: ${mkdtempCount} mkdtempSync call(s) but no t.after/try-finally/.finally/after() hook`);
    }
  }

  assert.deepEqual(offenders, [], `file(s) with an mkdtempSync call and no cleanup idiom at all:\n${offenders.join("\n")}`);
});
