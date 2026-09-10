#!/usr/bin/env node
// PostToolUse hook wrapper around the vendor-neutral test diff separator.
// What identifies a commit is that tool_input.command runs `git commit`,
// whichever tool ran it: this file does not require tool_name to be
// "Bash", or to be present at all, so it keys on the command text alone
// and still ignores a call that carries no command. When it acts, it
// separates HEAD's diff and, if there are weakening signals, exits 2 with
// the report on stderr so the agent sees it right after the commit it just
// made.
//
// Contract: exit 0 lets the agent continue. Exit 2 reports signals, or any
// operational failure, on stderr. This file knows only how a PostToolUse
// hook receives its payload and how to recognise a commit; all detection
// logic lives in ../src/test-diff-separator.ts.

import process from "node:process";
import { readAllStdin } from "../src/hook-io.ts";
import { execFileSync } from "node:child_process";
import { readSync } from "node:fs";
import { formatSignalText, separateTestDiffWarmed, type RuleSet } from "../src/test-diff-separator.ts";
import { makeFileTextReader } from "../src/repo-file-reader.ts";
import { ConfigError, loadRuleSet, resolveConfigPath } from "../src/test-diff-config.ts";

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

async function main(): Promise<void> {
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
  const toolInput = payload.tool_input as Record<string, unknown> | undefined;
  const command = typeof toolInput?.command === "string" ? toolInput.command : "";
  if (!runsGitCommit(command)) {
    process.exit(0);
  }

  const cwd = typeof payload.cwd === "string" && payload.cwd !== "" ? payload.cwd : process.cwd();

  // The same rules config a person configures for the standalone CLI, so
  // this hook, the one that actually gates a commit, sees what they
  // configured instead of only ever running on the built-in defaults.
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
      block(`test-diff-post-tool-hook: config: ${err.message}`);
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
    const detail = typeof e.stderr === "string" && e.stderr.trim() !== "" ? e.stderr.trim() : e.message ?? String(err);
    block(`test-diff-post-tool-hook: the gate could not run, so nothing was checked: could not read HEAD's diff (${detail}).`);
    return;
  }

  // The same reader the test-diff command uses, so a file carrying the
  // fixtures marker is answered the same way by both. Without it this hook
  // reported signals the command had already been told to leave alone.
  const readFileText = repoRoot === undefined ? undefined : makeFileTextReader(repoRoot);
  // separateTestDiffWarmed warms the Python language service ahead of the
  // plain synchronous separateTestDiff call, so a .py file in this diff
  // gets the tree-sitter mask instead of the regex fallback silently.
  const result = await separateTestDiffWarmed(diffText, { rules, readFileText });
  if (result.signals.length === 0) {
    process.exit(0);
  }

  const lines = [
    `test-diff-post-tool-hook: the gate ran and found ${result.signals.length} weakening signal(s) in this commit:`,
    ...result.signals.map((s) => `  ${formatSignalText(s)}`),
  ];
  block(lines.join("\n"));
}

main().catch((err) => {
  // main() became async once it had to warm the Python language service
  // before separating a diff that touches a .py file, and a call with no
  // `.catch` on it hands a rejection to Node's own default handling: exit
  // 1, with the raw stack trace on stderr, which is a code this hook does
  // not document and which an agent reading exit status can mistake for
  // "continue". The documented contract is exit 0 to continue and exit 2
  // for a signal or any operational failure; an uncaught async failure is
  // exactly that, and belongs on the same exit code as every other
  // operational failure block() already reports.
  block(`test-diff-post-tool-hook: internal error: ${(err as Error).message}`);
});
