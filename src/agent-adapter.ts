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
import { readFileSync } from "node:fs";
import { delimiter } from "node:path";
import {
  ACCEPTED_PHASES,
  formatDirtyTreeMessage,
  getGitStatus,
  isMutatingTool,
  resolvePhase,
  resolveRepoRoot,
} from "./clean-tree-gate.ts";
import { checkPathAllowed, realPath } from "./path-allowlist.ts";
import { separateTestDiffWarmed, formatSignalText, type RuleSet } from "./test-diff-separator.ts";
import { makeGitWholeFileReader } from "./git-blob-reader.ts";
import { ConfigError, loadRuleSet, resolveConfigPath } from "./test-diff-config.ts";
import { validateReport, formatFindingText, parsePriorFindingIds } from "./report-validator.ts";
import { installHintFor } from "./tree-sitter-grammars.ts";

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

  const decision = checkPathAllowed(filePath, roots, realPath, cwd);
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

/** A human-readable language name for each extension `SeparateResult.
 * unwarmedExtensions` can name, for the fail message below. Kept as a
 * plain map, not sourced from src/tree-sitter-grammars.ts's GRAMMAR_SPECS,
 * because that file deliberately imports nothing and knows nothing about
 * display names, only package names and node types; and because ".py"
 * itself is not in GRAMMAR_SPECS at all (Python's service is loaded from
 * its own bespoke module, not the generic tree-sitter one). An extension
 * missing here (there should never be one -- GRAMMAR_SPECS plus ".py" is
 * every extension languageServiceFor can mark unwarmed) falls back to
 * printing the extension itself, which is still specific, just less
 * friendly, and definitely still not "Python". */
const UNWARMED_LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  ".py": "Python",
  ".rs": "Rust",
  ".rb": "Ruby",
  ".php": "PHP",
  ".go": "Go",
  ".java": "Java",
  ".cs": "C#",
};

export async function runTestDiffGate(payload: CanonicalPayload): Promise<AdapterDecision> {
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

  // Finding 6: this used to call separateTestDiff directly, the one
  // production entry point that read a diff without ever warming the
  // Python language service first (hooks/test-diff-separator.ts,
  // hooks/test-diff-post-tool-hook.ts, and src/mcp-server.ts each warm; this
  // file did not). A Copilot or Cursor user committing a .py file got the
  // regex mask with nothing to say a better one existed.
  // separateTestDiffWarmed warms first, and every one of those four
  // production call sites now goes through it instead of its own
  // warm-then-call pair, so a fifth path (or a sixth, or this one again
  // after a future refactor) cannot silently repeat the miss by forgetting
  // a step: there is only one step. The check right after is the backstop
  // for when it happens anyway: result.unwarmedExtensions is set by
  // src/code-mask.ts's languageServiceFor itself, from inside the one
  // function every caller of this scanner already goes through, so it
  // catches a future bypass of separateTestDiffWarmed too, not only this
  // one.
  // This gate always checks one just-made commit, HEAD, against its own
  // first parent, the same fixed pair hooks/test-diff-post-tool-hook.ts
  // reads from; see makeGitWholeFileReader's own comment for what a root
  // commit (no parent) does here. repoRoot undefined (not a git checkout,
  // which should not be reachable this far since the diff-tree call above
  // already needs one, but is not assumed) means no reader at all, and
  // every line falls back to per-line masking.
  const readWholeFile =
    repoRoot === undefined
      ? undefined
      : makeGitWholeFileReader({ cwd, env: gitEnv(), oldRev: "HEAD^1", newRev: "HEAD" });
  const result = await separateTestDiffWarmed(diffText, { rules, readWholeFile });
  // Finding: hadLanguageLoadFailure (src/code-mask.ts) used to be read only
  // by src/mutate.ts, so a grammar that failed to load -- a missing
  // devDependency, or ADG_TEST_FORCE_GRAMMAR_FAILURE below -- left this
  // gate silently scanning that file with the regex fallback, reading
  // every string, comment, and interpolation inside it as ordinary code,
  // with no warning at all. Fixed by checking the same signal mutate.ts
  // already refuses to mutate through, the same way unwarmedExtensions
  // already is checked, right below, so a load failure is loud everywhere
  // this scanner runs, not only in mutation.
  //
  // CRITICAL correction to that fix: this used to block on
  // grammarLoadFailedExtensions before it was split into two fields (see
  // src/code-mask.ts's STOP-GAP comment above grammarAbsentExtensions).
  // The seven tree-sitter grammar packages are devDependencies of a
  // package with no runtime `dependencies` key at all, so `npm install`
  // (this project's own quickstart is `npm install --save-dev
  // agent-delivery-gates`) never installs them for an adopter -- meaning
  // grammarLoadFailedExtensions, undivided, was non-empty for any Python,
  // Rust, Go, Java, PHP, C#, or Ruby file for every real adopter, forever,
  // and this gate hard-blocked every one of those commits. That is worse
  // than the hole it closed. Absence (the package was never installed) is
  // an environment fact, not a defect in the commit, so it gets a loud
  // warning on stderr and the commit goes through; a real failure (the
  // package is there and something about the load still went wrong -- a
  // corrupt install, an ABI mismatch) stays a hard block below, because
  // that really is a bug in this environment or this gate.
  if (result.grammarAbsentExtensions.length > 0) {
    const languages = result.grammarAbsentExtensions.map((ext) => UNWARMED_LANGUAGE_NAMES[ext] ?? ext).join(", ");
    process.stderr.write(
      `test-diff: a ${languages} file in this diff was masked with the regex fallback because its tree-sitter ` +
        "grammar is not installed for this process; the regex scanner may have missed a string, a comment, or an " +
        `interpolation. This is expected until you install it: run \`${installHintFor(result.grammarAbsentExtensions)}\` ` +
        "in your project. Not blocking this commit; treat this run as unmeasured for that file, not as clean.\n",
    );
  }
  if (result.grammarLoadFailedExtensions.length > 0) {
    const languages = result.grammarLoadFailedExtensions.map((ext) => UNWARMED_LANGUAGE_NAMES[ext] ?? ext).join(", ");
    return fail(
      `test-diff: a ${languages} file in this diff was masked with the regex fallback because its tree-sitter ` +
        "grammar failed to load for this process; the regex scanner may have missed a string, a comment, or an " +
        "interpolation this project's tree-sitter service for that language would have caught. This is a bug in " +
        "the environment or the gate, not in the commit; treat this run as unmeasured, not as clean.",
    );
  }
  if (result.unwarmedExtensions.length > 0) {
    // A reviewer caught this message naming Python unconditionally, for
    // any of the seven languages the flag now covers: a diff touching only
    // src/main.rs set unwarmedExtensions to [".rs"] and still got told
    // about a missed docstring or f-string, neither of which Rust has.
    // Named here from the extensions that actually triggered it instead.
    const languages = result.unwarmedExtensions.map((ext) => UNWARMED_LANGUAGE_NAMES[ext] ?? ext).join(", ");
    return fail(
      `test-diff: a ${languages} file in this diff was masked without its language service warmed first; ` +
        "the regex fallback may have missed a string, a comment, or an interpolation this project's tree-sitter " +
        "service for that language would have caught. This is a bug in the gate itself, not in the commit; " +
        "treat this run as unmeasured, not as clean.",
    );
  }
  // Finding 3, corrected: the whole-file reader above is safe on its own
  // (it never misapplies one line's mask to another; see maskDiffLine's
  // own raw-text check in src/test-diff-separator.ts), it only ever
  // detects less well. This used to block here, reasoning it alongside
  // unwarmedExtensions as a bug in the gate's own environment. But a
  // gitlink (a submodule pointer, added or bumped) has no blob for `git
  // show <rev>:path` to read -- "fatal: bad object" -- which is an
  // ordinary git state, not a misconfigured environment, and it made this
  // gate block every commit that touched a submodule. That is the same
  // condition grammarAbsentExtensions already warns on and does not
  // block, just above: an environment fact, not a defect in the commit.
  // Warn here too, matching the standalone CLI and the MCP server, which
  // already treat this condition as advisory.
  if (result.wholeFileMaskFallbackCount > 0) {
    process.stderr.write(
      `test-diff: ${result.wholeFileMaskFallbackCount} line(s) in this diff were masked one at a time instead ` +
        "of through their whole file, because the whole file's own answer for that line could not be trusted " +
        "(a stale read, the line was missing from it, or the path has no readable blob, such as a submodule " +
        "pointer). Not blocking this commit; treat this run as unmeasured for those lines, not as clean.\n",
    );
  }
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
export async function runGate(gate: GateName, payload: CanonicalPayload): Promise<AdapterDecision> {
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
