#!/usr/bin/env node
// Cursor hook entry point. Reads a Cursor hook payload from stdin, hands it
// to the matching gate core in ../src/cursor-adapter.ts, and writes the
// result in Cursor's own denial contract, not this project's usual
// exit-2/stderr contract.
//
// Cursor's contract, from its documentation (see src/cursor-adapter.ts's
// header for the full quote):
//   - exit 2 blocks the action
//   - exit 0 with {permission:"deny", user_message, agent_message,
//     continue:false} on stdout also blocks it
//   - exit 0 with nothing on stdout lets the action through
//   - any OTHER exit code is read as a crash and the action proceeds
//     anyway UNLESS the hooks.json entry sets failClosed: true
// So this file must never exit 1: that is the one code that fails open in
// Cursor's terms. Every deliberate refusal below exits 0 with a deny body,
// or exits 2. main() is wrapped in a try/catch so an unexpected bug in this
// file or in cursor-adapter.ts still lands on exit 2, never on node's own
// uncaught-exception exit (which is 1).
//
// Usage: cursor-hook <gate>, where gate is one of clean-tree,
// path-confinement, test-diff, report. bin/adg.ts's `cursor-hook <gate>`
// subcommand is the documented way to reach this file; templates/
// cursor-hooks.json wires each of Cursor's four events to that subcommand.

import process from "node:process";
import { readAllStdin, parseHookPayload } from "../src/hook-io.ts";
import { GATE_EVENT, GATE_NAMES, runCursorGate, type GateName } from "../src/cursor-adapter.ts";

function fail(message: string): never {
  process.stderr.write(message.endsWith("\n") ? message : `${message}\n`);
  process.exit(2);
}

function isGateName(value: string | undefined): value is GateName {
  return value !== undefined && (GATE_NAMES as readonly string[]).includes(value);
}

async function main(): Promise<void> {
  const gateArg = process.argv[2];
  if (!isGateName(gateArg)) {
    fail(`cursor-hook: unknown gate '${gateArg ?? ""}'; expected one of ${GATE_NAMES.join(", ")}.`);
    return;
  }
  const gate = gateArg;

  const raw = readAllStdin();
  const payload = parseHookPayload(raw);
  if ("error" in payload) {
    fail(`cursor-hook: ${gate}: ${payload.error}.`);
    return;
  }

  const eventName = typeof payload.hook_event_name === "string" ? payload.hook_event_name : GATE_EVENT[gate];

  // runCursorGate became async once the test-diff gate had to warm the
  // Python language service before separating a diff (see
  // src/agent-adapter.ts's runTestDiffGate); the .catch below is what a
  // bare, unhandled `main()` call would otherwise lose: an uncaught
  // rejection here would exit 1 with node's own stack trace, the one exit
  // code that fails open in Cursor's terms.
  const decision = await runCursorGate(gate, eventName, payload);

  switch (decision.kind) {
    case "allow":
      process.exit(0);
      return;
    case "deny":
      process.stdout.write(JSON.stringify(decision.body));
      process.exit(0);
      return;
    case "error":
      fail(`cursor-hook: ${decision.message}`);
      return;
  }
}

main().catch((err) => {
  fail(`cursor-hook: unexpected failure (${(err as Error).message}).`);
});
