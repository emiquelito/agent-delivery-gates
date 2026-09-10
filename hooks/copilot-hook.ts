#!/usr/bin/env node
// GitHub Copilot hook entry point. Reads a Copilot hook payload from
// stdin, hands it to the matching gate core in ../src/agent-adapter.ts via
// ../src/copilot-adapter.ts, and writes the result in Copilot's own denial
// contract, not this project's usual exit-2/stderr contract.
//
// Copilot's contract, from GitHub's own documentation (see
// src/copilot-adapter.ts's header for the full quote):
//   - deny by writing {permissionDecision:"deny", permissionDecisionReason,
//     modifiedArgs} to stdout and exiting 0
//   - allow by exiting 0, with or without a {permissionDecision:"allow"}
//     body
//   - exit 2 is a deny, but only for preToolUse and permissionRequest;
//     on every other event it is read the same as any other non-zero exit
//   - any other non-zero exit fails open, except on preToolUse, which
//     fails closed
//   - a timeout always fails open, on every event, including preToolUse
// Relying on that per-event exit-code split would mean an operational
// failure on postToolUse (test-diff, wired there in
// templates/copilot-hooks.json) or agentStop (report) fails open even
// though this file caught it cleanly. So this file never uses exit codes
// to signal a deny at all: every allow, every deny, and every operational
// error this file can catch is written as JSON on stdout with exit 0,
// which the platform parses as an explicit decision on every event, not
// only preToolUse. The one case that stays fail-open on every event,
// including preToolUse, is a timeout - by definition, nothing this file
// writes ever reaches the platform then, since it never gets to run to
// completion. See CLAUDE.md's task notes and this repo's delivery report
// for that gap; there is no in-process fix for it.
//
// This file must never exit 1: exit 1 has no defined meaning in Copilot's
// contract and, being "some other non-zero exit", would fail open on every
// event but preToolUse. main() is wrapped in a try/catch so an unexpected
// bug in this file or in copilot-adapter.ts still lands on an explicit
// deny, never on node's own uncaught-exception exit (which is 1).
//
// Usage: copilot-hook <gate>, where gate is one of clean-tree,
// path-confinement, test-diff, report. bin/adg.ts's `copilot-hook <gate>`
// subcommand is the documented way to reach this file; templates/
// copilot-hooks.json wires each of Copilot's events to that subcommand.

import process from "node:process";
import { readAllStdin, parseHookPayload } from "../src/hook-io.ts";
import { GATE_EVENT, GATE_NAMES, runCopilotGate, type GateName, type CopilotVerdictBody } from "../src/copilot-adapter.ts";

function writeVerdict(body: CopilotVerdictBody): never {
  process.stdout.write(JSON.stringify(body));
  process.exit(0);
}

/** An operational failure this file caught: rendered as an explicit deny
 * so it fails closed on every event, not only preToolUse. See the header
 * above for why this file never signals a deny through the exit code
 * alone. */
function denyOnFailure(message: string): never {
  writeVerdict({ permissionDecision: "deny", permissionDecisionReason: message, modifiedArgs: {} });
}

function isGateName(value: string | undefined): value is GateName {
  return value !== undefined && (GATE_NAMES as readonly string[]).includes(value);
}

async function main(): Promise<void> {
  const gateArg = process.argv[2];
  if (!isGateName(gateArg)) {
    denyOnFailure(`copilot-hook: unknown gate '${gateArg ?? ""}'; expected one of ${GATE_NAMES.join(", ")}.`);
    return;
  }
  const gate = gateArg;

  const raw = readAllStdin();
  const payload = parseHookPayload(raw);
  if ("error" in payload) {
    denyOnFailure(`copilot-hook: ${gate}: ${payload.error}.`);
    return;
  }

  const eventName =
    typeof payload.hookEventName === "string" ? payload.hookEventName : GATE_EVENT[gate];

  // runCopilotGate became async once the test-diff gate had to warm the
  // Python language service before separating a diff (see
  // src/agent-adapter.ts's runTestDiffGate); the .catch below is what a
  // bare, unhandled `main()` call would otherwise lose: an uncaught
  // rejection here would exit 1, a code this file documents it must never
  // use.
  const decision = await runCopilotGate(gate, eventName, payload);

  switch (decision.kind) {
    case "allow":
      writeVerdict(decision.body);
      return;
    case "deny":
      writeVerdict(decision.body);
      return;
    case "error":
      denyOnFailure(`copilot-hook: ${decision.message}`);
      return;
  }
}

main().catch((err) => {
  denyOnFailure(`copilot-hook: unexpected failure (${(err as Error).message}).`);
});
