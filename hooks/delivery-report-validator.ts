#!/usr/bin/env node
// CLI entry point for the delivery-report-validator. Vendor neutral: reads a
// report from a file or stdin, runs the pure checks in
// ../src/report-validator.ts, and prints findings. Usable from CI, a git
// pre-commit hook, or any agent that can run a command, not only Claude
// Code.
//
// Contract:
//   delivery-report-validator [--report PATH] [--prior PATH] [--format text|json]
// Exit 0: the report passes. Exit 1: at least one finding. Exit 2: the
// validator could not run as asked (unreadable path, bad argument, empty
// input). Exit 2 never looks like a pass: an unreadable report must never
// be reported as clean.

import process from "node:process";
import { readAllStdin } from "../src/hook-io.ts";
import { readFileSync, readSync } from "node:fs";
import {
  formatFindingText,
  parsePriorFindingIds,
  validateReport,
  type Finding,
} from "../src/report-validator.ts";

const USAGE = `Usage: delivery-report-validator [--report PATH] [--prior PATH] [--format text|json]

Reads a delivery report and fails it when the report claims more than it
proved. With no --report, reads the report from stdin.

  --report PATH   read the report from this file instead of stdin
  --prior PATH    a file listing prior open finding ids, one per line
  --format FORMAT "text" (default) or "json"
  --help          print this message and exit 0

Exit codes:
  0  the report passes
  1  the report fails at least one check
  2  the validator could not run as asked
`;

function fail(message: string): never {
  process.stderr.write(`delivery-report-validator: ${message}\n`);
  process.exit(2);
}

/** Reads all of stdin, past the pipe-buffer size, and returns it as a string. */

interface ParsedArgs {
  reportPath?: string;
  priorPath?: string;
  format: "text" | "json";
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { format: "text", help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        result.help = true;
        break;
      case "--report":
        result.reportPath = argv[++i];
        if (result.reportPath === undefined) fail("--report needs a path argument");
        break;
      case "--prior":
        result.priorPath = argv[++i];
        if (result.priorPath === undefined) fail("--prior needs a path argument");
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
      default:
        fail(`unknown argument '${arg}'`);
    }
  }
  return result;
}

function readFileOrFail(path: string, label: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    fail(`could not read ${label} '${path}' (${(err as Error).message})`);
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const reportText = args.reportPath !== undefined ? readFileOrFail(args.reportPath, "report") : readAllStdin();
  if (reportText.trim() === "") {
    fail("the report is empty; nothing to validate");
  }

  const priorFindingIds =
    args.priorPath !== undefined ? parsePriorFindingIds(readFileOrFail(args.priorPath, "prior findings file")) : [];

  const findings = validateReport(reportText, { priorFindingIds });

  if (args.format === "json") {
    process.stdout.write(`${JSON.stringify(findings, null, 2)}\n`);
  } else {
    for (const finding of findings as Finding[]) {
      process.stdout.write(`${formatFindingText(finding)}\n`);
    }
  }

  process.exit(findings.length === 0 ? 0 : 1);
}

main();
