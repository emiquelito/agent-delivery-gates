import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeRegExp } from "./lib/regex-escape.ts";

const SPECIALS = ".*+?^${}()|[]\\/-";

test("escapeRegExp makes every metacharacter match only itself", () => {
  for (const ch of SPECIALS) {
    const re = new RegExp(`^${escapeRegExp(ch)}$`);
    assert.ok(re.test(ch), `'${ch}' did not match itself`);
  }
});

test("escapeRegExp handles a backslash, alone and before a dot", () => {
  assert.equal(escapeRegExp("\\"), "\\\\");
  assert.ok(new RegExp(`^${escapeRegExp("a\\.b")}$`).test("a\\.b"));
  assert.ok(!new RegExp(`^${escapeRegExp("a\\.b")}$`).test("a.b"));
});

test("escapeRegExp does not let a dot match another character", () => {
  assert.ok(!new RegExp(`^${escapeRegExp("1.2.3")}$`).test("1x2y3"));
});

test("escapeRegExp round-trips a string of every special at once", () => {
  assert.ok(new RegExp(`^${escapeRegExp(SPECIALS)}$`).test(SPECIALS));
});

test("escapeRegExp leaves ordinary text alone", () => {
  assert.equal(escapeRegExp("abc 123_"), "abc 123_");
});
