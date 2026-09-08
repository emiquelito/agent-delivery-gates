// Tests for src/tally.ts, the pure core that parses the gate tally's
// markdown table. No filesystem access: every path check the core needs is
// injected as a fake predicate, and rule ids come from a set built in each
// test, never from reading rules/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTally, type ParseOptions } from "../src/tally.ts";

const RULE_IDS = new Set(["rule-a", "rule-b", "rule-c"]);

function options(overrides: Partial<ParseOptions> = {}): ParseOptions {
  return {
    ruleIds: RULE_IDS,
    pathExists: () => true,
    ...overrides,
  };
}

const HEADER = "| # | Date | Rule | Where to see it | What it caught |";
const SEPARATOR = "|---|------|------|------|----------------|";

function row(n: number, date: string, rule: string, where: string, caught: string): string {
  return `| ${n} | ${date} | ${rule} | ${where} | ${caught} |`;
}

function table(rows: string[]): string {
  return [HEADER, SEPARATOR, ...rows].join("\n");
}

// --- well-formed parsing -----------------------------------------------------

test("a well-formed table parses into the right number of entries", () => {
  const text = table([
    row(1, "2026-01-01", "rule-a", "`tests/a.test.ts`", "caught one thing"),
    row(2, "2026-01-02", "rule-b", "`tests/b.test.ts`", "caught another thing"),
  ]);
  const result = parseTally(text, options());
  assert.equal(result.entries.length, 2);
  assert.equal(result.problems.length, 0);
});

test("per-rule counts are correct and sorted highest first", () => {
  const text = table([
    row(1, "2026-01-01", "rule-a", "`t.ts`", "x"),
    row(2, "2026-01-02", "rule-a", "`t.ts`", "x"),
    row(3, "2026-01-03", "rule-b", "`t.ts`", "x"),
  ]);
  const result = parseTally(text, options({ ruleIds: new Set(["rule-a", "rule-b"]) }));
  assert.deepEqual(result.summary.perRule, [
    { rule: "rule-a", count: 2 },
    { rule: "rule-b", count: 1 },
  ]);
});

// A rule that has never caught anything is the more useful number. Listing
// only the rules that appear hid six of the twelve.
test("a rule with no entries is listed with a count of zero", () => {
  const text = table([row(1, "2026-01-01", "rule-a", "`t.ts`", "x")]);
  const result = parseTally(text, options({ ruleIds: new Set(["rule-a", "rule-b", "rule-c"]) }));
  assert.deepEqual(result.summary.perRule, [
    { rule: "rule-a", count: 1 },
    { rule: "rule-b", count: 0 },
    { rule: "rule-c", count: 0 },
  ]);
});

test("the date range is the earliest and latest date column", () => {
  const text = table([
    row(1, "2026-03-05", "rule-a", "`t.ts`", "x"),
    row(2, "2026-01-01", "rule-a", "`t.ts`", "x"),
    row(3, "2026-02-15", "rule-a", "`t.ts`", "x"),
  ]);
  const result = parseTally(text, options());
  assert.equal(result.summary.earliestDate, "2026-01-01");
  assert.equal(result.summary.latestDate, "2026-03-05");
});

test("no-test count picks up entries whose reference says there is no test", () => {
  const text = table([
    row(1, "2026-01-01", "rule-a", "no test; recorded here only", "x"),
    row(2, "2026-01-02", "rule-a", "`t.ts`", "x"),
  ]);
  const result = parseTally(text, options());
  assert.equal(result.summary.noTestCount, 1);
});

// --- problems -----------------------------------------------------------------

test("a row with too few columns is reported", () => {
  const text = table(["| 1 | 2026-01-01 | rule-a | only four columns |"]);
  const result = parseTally(text, options());
  assert.ok(result.problems.some((p) => /column/i.test(p.message)));
});

test("an unknown rule id is reported", () => {
  const text = table([row(1, "2026-01-01", "not-a-rule", "`t.ts`", "x")]);
  const result = parseTally(text, options());
  assert.ok(result.problems.some((p) => p.message.includes("not-a-rule")));
});

test("a duplicate entry number is reported", () => {
  const text = table([
    row(1, "2026-01-01", "rule-a", "`t.ts`", "x"),
    row(1, "2026-01-02", "rule-a", "`t.ts`", "x"),
  ]);
  const result = parseTally(text, options());
  assert.ok(result.problems.some((p) => /duplicate/i.test(p.message)));
});

test("a gap in the entry numbering is reported", () => {
  const text = table([
    row(1, "2026-01-01", "rule-a", "`t.ts`", "x"),
    row(3, "2026-01-02", "rule-a", "`t.ts`", "x"),
  ]);
  const result = parseTally(text, options());
  assert.ok(result.problems.some((p) => /gap-free sequence/i.test(p.message)));
});

test("a bad date is reported", () => {
  const text = table([row(1, "01/01/2026", "rule-a", "`t.ts`", "x")]);
  const result = parseTally(text, options());
  assert.ok(result.problems.some((p) => /year-month-day/i.test(p.message)));
});

test("a missing referenced path is reported", () => {
  const text = table([row(1, "2026-01-01", "rule-a", "`tests/missing.test.ts`", "x")]);
  const result = parseTally(text, options({ pathExists: () => false }));
  assert.ok(result.problems.some((p) => p.message.includes("tests/missing.test.ts")));
});

test("a present referenced path is not reported", () => {
  const text = table([row(1, "2026-01-01", "rule-a", "`tests/present.test.ts`", "x")]);
  const result = parseTally(text, options({ pathExists: () => true }));
  assert.equal(result.problems.length, 0);
});

test("an empty 'what it caught' cell is reported", () => {
  const text = table([row(1, "2026-01-01", "rule-a", "`t.ts`", "")]);
  const result = parseTally(text, options());
  assert.ok(result.problems.some((p) => /empty/i.test(p.message)));
});

// --- surrounding text and formats ----------------------------------------------

test("prose above and below the table is ignored", () => {
  const text = [
    "# Gate tally",
    "",
    "Some introductory prose that is not part of the table.",
    "",
    table([row(1, "2026-01-01", "rule-a", "`t.ts`", "x")]),
    "",
    "Some closing prose, also not part of the table.",
  ].join("\n");
  const result = parseTally(text, options());
  assert.equal(result.entries.length, 1);
  assert.equal(result.problems.length, 0);
});

test("CRLF line endings are handled", () => {
  const text = table([row(1, "2026-01-01", "rule-a", "`t.ts`", "x")]).replace(/\n/g, "\r\n");
  const result = parseTally(text, options());
  assert.equal(result.entries.length, 1);
  assert.equal(result.problems.length, 0);
});

test("a file with no trailing newline is handled", () => {
  const text = table([row(1, "2026-01-01", "rule-a", "`t.ts`", "x")]);
  assert.ok(!text.endsWith("\n"));
  const result = parseTally(text, options());
  assert.equal(result.entries.length, 1);
});

test("an empty table is a valid starting state, not a problem", () => {
  // A project that has adopted the gates and has not had one reject anything
  // yet has an empty table. Calling that a problem failed its first commit.
  const text = [HEADER, SEPARATOR].join("\n") + "\n";
  const result = parseTally(text, options());
  assert.deepEqual(result.problems, []);
  assert.equal(result.summary.total, 0);
});

test("a file with no table at all is reported as a problem", () => {
  const text = "Just some prose, no table anywhere in this file.";
  const result = parseTally(text, options());
  assert.equal(result.entries.length, 0);
  assert.ok(result.problems.some((p) => /no table found/i.test(p.message)));
});
