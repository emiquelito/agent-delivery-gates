// Pure core for the Cursor hook adapter: translates a Cursor hook payload,
// plus the event name it arrived under, into a decision expressed in
// Cursor's own terms. hooks/cursor-hook.ts turns that decision into stdin
// reading, stdout writing, and an exit code; this file never touches
// process.stdin/stdout or calls process.exit, so it can be exercised
// directly without spawning a process, the way clean-tree-gate.ts and
// path-allowlist.ts already are.
//
// Every gate here reuses the existing core it wraps (clean-tree-gate.ts,
// path-allowlist.ts, test-diff-separator.ts plus test-diff-config.ts,
// report-validator.ts) instead of reimplementing any check. What this file
// adds is only: pulling the right field out of a payload built on
// different lines per event, and turning that core's verdict into
// Cursor's own deny/allow form instead of this project's own exit-2/stderr
// form.
//
// Cursor's contract, from its documentation:
//   - a hook denies an action either by exiting 2, or by writing
//     {permission:"deny", user_message, agent_message, continue:false} to
//     stdout and exiting 0
//   - exit 0 with nothing on stdout (or {permission:"allow"}) lets the
//     action through
//   - any other exit code is read as a crash and the action proceeds
//     anyway UNLESS the hooks.json entry sets failClosed: true
// Because of that last rule, this file's job is to never leave a defect
// with nowhere safe to land: every function below returns a decision for
// every input it can see, and hooks/cursor-hook.ts wraps the call in a
// try/catch that turns even an unexpected bug in this file into exit 2.

import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { delimiter } from "node:path";
import {
  ACCEPTED_PHASES,
  formatDirtyTreeMessage,
  getGitStatus,
  resolvePhase,
  resolveRepoRoot,
} from "./clean-tree-gate.ts";
import { checkPathAllowed } from "./path-allowlist.ts";
import { separateTestDiff, formatSignalText, type RuleSet } from "./test-diff-separator.ts";
import { ConfigError, loadRuleSet, resolveConfigPath } from "./test-diff-config.ts";
import { validateReport, formatFindingText, parsePriorFindingIds } from "./report-validator.ts";

export type GateName = "clean-tree" | "path-confinement" | "test-diff" | "report";

export const GATE_NAMES: readonly GateName[] = ["clean-tree", "path-confinement", "test-diff", "report"];

/** The Cursor event each gate is wired to in templates/cursor-hooks.json.
 * Not enforced against the incoming payload's hook_event_name: Cursor
 * itself decides which event fires which command, so a mismatch here would
 * only ever mean this adapter was invoked wrong, which the gate core below
 * will simply fail to find useful fields for and report as an operational
 * error instead of silently allowing. */
export const GATE_EVENT: Record<GateName, string> = {
  "clean-tree": "preToolUse",
  "path-confinement": "beforeReadFile",
  "test-diff": "afterShellExecution",
  report: "stop",
};

export interface CursorDenyBody {
  permission: "deny";
  user_message: string;
  agent_message: string;
  continue: false;
}

export type CursorDecision =
  | { kind: "allow" }
  | { kind: "deny"; body: CursorDenyBody }
  | { kind: "error"; message: string };

function allow(): CursorDecision {
  return { kind: "allow" };
}

function deny(userMessage: string, agentMessage: string): CursorDecision {
  return {
    kind: "deny",
    body: { permission: "deny", user_message: userMessage, agent_message: agentMessage, continue: false },
  };
}

function fail(message: string): CursorDecision {
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

/** First present, non-empty string field, checked in order. Payload field
 * names are not consistent between what our own hooks expect (tool_name,
 * cwd, file_path) and what Cursor's documentation gives per event, so every
 * gate below names the exact keys it is willing to read. */
function stringField(payload: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

// --- clean-tree, on preToolUse -----------------------------------------------
//
// IMPERFECT MAPPING: Cursor's documentation, as handed to this adapter,
// spells out the payload fields for beforeShellExecution, afterShellExecution,
// beforeReadFile, afterFileEdit, and stop, but not for preToolUse itself.
// This assumes preToolUse carries tool_name and an optional cwd, the same
// fields our own Claude-facing hook reads, because that is the only
// documented form close enough to extrapolate from. If Cursor's real
// preToolUse payload differs, this needs revisiting.
//
// A second, harder gap: Cursor's own tool names for its edit tools are not
// given either, so there is no allowlist of literal names to match. This
// matches tool_name against a permissive pattern instead (anything that
// looks like an edit, write, delete, create, or notebook tool), and when
// tool_name is missing entirely, treats the call as relevant instead of
// skipping it. Erring toward checking is the safer direction for a gate
// whose entire purpose is to stop a destructive mutation; the cost is a
// false positive on a tool that turns out to be a pure read, not a missed
// mutation.
const EDIT_TOOL_PATTERN = /write|edit|delete|create|notebook/i;

export function runCleanTreeGate(payload: Record<string, unknown>): CursorDecision {
  const toolName = stringField(payload, "tool_name", "toolName", "tool");
  if (toolName !== undefined && !EDIT_TOOL_PATTERN.test(toolName)) {
    return allow();
  }

  // No cwd in the payload falls back to the process's own working
  // directory, the same fallback hooks/pre-mutation-clean-tree.ts uses.
  const cwd = stringField(payload, "cwd") ?? process.cwd();

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

// --- path-confinement, on beforeReadFile -------------------------------------
//
// IMPERFECT MAPPING: beforeReadFile's payload is {file_path, content,
// attachments, conversation_id} - no cwd, unlike beforeShellExecution.
// This resolves file_path against the process's own working directory
// instead, the same fallback the Claude-facing hook uses when its own
// payload's cwd is absent.

export function runPathConfinementGate(payload: Record<string, unknown>): CursorDecision {
  const filePath = stringField(payload, "file_path", "filePath");
  if (filePath === undefined) {
    return fail("path-confinement: beforeReadFile payload carried no file_path.");
  }

  const cwd = process.cwd();

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

// --- test-diff, on afterShellExecution ---------------------------------------
//
// IMPERFECT MAPPING: Cursor's documentation states plainly that
// afterShellExecution's payload is not spelled out in the reference handed
// to this adapter. This assumes it carries at least the same `command` and
// `cwd` fields beforeShellExecution documents ({command, cwd, sandbox,
// conversation_id, generation_id, hook_event_name}), since the before and
// after of one shell call plausibly carry the same fields. Every field is read
// defensively (stringField never throws on a missing or wrong-typed key),
// so a payload that turns out to differ blocks nothing it cannot make
// sense of, instead of throwing.

function runsGitCommit(command: string): boolean {
  return /(^|[;&|]|\s)git\s+commit(\s|$)/.test(command);
}

export function runTestDiffGate(payload: Record<string, unknown>): CursorDecision {
  const command = stringField(payload, "command") ?? "";
  if (!runsGitCommit(command)) {
    return allow();
  }

  const cwd = stringField(payload, "cwd") ?? process.cwd();

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
    diffText = execFileSync("git", ["diff-tree", "-p", "--no-color", "--root", "-r", "HEAD"], {
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

// --- report, on stop ----------------------------------------------------------
//
// IMPERFECT MAPPING, the sharpest one here: Cursor's stop payload is
// {status, loop_count, conversation_id} - there is no path to anything in
// it at all, so this gate has no payload field it could ever read a report
// path from. It falls back entirely to the ADG_REPORT environment
// variable the Claude-facing hook already supports (and, defensively,
// payload.report_path in case a future Cursor version adds one - it never
// will today). With neither set there is nothing to validate, and this
// allows, the same as the Claude hook does when it finds no report to
// check. A project that wants this gate enforced under Cursor has to set
// ADG_REPORT itself; there is no other way to tell this hook where the
// report lives.

function readPriorFindingIds(): string[] | { error: string } {
  const path = process.env.ADG_PRIOR_FINDINGS;
  if (path === undefined || path.trim() === "") return [];
  try {
    return parsePriorFindingIds(readFileSync(path, "utf8"));
  } catch (err) {
    return { error: `could not read prior findings at '${path}' (${(err as Error).message})` };
  }
}

export function runReportGate(payload: Record<string, unknown>): CursorDecision {
  const envReport = process.env.ADG_REPORT;
  const reportPath =
    envReport !== undefined && envReport.trim() !== "" ? envReport : stringField(payload, "report_path");

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

/**
 * Translates one Cursor hook invocation into a decision. `eventName` is
 * carried through for callers and tests that want to record or assert on
 * it; the gate to run is selected by `gate` alone; see GATE_EVENT above for
 * which event each gate is wired to.
 */
export function runCursorGate(
  gate: GateName,
  _eventName: string,
  payload: Record<string, unknown>,
): CursorDecision {
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
