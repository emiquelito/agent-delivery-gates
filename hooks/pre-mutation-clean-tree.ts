#!/usr/bin/env node
// PreToolUse hook: refuses a mutating tool call while the working tree is
// dirty and the current phase is one where a reviewer might run a git
// operation that destroys uncommitted work (review, mutation-testing).
//
// Contract: exit 0 allows the tool call. Exit 2 blocks it and stderr is
// shown to the agent. Any other non-zero exit is a non-blocking error, so
// every deliberate refusal in this file uses exit 2, never a bare throw.
//
// This hook never fails open: any input it cannot make sense of is treated
// as a reason to block, not a reason to allow. That includes a payload with
// no tool_name at all: this hook is wired to more than one agent's
// PreToolUse event now (see templates/codex-hooks.json alongside
// hooks/hooks.json), and a payload whose fields past the JSON envelope are
// not known gets checked instead of skipped, the same choice
// src/cursor-adapter.ts makes for its own unknown preToolUse payload.

import process from "node:process";
import {
  ACCEPTED_PHASES,
  formatDirtyTreeMessage,
  getGitStatus,
  parseMutationHookInput,
  readAllStdin,
  resolveMutatingTools,
  resolvePhase,
  resolveRepoRoot,
} from "../src/clean-tree-gate.ts";

function block(message: string): never {
  process.stderr.write(message.endsWith("\n") ? message : `${message}\n`);
  process.exit(2);
}

function allow(): never {
  process.exit(0);
}

function main(): void {
  const raw = readAllStdin();
  const parsed = parseMutationHookInput(raw);
  if ("error" in parsed) {
    block(`pre-mutation-clean-tree: could not read hook input (${parsed.error}).`);
  }

  const mutatingTools = resolveMutatingTools(process.env);
  const toolName = parsed.tool_name;
  // A named tool this gate does not recognise as mutating is skipped, same
  // as before. A payload naming no tool at all is not skipped: see the
  // header comment for why.
  if (toolName !== undefined && toolName !== "" && !mutatingTools.has(toolName)) {
    allow();
  }

  const workingDir =
    typeof parsed.cwd === "string" && parsed.cwd !== "" ? parsed.cwd : process.cwd();

  // The phase file sits at the repository root, so the root has to be found
  // before looking for it. Reading it from the working directory meant a
  // session in a subdirectory never saw its own phase file, fell through to
  // the inherited variable, and allowed a write on a dirty tree.
  let repoRoot: string;
  try {
    repoRoot = resolveRepoRoot(workingDir);
  } catch (err) {
    block(`pre-mutation-clean-tree: ${(err as Error).message}`);
  }

  const phase = resolvePhase(process.env, repoRoot);
  if (phase && typeof phase === "object" && "error" in phase) {
    block(
      `pre-mutation-clean-tree: ${phase.error} (accepted: ${[...ACCEPTED_PHASES].join(", ")}).`,
    );
  }
  // No phase set at all means guarded. A caller that says nothing gets the
  // check, and turning it off takes an explicit "build". The other way round
  // left the gate off in every context that had not been told to switch it
  // on, which is the one context where it matters most: a reviewer session
  // nobody briefed.
  if (phase === "build") {
    allow();
  }

  // phase is "review" or "mutation-testing" from here on.
  let status;
  try {
    status = getGitStatus(repoRoot);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    block(`pre-mutation-clean-tree: git check failed, refusing to allow (${message}).`);
    return;
  }

  if (status.clean) {
    allow();
  }

  block(formatDirtyTreeMessage(status.dirtyLines));
}

main();
