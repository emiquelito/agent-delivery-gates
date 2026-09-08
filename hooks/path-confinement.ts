#!/usr/bin/env node
// PreToolUse hook: blocks a mutating or reading tool call whose path resolves
// outside an explicit allowlist. Guards Read, Write, Edit, MultiEdit, and
// NotebookEdit.
//
// Bash is not covered. A shell command's filesystem effects cannot be read
// reliably from its text, `cat ../../x` and `rm -rf $VAR` both look like
// ordinary strings, so this hook does not try. That is a known limit of what
// a PreToolUse hook can check here, not an oversight.
//
// Contract: exit 0 allows the tool call. Exit 2 blocks it and stderr is
// shown to the agent. Any other non-zero exit is read as non-blocking, so
// every deliberate refusal in this file uses exit 2, never a bare throw.
// This hook never fails open: any input it cannot make sense of, or any
// failure resolving the repository root or a path, is a reason to block.

import process from "node:process";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter } from "node:path";
import { checkPathAllowed } from "../src/path-allowlist.ts";
import { readAllStdin, parseHookInput,
  isMutatingTool,
} from "../src/clean-tree-gate.ts";

// Reads as well as writes, because this gate is about where a tool is
// looking, not only where it is writing. The mutating names come from the
// shared set so this gate does not go stale on a platform the others already
// handle: it was keyed to one agent's names while the other two gates had
// moved on, and it silently allowed a path outside every root whenever the
// tool was called something else.
const READ_TOOLS = ["Read", "read_file", "ReadFile", "view", "cat_file", "open_file"];

function isCheckedTool(name: string, env: Record<string, string | undefined>): boolean {
  return READ_TOOLS.includes(name) || isMutatingTool(name, env);
}

function block(message: string): never {
  process.stderr.write(message.endsWith("\n") ? message : `${message}\n`);
  process.exit(2);
}

function allow(): never {
  process.exit(0);
}

/** Strips every GIT_* override before calling git, the way
 * src/clean-tree-gate.ts does. A leftover GIT_WORK_TREE or GIT_DIR from an
 * earlier command would point git at a different tree, so the repository
 * root this hook trusts could be the wrong one entirely. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  return env;
}

function resolveRepoRoot(cwd: string): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    env: gitEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Pulls the candidate path out of a tool_input payload. The three tools
 * this hook checks carry it under different keys: file_path for Read, Write,
 * Edit and MultiEdit; notebook_path for NotebookEdit; path as a fallback for
 * any of them. */
function extractPath(toolInput: unknown): string | undefined {
  if (typeof toolInput !== "object" || toolInput === null) return undefined;
  const obj = toolInput as Record<string, unknown>;
  for (const key of ["file_path", "notebook_path", "path"]) {
    const value = obj[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

function main(): void {
  const raw = readAllStdin();
  const parsed = parseHookInput(raw);
  if ("error" in parsed) {
    block(`path-confinement: could not read hook input (${parsed.error}).`);
  }

  if (!isCheckedTool(parsed.tool_name, process.env)) {
    // Bash included: its filesystem effects live inside a command string,
    // not a structured path field, so there is nothing here to check.
    allow();
  }

  const candidate = extractPath(parsed.tool_input);
  if (candidate === undefined) {
    block(
      `path-confinement: tool '${parsed.tool_name}' is checked but carried no recognisable path (file_path, notebook_path, or path).`,
    );
  }

  const workingDir =
    typeof parsed.cwd === "string" && parsed.cwd !== "" ? parsed.cwd : process.cwd();

  let repoRoot: string;
  try {
    repoRoot = resolveRepoRoot(workingDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    block(`path-confinement: could not resolve the repository root (${message}).`);
    return;
  }

  const roots = [repoRoot, tmpdir()];
  const extraRoots = process.env.ADG_ALLOWED_ROOTS;
  if (typeof extraRoots === "string" && extraRoots !== "") {
    for (const root of extraRoots.split(delimiter)) {
      if (root !== "") roots.push(root);
    }
  }

  // checkPathAllowed never throws: a path it cannot resolve comes back as a
  // denied decision carrying its own message, which block() below reports.
  const decision = checkPathAllowed(candidate, roots, realpathSync, workingDir);

  if (decision.allowed) {
    allow();
  }

  block(decision.message);
}

main();
