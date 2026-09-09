// Every link inside README.md has to go somewhere. The tally counts in this
// file drifted eleven entries out of date before anyone noticed, and a link
// rots the same quiet way: it stays a link, and nothing fails.
//
// In-document links use an explicit <a id="..."> anchor instead of a heading
// slug. A heading here starts with an emoji, and the slug a renderer builds
// from that is not something this test can settle on its own.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const README = readFileSync(join(ROOT, "README.md"), "utf8");
const REPO_BLOB = "https://github.com/emiquelito/agent-delivery-gates/blob/main/";

test("every in-document link in the README lands on an anchor that exists", () => {
  const anchors = new Set([...README.matchAll(/<a id="([^"]+)"><\/a>/g)].map((m) => m[1]));
  const links = [...README.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]);
  assert.ok(links.length > 0, "the README has no in-document links to check");
  for (const link of links) {
    assert.ok(anchors.has(link), `#${link} has no matching anchor in README.md`);
  }
});

test("every file the README links to is really there", () => {
  // There may be none: links into this repository are absolute, and the test
  // below covers those. This one catches a relative path if one is ever added.
  const links = [...README.matchAll(/\]\((?!https?:|#)([^)]+)\)/g)].map((m) => m[1]);
  for (const link of links) {
    const path = join(ROOT, link.split("#")[0]);
    assert.ok(existsSync(path), `README.md links to ${link}, which is not on disk`);
  }
});

// Links into this repository are absolute, because this README is also the
// page npm shows, where a relative path has nothing to resolve against. The
// path inside the URL still has to name a file that exists.
test("every repository link in the README names a file that exists", () => {
  const links = [...README.matchAll(new RegExp(`\\]\\(${REPO_BLOB}([^)#]+)`, "g"))].map(
    (m) => m[1],
  );
  assert.ok(links.length > 0, "the README has no absolute links into this repository");
  for (const link of links) {
    assert.ok(existsSync(join(ROOT, link)), `README.md links to ${link}, which is not on disk`);
  }
});

test("every worked example on disk is listed in the README", () => {
  const listed = new Set(
    [...README.matchAll(new RegExp(`\\]\\(${REPO_BLOB}(docs/examples/[^)]+\\.md)\\)`, "g"))].map(
      (m) => m[1],
    ),
  );
  const onDisk = readFileSync(join(ROOT, "docs", "examples", "README.md"), "utf8")
    .match(/\d\d-[a-z0-9-]+\.md/g)
    ?.map((n) => `docs/examples/${n}`);
  assert.ok(onDisk && onDisk.length > 0, "the examples index lists nothing");
  for (const example of onDisk) {
    assert.ok(listed.has(example), `${example} is not linked from the README`);
  }
});

// The README's tally figures are written by scripts/refresh-readme-tally.ts
// from docs/gate-tally.md. This runs that script in --check mode instead of
// comparing the numbers a second way: a check that recomputes what it is
// checking can only agree with it, which is what expected-value-derived-apart
// is about. The script is the one implementation; this asserts it was run.
test("the tally figures in the README are what the script would write", () => {
  const result = spawnSync(
    "node",
    [join(ROOT, "scripts", "refresh-readme-tally.ts"), "--check"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(
    result.status,
    0,
    `README.md and docs/gate-tally.md disagree. ${result.stdout}${result.stderr}`,
  );
});
