#!/usr/bin/env node
// CLI entry point for the gate tally. Reads docs/gate-tally.md (or a given
// path), runs the pure parsing in ../src/tally.ts, and prints either a
// short summary, the summary as JSON, or the list of problems found.
//
// This is a report, not a hook: it lives in scripts/, not hooks/, which
// holds tools that gate a tool call.
//
// Contract:
//   tally-report [--tally PATH] [--format text|json] [--check]
//
// Exit codes:
//   0  the file is sound: it parsed and carries no problems
//   1  the file parsed but carries at least one problem
//   2  the tool could not run as asked: bad path, unreadable file, no
//      table found, or a bad argument
//
// Exit 2 never looks like success: a file this tool could not read must
// never be reported as sound.

import process from "node:process";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { parseTally, type TallySummary } from "../src/tally.ts";

const USAGE = `Usage: tally-report [--tally PATH] [--format text|json] [--check]

Reads the gate tally and reports its numbers, or checks the file for
problems.

  --tally PATH    read the tally from this file instead of the repo's
                   docs/gate-tally.md
  --format FORMAT "text" (default) or "json"
  --check         print only the problems found, nothing else
  --help          print this message and exit 0

Exit codes:
  0  the file is sound
  1  the file carries at least one problem
  2  the tool could not run as asked
`;

function fail(message: string): never {
  process.stderr.write(`tally-report: ${message}\n`);
  process.exit(2);
}

interface ParsedArgs {
  tallyPath?: string;
  format: "text" | "json";
  check: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { format: "text", check: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        result.help = true;
        break;
      case "--tally":
        result.tallyPath = argv[++i];
        if (result.tallyPath === undefined) fail("--tally needs a path argument");
        break;
      case "--format":
        {
          const value = argv[++i];
          if (value !== "text" && value !== "json") {
            fail(`--format must be "text" or "json", got ${value === undefined ? "nothing" : `'${value}'`}`);
          }
          result.format = value;
        }
        break;
      case "--check":
        result.check = true;
        break;
      default:
        fail(`unknown argument '${arg}'`);
    }
  }
  return result;
}

/** Finds the repository root by asking git, from the current directory, so
 * this works the same whether it is run from the root or a subfolder. A
 * fixed relative path resolved against the current directory has been the
 * same bug twice in this repo already. */
function findRepoRoot(): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(`could not find the repository root (git rev-parse --show-toplevel failed: ${message})`);
  }
}

/**
 * Rule ids come from the project's own rules directory when it has one, and
 * from the installed package otherwise. A project adopting this tool has no
 * rules directory of its own, and reading only the working directory made the
 * check unusable anywhere but here.
 */
function readRuleIds(repoRoot: string): Set<string> {
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const candidates = [join(repoRoot, "rules"), join(packageRoot, "rules")];
  const rulesDir = candidates.find((dir) => existsSync(dir));
  if (rulesDir === undefined) {
    fail(`could not find a rules directory, looked in: ${candidates.join(", ")}`);
  }
  let files: string[];
  try {
    files = readdirSync(rulesDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(`could not read the rules directory '${rulesDir}' (${message})`);
  }
  return new Set(
    files.filter((f) => f.endsWith(".json") && f !== "schema.json").map((f) => f.slice(0, -".json".length)),
  );
}

function readTallyText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(`could not read the tally file '${path}' (${message})`);
  }
}

function formatSummaryText(summary: TallySummary): string {
  const lines: string[] = [];
  lines.push(`total entries: ${summary.total}`);
  lines.push("per rule:");
  for (const { rule, count } of summary.perRule) {
    lines.push(`  ${rule}: ${count}`);
  }
  lines.push(`date range: ${summary.earliestDate ?? "(none)"} to ${summary.latestDate ?? "(none)"}`);
  lines.push(`entries with no test: ${summary.noTestCount}`);
  return lines.join("\n");
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const repoRoot = findRepoRoot();
  const tallyPath = args.tallyPath !== undefined ? resolve(process.cwd(), args.tallyPath) : join(repoRoot, "docs", "gate-tally.md");

  if (!existsSync(tallyPath)) {
    fail(`the tally path '${tallyPath}' does not exist`);
  }

  const ruleIds = readRuleIds(repoRoot);
  const text = readTallyText(tallyPath);

  const result = parseTally(text, {
    ruleIds,
    pathExists: (path: string) => existsSync(resolve(repoRoot, path)),
  });

  // "no table found" means the tool could not make sense of the file at
  // all, which is a reason it could not run, not a problem with a sound
  // file's content. Every other problem is content the file carries while
  // still having parsed.
  const couldNotFindTable =
    result.entries.length === 0 &&
    result.problems.length === 1 &&
    result.problems[0].message.startsWith("no table found");
  if (couldNotFindTable) {
    fail(result.problems[0].message);
  }

  if (args.check) {
    if (result.problems.length === 0) {
      process.stdout.write("tally-report: no problems found\n");
    } else {
      for (const problem of result.problems) {
        process.stdout.write(`row ${problem.line}: ${problem.message}\n`);
      }
    }
    process.exit(result.problems.length === 0 ? 0 : 1);
  }

  if (args.format === "json") {
    process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatSummaryText(result.summary)}\n`);
  }

  process.exit(result.problems.length === 0 ? 0 : 1);
}

main();
