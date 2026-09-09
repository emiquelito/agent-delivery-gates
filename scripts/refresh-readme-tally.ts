#!/usr/bin/env node
// Writes the tally figures in README.md from docs/gate-tally.md, so the two
// cannot disagree. Before this existed the numbers were typed in, and they
// went stale three times, twice with nobody noticing until a reader would
// have seen a count that was eleven entries out of date.
//
// The block it owns is delimited by HTML comments, so everything around it
// stays hand written. Only the sentence's figures and the per-rule list are
// generated; the prose is left alone.
//
// Exit codes: 0 the README already matched, or was rewritten; 1 with --check
// when it did not match; 2 could not run as asked.

import process from "node:process";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const README = join(ROOT, "README.md");
const OPEN = "<!-- tally:start -->";
const CLOSE = "<!-- tally:end -->";

const NUMBER_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
  "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
];

function fail(message: string): never {
  process.stderr.write(`refresh-readme-tally: ${message}\n`);
  process.exit(2);
}

function tallyFacts(): { total: string; first: string; last: string; noTest: string; counts: string[] } {
  let report: string;
  try {
    report = execFileSync("node", [join(ROOT, "scripts", "tally-report.ts")], {
      cwd: ROOT,
      encoding: "utf8",
    });
  } catch (err) {
    fail(`could not read the tally: ${(err as Error).message}`);
  }
  const total = report.match(/total entries: (\d+)/);
  const range = report.match(/date range: (\S+) to (\S+)/);
  const noTest = report.match(/entries with no test: (\d+)/);
  const counts = [...report.matchAll(/^ {2}([a-z0-9-]+): (\d+)$/gm)].map((m) => `${m[1]}: ${m[2]}`);
  if (!total || !range || !noTest || counts.length === 0) {
    fail("the tally report did not carry the figures this script reads");
  }
  return { total: total[1], first: range[1], last: range[2], noTest: noTest[1], counts };
}

function words(count: string): string {
  const n = Number(count);
  return n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : count;
}

function block(): string {
  const f = tallyFacts();
  return [
    OPEN,
    `build: ${f.total} entries, dated ${f.first} to ${f.last}, ${words(f.noTest)} with no automated`,
    "test behind them because someone read the situation and wrote it down",
    "instead.",
    "",
    "```",
    ...f.counts,
    "```",
    CLOSE,
  ].join("\n");
}

function main(): void {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  for (const arg of args) {
    if (arg !== "--check") fail(`unknown argument '${arg}'`);
  }

  let text: string;
  try {
    text = readFileSync(README, "utf8");
  } catch (err) {
    fail(`could not read README.md: ${(err as Error).message}`);
  }

  const start = text.indexOf(OPEN);
  const end = text.indexOf(CLOSE);
  if (start < 0 || end < 0 || end < start) {
    fail(`README.md carries no ${OPEN} ... ${CLOSE} block for this script to write`);
  }

  const current = text.slice(start, end + CLOSE.length);
  const wanted = block();
  if (current === wanted) {
    process.stdout.write("refresh-readme-tally: the README already matches the tally\n");
    process.exit(0);
  }
  if (check) {
    process.stderr.write(
      "refresh-readme-tally: README.md does not match docs/gate-tally.md.\n" +
        "Run scripts/refresh-readme-tally.ts to write it.\n",
    );
    process.exit(1);
  }
  writeFileSync(README, text.slice(0, start) + wanted + text.slice(end + CLOSE.length));
  process.stdout.write("refresh-readme-tally: wrote the tally figures into README.md\n");
  process.exit(0);
}

main();
