// The Copilot half of the shared core in ./agent-adapter.ts: a payload
// reader that turns a GitHub Copilot cloud-agent hook payload into the
// CanonicalPayload agent-adapter.ts expects, and a verdict writer that
// renders an AdapterDecision in Copilot's own denial contract.
// hooks/copilot-hook.ts turns the result of runCopilotGate below into
// stdin reading, stdout writing, and an exit code; this file never touches
// process.stdin/stdout or calls process.exit, so it can be exercised
// directly without spawning a process, the way src/cursor-adapter.ts is.
//
// Copilot's contract, verified from GitHub's own documentation:
//   - repository config lives in .github/hooks/*.json: version 1, a
//     "hooks" object mapping event names to arrays of entries; the cloud
//     agent reads only from .github/hooks/*.json
//   - event names accept two spellings: preToolUse or PreToolUse,
//     postToolUse or PostToolUse, agentStop or Stop, and so on
//   - the payload is camelCase and does not match the other platforms:
//     preToolUse sends {sessionId, timestamp, cwd, toolName, toolArgs}.
//     There is no tool_name and no tool_input.
//   - deny by writing JSON to stdout:
//     {permissionDecision: "allow"|"deny"|"ask", permissionDecisionReason,
//     modifiedArgs}. permissionDecisionReason is required when denying.
//     This is a different field name from Cursor's permission.
//   - exit 0 means stdout is parsed as the hook output. Exit 2 is a deny
//     for preToolUse and permissionRequest.
//   - any other non-zero exit fails open, except on preToolUse, which
//     fails closed. A timeout always fails open, on every event, including
//     preToolUse.
// Because "any other non-zero exit" already fails closed on preToolUse and
// fails open elsewhere - exactly what an uncaught crash would do anyway -
// this file always writes its verdict as JSON on stdout and exits
// 0 for both allow and deny, and reports an operational failure with a
// distinct non-zero, non-2 exit code, letting the platform's own per-event
// rule decide what that does. See hooks/copilot-hook.ts for the exit code
// this file's "error" verdict maps to.

import { GATE_NAMES, runGate, type AdapterDecision, type CanonicalPayload, type GateName } from "./agent-adapter.ts";

export { GATE_NAMES, type GateName };

/** The Copilot event each gate is wired to in templates/copilot-hooks.json.
 * Copilot has no equivalent of Cursor's beforeReadFile, so path-confinement
 * is wired to preToolUse alongside clean-tree, the same way
 * templates/codex-hooks.json groups them under Codex's PreToolUse. Not
 * enforced against the incoming payload: Copilot itself decides which
 * event fires which command. */
export const GATE_EVENT: Record<GateName, string> = {
  "clean-tree": "preToolUse",
  "path-confinement": "preToolUse",
  "test-diff": "postToolUse",
  report: "agentStop",
};

export type CopilotPermissionDecision = "allow" | "deny" | "ask";

export interface CopilotVerdictBody {
  permissionDecision: CopilotPermissionDecision;
  permissionDecisionReason?: string;
  modifiedArgs?: Record<string, unknown>;
}

export type CopilotDecision =
  | { kind: "allow"; body: CopilotVerdictBody }
  | { kind: "deny"; body: CopilotVerdictBody }
  | { kind: "error"; message: string };

function stringField(payload: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

/** Reads a Copilot hook payload into the canonical form. toolName and cwd
 * are verified top-level fields (GitHub's documentation gives them for
 * preToolUse). filePath and command are not documented at the top level at
 * all, so this looks inside toolArgs for them, the same defensive way
 * hooks/path-confinement.ts reads tool_input: file_path, filePath, path, or
 * notebook_path for a path; command for a shell command. */
export function readCopilotPayload(payload: Record<string, unknown>): CanonicalPayload {
  const toolArgs = payload.toolArgs;
  const args =
    typeof toolArgs === "object" && toolArgs !== null && !Array.isArray(toolArgs)
      ? (toolArgs as Record<string, unknown>)
      : {};

  return {
    toolName: stringField(payload, "toolName"),
    cwd: stringField(payload, "cwd"),
    filePath: stringField(args, "file_path", "filePath", "path", "notebook_path"),
    command: stringField(args, "command"),
    reportPath: stringField(payload, "report_path", "reportPath"),
  };
}

/** Renders an AdapterDecision in Copilot's own terms. permissionDecisionReason
 * is set on deny (Copilot requires it there) and omitted on allow, where
 * there is nothing to explain. */
export function writeCopilotVerdict(decision: AdapterDecision): CopilotDecision {
  switch (decision.kind) {
    case "allow":
      return { kind: "allow", body: { permissionDecision: "allow" } };
    case "deny":
      return {
        kind: "deny",
        body: {
          permissionDecision: "deny",
          permissionDecisionReason: `${decision.userMessage}\n\n${decision.agentMessage}`,
          modifiedArgs: {},
        },
      };
    case "error":
      return { kind: "error", message: decision.message };
  }
}

/** Translates one Copilot hook invocation into a decision. `eventName` is
 * carried through for callers and tests that want to record or assert on
 * it; the gate to run is selected by `gate` alone; see GATE_EVENT above for
 * which event each gate is wired to. */
export async function runCopilotGate(
  gate: GateName,
  _eventName: string,
  payload: Record<string, unknown>,
): Promise<CopilotDecision> {
  return writeCopilotVerdict(await runGate(gate, readCopilotPayload(payload)));
}
