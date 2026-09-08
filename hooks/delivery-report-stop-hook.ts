#!/usr/bin/env node
// Claude Code Stop hook wrapper around the vendor-neutral report validator.
// The only thing this file knows that ../src/report-validator.ts does not:
// how a Stop hook receives its payload and where Claude Code might name the
// report to check. All checking logic lives in the core; keep this file
// short.
//
// Contract: exit 0 lets the agent stop. Exit 2 blocks with findings on
// stderr. Finds no report to check: exit 0 silently, nothing to validate.
// Any operational failure exits 2, never 0.

import process from "node:process";
import { readFileSync, readSync } from "node:fs";
import { formatFindingText, validateReport } from "../src/report-validator.ts";

function block(message: string): never {
  process.stderr.write(message.endsWith("\n") ? message : `${message}\n`);
  process.exit(2);
}

function readAllStdin(): string {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(65536);
  for (;;) {
    let read: number;
    try {
      read = readSync(0, buf, 0, buf.length, null);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") continue;
      if (code === "EOF") break;
      return chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : "";
    }
    if (read === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, read)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Finds the report path: ADG_REPORT wins, else payload.report_path, else none. */
function resolveReportPath(env: Record<string, string | undefined>, raw: string): string | null {
  if (env.ADG_REPORT !== undefined && env.ADG_REPORT.trim() !== "") {
    return env.ADG_REPORT;
  }
  try {
    const payload = JSON.parse(raw) as Record<string, unknown>;
    if (typeof payload.report_path === "string" && payload.report_path.trim() !== "") {
      return payload.report_path;
    }
  } catch {
    // No valid JSON payload and no ADG_REPORT: nothing names a report.
  }
  return null;
}

function main(): void {
  const raw = readAllStdin();
  const reportPath = resolveReportPath(process.env, raw);
  if (reportPath === null) {
    process.exit(0);
  }

  let reportText: string;
  try {
    reportText = readFileSync(reportPath, "utf8");
  } catch (err) {
    block(`delivery-report-stop-hook: could not read report '${reportPath}' (${(err as Error).message}).`);
    return;
  }

  if (reportText.trim() === "") {
    block(`delivery-report-stop-hook: report '${reportPath}' is empty; nothing to validate.`);
    return;
  }

  const findings = validateReport(reportText);
  if (findings.length === 0) {
    process.exit(0);
  }

  const lines = [
    `delivery-report-stop-hook: '${reportPath}' failed ${findings.length} check(s):`,
    ...findings.map((f) => `  ${formatFindingText(f)}`),
  ];
  block(lines.join("\n"));
}

main();
