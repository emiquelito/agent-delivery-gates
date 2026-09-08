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
// as a reason to block, not a reason to allow.

import process from "node:process";
import {
  ACCEPTED_PHASES,
  MUTATING_TOOLS,
  formatDirtyTreeMessage,
  getGitStatus,
  parseHookInput,
  readAllStdin,
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
  const parsed = parseHookInput(raw);
  if ("error" in parsed) {
    block(`pre-mutation-clean-tree: could not read hook input (${parsed.error}).`);
  }

  if (!MUTATING_TOOLS.has(parsed.tool_name)) {
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
