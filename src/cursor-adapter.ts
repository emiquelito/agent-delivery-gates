// The Cursor half of the shared core in ./agent-adapter.ts: a payload
// reader that turns a Cursor hook payload into the CanonicalPayload
// agent-adapter.ts expects, and a verdict writer that renders an
// AdapterDecision in Cursor's own denial contract. hooks/cursor-hook.ts
// turns the result of runCursorGate below into stdin reading, stdout
// writing, and an exit code; this file never touches
// process.stdin/stdout or calls process.exit, so it can be exercised
// directly without spawning a process, the way clean-tree-gate.ts and
// path-allowlist.ts already are.
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
// with nowhere safe to land: runCursorGate below returns a decision for
// every input it can see, and hooks/cursor-hook.ts wraps the call in a
// try/catch that turns even an unexpected bug in this file into exit 2.

import { GATE_NAMES, runGate, type AdapterDecision, type CanonicalPayload, type GateName } from "./agent-adapter.ts";

export { GATE_NAMES, type GateName };

/** The Cursor event each gate is wired to in templates/cursor-hooks.json.
 * Not enforced against the incoming payload's hook_event_name: Cursor
 * itself decides which event fires which command, so a mismatch here would
 * only ever mean this adapter was invoked wrong, which the gate core will
 * simply fail to find useful fields for and report as an operational error
 * instead of silently allowing. */
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

/** First present, non-empty string field, checked in order. Payload field
 * names are not consistent between what our own hooks expect (tool_name,
 * cwd, file_path) and what Cursor's documentation gives per event, so this
 * checks every key spelling any Cursor event is documented to use. */
function stringField(payload: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

/** Reads a Cursor hook payload into the canonical form. One reader
 * covers every event/gate: the key spellings below don't collide across
 * events, so a field a given event doesn't carry simply comes back
 * undefined and the gate core falls back the same way it always has. */
export function readCursorPayload(payload: Record<string, unknown>): CanonicalPayload {
  return {
    toolName: stringField(payload, "tool_name", "toolName", "tool"),
    cwd: stringField(payload, "cwd"),
    filePath: stringField(payload, "file_path", "filePath"),
    command: stringField(payload, "command"),
    reportPath: stringField(payload, "report_path"),
  };
}

/** Renders an AdapterDecision in Cursor's own terms. */
export function writeCursorVerdict(decision: AdapterDecision): CursorDecision {
  switch (decision.kind) {
    case "allow":
      return { kind: "allow" };
    case "deny":
      return {
        kind: "deny",
        body: {
          permission: "deny",
          user_message: decision.userMessage,
          agent_message: decision.agentMessage,
          continue: false,
        },
      };
    case "error":
      return { kind: "error", message: decision.message };
  }
}

/**
 * Translates one Cursor hook invocation into a decision. `eventName` is
 * carried through for callers and tests that want to record or assert on
 * it; the gate to run is selected by `gate` alone; see GATE_EVENT above for
 * which event each gate is wired to.
 */
export async function runCursorGate(
  gate: GateName,
  _eventName: string,
  payload: Record<string, unknown>,
): Promise<CursorDecision> {
  return writeCursorVerdict(await runGate(gate, readCursorPayload(payload)));
}
