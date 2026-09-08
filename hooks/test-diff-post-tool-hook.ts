#!/usr/bin/env node
// Claude Code PostToolUse hook wrapper around the vendor-neutral test diff
// separator. Only acts on a Bash tool call that ran `git commit`; anything
// else exits 0 silently. When it acts, it separates HEAD's diff and, if
// there are weakening signals, exits 2 with the report on stderr so the
// agent sees it right after the commit it just made.
//
// Contract: exit 0 lets the agent continue. Exit 2 reports signals, or any
// operational failure, on stderr. This file knows only how a PostToolUse
// hook receives its payload and how to recognise a commit; all detection
// logic lives in ../src/test-diff-separator.ts.

import process from "node:process";
import { readAllStdin } from "../src/hook-io.ts";
import { execFileSync } from "node:child_process";
import { readSync } from "node:fs";
import { formatSignalText, separateTestDiff } from "../src/test-diff-separator.ts";

function block(message: string): never {
  process.stderr.write(message.endsWith("\n") ? message : `${message}\n`);
  process.exit(2);
}


/** A command "runs a git commit" when `git commit` appears as its own words, not inside a longer word or path. */
function runsGitCommit(command: string): boolean {
  return /(^|[;&|]|\s)git\s+commit(\s|$)/.test(command);
}

/**
 * Builds the environment for a git call with every GIT_* override removed,
 * the same way src/clean-tree-gate.ts does: a leftover GIT_DIR or
 * GIT_WORK_TREE would point git at a different tree than the commit that
 * just happened, so the wrong diff would be checked without ever failing.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  return env;
}

function main(): void {
  const raw = readAllStdin();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    block(`test-diff-post-tool-hook: stdin was not valid JSON (${(err as Error).message}).`);
    return;
  }

  // A payload of literal null parses fine and then throws on any property
  // read, which exited 1 with a stack trace. A hook must never exit on a code
  // it does not define.
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    block("hook input was not a JSON object");
  }
  if (payload.tool_name !== "Bash") {
    process.exit(0);
  }
  const toolInput = payload.tool_input as Record<string, unknown> | undefined;
  const command = typeof toolInput?.command === "string" ? toolInput.command : "";
  if (!runsGitCommit(command)) {
    process.exit(0);
  }

  const cwd = typeof payload.cwd === "string" && payload.cwd !== "" ? payload.cwd : process.cwd();

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
    const detail = typeof e.stderr === "string" && e.stderr.trim() !== "" ? e.stderr.trim() : e.message ?? String(err);
    block(`test-diff-post-tool-hook: the gate could not run, so nothing was checked: could not read HEAD's diff (${detail}).`);
    return;
  }

  const result = separateTestDiff(diffText);
  if (result.signals.length === 0) {
    process.exit(0);
  }

  const lines = [
    `test-diff-post-tool-hook: the gate ran and found ${result.signals.length} weakening signal(s) in this commit:`,
    ...result.signals.map((s) => `  ${formatSignalText(s)}`),
  ];
  block(lines.join("\n"));
}

main();
