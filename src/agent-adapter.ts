// Shared core between every hook adapter this project ships. Cursor and
// Copilot each get a small reader (turns that platform's raw payload into
// the CanonicalPayload below) and a small writer (turns an AdapterDecision
// below into that platform's own denial or allow form). Everything in
// between - which gate runs, what it checks, what it says when it denies -
// lives here exactly once.
//
// This file is the fix for a problem this project has already hit twice:
// two copies of a path lookup that disagreed, and three gates whose
// tool-name matching drifted apart because each had its own copy of the
// check. A platform adapter has nowhere to reimplement gate logic; it can
// only read a payload into the form below and render a decision back out.
//
// Every gate here reuses the existing core it wraps (clean-tree-gate.ts,
// path-allowlist.ts, test-diff-separator.ts plus test-diff-config.ts,
// report-validator.ts) instead of reimplementing any check.

import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { delimiter } from "node:path";
import {
  ACCEPTED_PHASES,
  formatDirtyTreeMessage,
  getGitStatus,
  isMutatingTool,
  resolvePhase,
  resolveRepoRoot,
} from "./clean-tree-gate.ts";
import { checkPathAllowed } from "./path-allowlist.ts";
import { separateTestDiff, formatSignalText, type RuleSet } from "./test-diff-separator.ts";
import { ConfigError, loadRuleSet, resolveConfigPath } from "./test-diff-config.ts";
import { validateReport, formatFindingText, parsePriorFindingIds } from "./report-validator.ts";

export type GateName = "clean-tree" | "path-confinement" | "test-diff" | "report";

export const GATE_NAMES: readonly GateName[] = ["clean-tree", "path-confinement", "test-diff", "report"];

/**
 * One hook invocation, translated out of whatever field names the
 * originating platform happens to use. Every field is optional: not every
 * platform, and not every event within a platform, carries all four.
 *
 * Which platform supplies what, as read by each platform's own reader
 * (src/cursor-adapter.ts's readCursorPayload, src/copilot-adapter.ts's
 * readCopilotPayload):
 *   - toolName: Cursor's tool_name / toolName / tool, when the event names
 *     one (assumed present on preToolUse; not documented, see
 *     src/cursor-adapter.ts). Copilot's toolName, verified from GitHub's
 *     documentation for preToolUse.
 *   - cwd: Cursor's cwd, present on the shell-execution events and assumed
 *     present on preToolUse; not carried by beforeReadFile or stop.
 *     Copilot's cwd, verified for preToolUse.
 *   - filePath: Cursor's file_path / filePath, carried by beforeReadFile
 *     and afterFileEdit. Copilot does not document a top-level path field;
 *     its reader looks inside toolArgs for one, the same defensive way
 *     hooks/path-confinement.ts reads tool_input.
 *   - command: Cursor's command, carried by the shell-execution events.
 *     Copilot does not document a top-level command field; its reader
 *     looks inside toolArgs for one.
 *   - reportPath: neither platform documents a path to a delivery report
 *     on its stop-like event; both platforms' report gate really runs off
 *     ADG_REPORT. This field is a defensive fallback only, read from
 *     report_path where a payload happens to carry it.
 */
export interface CanonicalPayload {
  toolName?: string;
  cwd?: string;
  filePath?: string;
  command?: string;
  reportPath?: string;
}

/**
 * A gate's verdict, independent of any platform's own denial contract. A
 * writer renders this into that platform's terms; nothing here knows or
 * cares what those terms are.
 */
export type AdapterDecision =
  | { kind: "allow" }
  | { kind: "deny"; userMessage: string; agentMessage: string }
  | { kind: "error"; message: string };

function allow(): AdapterDecision {
  return { kind: "allow" };
}

function deny(userMessage: string, agentMessage: string): AdapterDecision {
  return { kind: "deny", userMessage, agentMessage };
}

function fail(message: string): AdapterDecision {
  return { kind: "error", message };
}

/** Strips every GIT_* override before calling git, the way
 * src/clean-tree-gate.ts and hooks/path-confinement.ts already do. A
 * leftover GIT_WORK_TREE or GIT_DIR would point git at a different tree
 * than the one this adapter is meant to check. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  return env;
}

// --- clean-tree ---------------------------------------------------------
//
// IMPERFECT MAPPING (Cursor): Cursor's documentation, as handed to this
// adapter, spells out the payload fields for beforeShellExecution,
// afterShellExecution, beforeReadFile, afterFileEdit, and stop, but not for
// preToolUse itself, which is what this gate is wired to. This assumes
// preToolUse carries tool_name and an optional cwd, the same fields our own
// Claude-facing hook reads, because that is the only documented form close
// enough to extrapolate from. If Cursor's real preToolUse payload differs,
// this needs revisiting.
//
// A second, harder gap: neither platform's documentation gives an
// allowlist of literal edit-tool names, and this project has already been
// bitten by keeping a second, separate copy of that decision (see
// src/clean-tree-gate.ts's own header comment). This calls isMutatingTool
// from clean-tree-gate.ts, the one place the verified names and the
// heuristic pattern live, so this path and the Claude/Codex hook path
// agree on every tool name instead of drifting apart. When toolName is
// missing entirely, this treats the call as relevant instead of skipping
// it. Erring toward checking is the safer direction for a gate whose
// entire purpose is to stop a destructive mutation; the cost is a false
// positive on a tool that turns out to be a pure read, not a missed
// mutation.

export function runCleanTreeGate(payload: CanonicalPayload): AdapterDecision {
  if (payload.toolName !== undefined && !isMutatingTool(payload.toolName, process.env)) {
    return allow();
  }

  // No cwd in the payload falls back to the process's own working
  // directory, the same fallback hooks/pre-mutation-clean-tree.ts uses.
  const cwd = payload.cwd ?? process.cwd();

  let repoRoot: string;
  try {
    repoRoot = resolveRepoRoot(cwd);
  } catch (err) {
    return fail(`clean-tree: ${(err as Error).message}`);
  }

  const phase = resolvePhase(process.env, repoRoot);
  if (phase && typeof phase === "object" && "error" in phase) {
    return fail(`clean-tree: ${phase.error} (accepted: ${[...ACCEPTED_PHASES].join(", ")}).`);
  }
  // "build" is the only phase that turns the check off; no phase set at
  // all is guarded by default, the same as the Claude hook.
  if (phase === "build") {
    return allow();
  }

  let status;
  try {
    status = getGitStatus(repoRoot);
  } catch (err) {
    return fail(`clean-tree: git check failed, refusing to allow (${(err as Error).message}).`);
  }
  if (status.clean) return allow();

  return deny(
    "The working tree has uncommitted changes. Commit before this phase mutates anything.",
    formatDirtyTreeMessage(status.dirtyLines),
  );
}

// --- path-confinement -----------------------------------------------------
//
// IMPERFECT MAPPING (Cursor): beforeReadFile's payload is {file_path,
// content, attachments, conversation_id} - no cwd, unlike
// beforeShellExecution. Cursor's reader therefore never has a cwd to hand
// this gate, so this always ends up resolving file_path against the
// process's own working directory - the same fallback the Claude-facing
// hook uses when its own payload's cwd is absent. Copilot's preToolUse
// does document cwd, and this gate is wired to preToolUse under Copilot
// (see src/copilot-adapter.ts's GATE_EVENT), so the canonical field is
// read here when a reader does supply one, with the same process.cwd()
// fallback only when it does not.

export function runPathConfinementGate(payload: CanonicalPayload): AdapterDecision {
  const filePath = payload.filePath;
  if (filePath === undefined) {
    return fail("path-confinement: the payload carried no file path.");
  }

  const cwd = payload.cwd ?? process.cwd();

  let repoRoot: string;
  try {
    repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      env: gitEnv(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(`path-confinement: could not resolve the repository root (${message}).`);
  }

  const roots = [repoRoot, tmpdir()];
  const extraRoots = process.env.ADG_ALLOWED_ROOTS;
  if (typeof extraRoots === "string" && extraRoots !== "") {
    for (const root of extraRoots.split(delimiter)) {
      if (root !== "") roots.push(root);
    }
  }

  const decision = checkPathAllowed(filePath, roots, realpathSync, cwd);
  if (decision.allowed) return allow();
  return deny("This file is outside the project's allowed paths.", decision.message);
}

// --- test-diff --------------------------------------------------------------
//
// IMPERFECT MAPPING (Cursor): afterShellExecution's payload is not spelled
// out in the reference handed to this adapter. This assumes it carries at
// least the same command and cwd fields beforeShellExecution documents
// ({command, cwd, sandbox, conversation_id, generation_id,
// hook_event_name}), since the before and after of one shell call
// plausibly carry the same fields.
// IMPERFECT MAPPING (Copilot): postToolUse's own payload form beyond
// toolName/cwd/toolArgs is not given either; command is read out of
// toolArgs the same defensive way the file path is.
// Every field is read defensively (never throws on a missing field), so a
// payload that turns out to differ blocks nothing it cannot make sense of,
// instead of throwing.

function runsGitCommit(command: string): boolean {
  return /(^|[;&|]|\s)git\s+commit(\s|$)/.test(command);
}

export function runTestDiffGate(payload: CanonicalPayload): AdapterDecision {
  const command = payload.command ?? "";
  if (!runsGitCommit(command)) {
    return allow();
  }

  const cwd = payload.cwd ?? process.cwd();

  let repoRoot: string | undefined;
  try {
    repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      env: gitEnv(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    repoRoot = undefined;
  }

  let rules: RuleSet;
  try {
    rules = loadRuleSet(resolveConfigPath({ env: process.env, repoRoot }));
  } catch (err) {
    if (err instanceof ConfigError) {
      return fail(`test-diff: config: ${err.message}`);
    }
    throw err;
  }

  let diffText: string;
  try {
    diffText = execFileSync("git", ["diff-tree", "-p", "--no-color", "--root", "-r", "--find-renames", "HEAD"], {
      cwd,
      env: gitEnv(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const detail =
      typeof e.stderr === "string" && e.stderr.trim() !== "" ? e.stderr.trim() : (e.message ?? String(err));
    return fail(`test-diff: the gate could not run, so nothing was checked: could not read HEAD's diff (${detail}).`);
  }

  const result = separateTestDiff(diffText, { rules });
  if (result.signals.length === 0) return allow();

  const lines = [
    `test-diff found ${result.signals.length} weakening signal(s) in this commit:`,
    ...result.signals.map((s) => `  ${formatSignalText(s)}`),
  ];
  return deny(
    "This commit weakens a test instead of fixing the issue it covers. See the agent message for what changed.",
    lines.join("\n"),
  );
}

// --- report ----------------------------------------------------------------
//
// IMPERFECT MAPPING, the sharpest one here, on both platforms: Cursor's
// stop payload is {status, loop_count, conversation_id}, and Copilot's
// agentStop event is not documented beyond its name - neither carries a
// path to anything. This falls back entirely to the ADG_REPORT environment
// variable the Claude-facing hook already supports (and, defensively,
// payload.reportPath in case a payload ever adds one). With neither set
// there is nothing to validate, and this allows, the same as the Claude
// hook does when it finds no report to check. A project that wants this
// gate enforced under Cursor or Copilot has to set ADG_REPORT itself;
// there is no other way to tell this hook where the report lives.

function readPriorFindingIds(): string[] | { error: string } {
  const path = process.env.ADG_PRIOR_FINDINGS;
  if (path === undefined || path.trim() === "") return [];
  try {
    return parsePriorFindingIds(readFileSync(path, "utf8"));
  } catch (err) {
    return { error: `could not read prior findings at '${path}' (${(err as Error).message})` };
  }
}

export function runReportGate(payload: CanonicalPayload): AdapterDecision {
  const envReport = process.env.ADG_REPORT;
  const reportPath = envReport !== undefined && envReport.trim() !== "" ? envReport : payload.reportPath;

  if (reportPath === undefined) return allow();

  let reportText: string;
  try {
    reportText = readFileSync(reportPath, "utf8");
  } catch (err) {
    return fail(`report: could not read report '${reportPath}' (${(err as Error).message}).`);
  }

  if (reportText.trim() === "") {
    return fail(`report: report '${reportPath}' is empty; nothing to validate.`);
  }

  const priorFindingIds = readPriorFindingIds();
  if (!Array.isArray(priorFindingIds)) {
    return fail(`report: ${priorFindingIds.error}.`);
  }

  const findings = validateReport(reportText, { priorFindingIds });
  if (findings.length === 0) return allow();

  const lines = [
    `'${reportPath}' failed ${findings.length} check(s):`,
    ...findings.map((f) => `  ${formatFindingText(f)}`),
  ];
  return deny(
    "The delivery report did not pass validation. See the agent message for the failed checks.",
    lines.join("\n"),
  );
}

// --- dispatch ------------------------------------------------------------

/** Translates one hook invocation, already reduced to a CanonicalPayload
 * by the calling platform's own reader, into a decision. This is the one
 * place that picks which gate core to run; every platform's own hook entry
 * point calls this, never the individual gate functions above directly,
 * so a gate added or changed here reaches every platform at once. */
export function runGate(gate: GateName, payload: CanonicalPayload): AdapterDecision {
  switch (gate) {
    case "clean-tree":
      return runCleanTreeGate(payload);
    case "path-confinement":
      return runPathConfinementGate(payload);
    case "test-diff":
      return runTestDiffGate(payload);
    case "report":
      return runReportGate(payload);
  }
}
