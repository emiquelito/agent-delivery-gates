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
import { readAllStdin, parseHookPayload } from "../src/hook-io.ts";
import { readFileSync } from "node:fs";
import { formatFindingText, parsePriorFindingIds, validateReport } from "../src/report-validator.ts";

function block(message: string): never {
  process.stderr.write(message.endsWith("\n") ? message : `${message}\n`);
  process.exit(2);
}


/**
 * Prior open finding ids, from ADG_PRIOR_FINDINGS or a prior_findings_path in
 * the payload. Without a channel for these the rule that catches a finding
 * quietly dropped between reports could only ever fire from a command line,
 * which is not where an agent is gated.
 */
function readPriorFindingIds(raw: string): string[] {
  let path: string | undefined;
  const fromEnv = process.env.ADG_PRIOR_FINDINGS;
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    path = fromEnv;
  } else {
    const payload = parseHookPayload(raw);
    if (!("error" in payload) && typeof payload.prior_findings_path === "string") {
      const candidate = payload.prior_findings_path.trim();
      if (candidate !== "") path = candidate;
    }
  }
  if (path === undefined) return [];
  try {
    return parsePriorFindingIds(readFileSync(path, "utf8"));
  } catch (err) {
    block(`delivery-report-stop-hook: could not read prior findings at '${path}' (${(err as Error).message}).`);
  }
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
  // Input that cannot be parsed is an error, not an empty payload. The same
  // condition blocks in the clean-tree gate, and the two hooks disagreeing
  // about it is how one of them ends up passing work nobody checked.
  if (raw.trim() !== "") {
    const payload = parseHookPayload(raw);
    if ("error" in payload) {
      block(`delivery-report-stop-hook: ${payload.error}.`);
    }
  }
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

  const findings = validateReport(reportText, { priorFindingIds: readPriorFindingIds(raw) });
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
