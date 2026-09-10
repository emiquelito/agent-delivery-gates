#!/usr/bin/env node
// Runs hooks/test-diff-separator.ts, old implementation and new, over every
// commit in this repository's own history, and diffs the signals each one
// reports. This is the evidence the whole-file mask context phase (see
// src/test-diff-separator.ts's `readWholeFile` option) is required to
// produce: a signal that stops firing is a detection regression, and a
// signal that starts firing is only acceptable when it is correct.
//
// Not part of `npm test` or `npm run verify`: 160-odd commits, each run
// through two full CLI invocations (grammar warm-up included where a
// commit touches a tree-sitter-backed language), takes tens of seconds --
// too slow to run on every commit this repository's own history keeps
// growing. Run it by hand:
//
//   node scripts/test-diff-whole-file-history-diff.ts --old-worktree PATH
//
// --old-worktree PATH points at a worktree checked out to the commit
// before this phase (the "old" implementation, with no readWholeFile
// option at all). This script never creates or removes a worktree itself,
// so the comparison stays reproducible from a plain commit reference:
//
//   git worktree add /tmp/adg-old-impl <commit-before-this-phase>
//   ln -s "$PWD/node_modules" /tmp/adg-old-impl/node_modules
//   node scripts/test-diff-whole-file-history-diff.ts --old-worktree /tmp/adg-old-impl
//
// The symlink matters: a worktree checks out tracked files only, and
// node_modules is not tracked. Sharing this repository's own node_modules
// is safe here because this phase adds no new dependency of any kind
// (package.json's own devDependencies list is unchanged).

import process from "node:process";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

interface Signal {
  id: string;
  severity: string;
  file: string;
  line: string;
  message: string;
}

interface SeparateResultJson {
  signals: Signal[];
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  return env;
}

function listCommits(cwd: string): string[] {
  const out = execFileSync("git", ["log", "--format=%H", "--reverse"], {
    cwd,
    env: gitEnv(),
    encoding: "utf8",
  });
  return out.split("\n").filter((line) => line.trim() !== "");
}

/** Runs one implementation's CLI against one commit, and parses its JSON
 * output. execFileSync throws on any non-zero exit, which includes exit 1
 * (signals found -- an ordinary, expected outcome this script needs to
 * read, not a failure) as well as exit 2 (could not run as asked, a real
 * hard failure: a commit this tool could not classify at all is not a "no
 * signals" answer and must not be read as one). Exit 1's own stdout still
 * carries the full JSON report, so it is parsed the same as exit 0's;
 * exit 2 is re-thrown as a real failure for this script to stop on. */
function runOne(cliPath: string, repoCwd: string, rev: string): SeparateResultJson {
  try {
    const result = execFileSync("node", [cliPath, "--rev", rev, "--format", "json"], {
      cwd: repoCwd,
      env: gitEnv(),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return JSON.parse(result) as SeparateResultJson;
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    if (e.status === 1 && typeof e.stdout === "string" && e.stdout.trim() !== "") {
      return JSON.parse(e.stdout) as SeparateResultJson;
    }
    throw new Error(
      `${cliPath} --rev ${rev} failed (exit ${e.status ?? "?"}): ${(e.stderr ?? "").trim() || (err as Error).message}`,
    );
  }
}

/** A signal's identity for set comparison: same finding, reported once,
 * matching the identity hooks/test-diff-separator.ts's own signalKey uses
 * for its wide/narrow merge. */
function signalKey(signal: Signal): string {
  return `${signal.id} ${signal.file} ${signal.line} ${signal.message}`;
}

interface CommitDiff {
  rev: string;
  onlyNew: Signal[];
  onlyOld: Signal[];
}

function parseArgs(argv: string[]): { oldWorktree: string; limit: number | null } {
  let oldWorktree = "";
  let limit: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--old-worktree") {
      oldWorktree = argv[++i] ?? "";
    } else if (argv[i] === "--limit") {
      limit = Number(argv[++i]);
    }
  }
  if (oldWorktree === "") {
    process.stderr.write("usage: test-diff-whole-file-history-diff.ts --old-worktree PATH [--limit N]\n");
    process.exit(2);
  }
  return { oldWorktree: resolve(oldWorktree), limit };
}

function main(): void {
  const { oldWorktree, limit } = parseArgs(process.argv.slice(2));
  const newCli = resolve("hooks/test-diff-separator.ts");
  const oldCli = resolve(oldWorktree, "hooks/test-diff-separator.ts");
  if (!existsSync(newCli)) throw new Error(`not found: ${newCli} (run from the repository root)`);
  if (!existsSync(oldCli)) throw new Error(`not found: ${oldCli} (is --old-worktree pointed at a real worktree?)`);

  let commits = listCommits(process.cwd());
  if (limit !== null) commits = commits.slice(-limit);

  let identical = 0;
  const diffs: CommitDiff[] = [];

  for (const rev of commits) {
    const oldResult = runOne(oldCli, oldWorktree, rev);
    const newResult = runOne(newCli, process.cwd(), rev);

    const oldKeys = new Map(oldResult.signals.map((s) => [signalKey(s), s]));
    const newKeys = new Map(newResult.signals.map((s) => [signalKey(s), s]));

    const onlyNew = [...newKeys.entries()].filter(([k]) => !oldKeys.has(k)).map(([, s]) => s);
    const onlyOld = [...oldKeys.entries()].filter(([k]) => !newKeys.has(k)).map(([, s]) => s);

    if (onlyNew.length === 0 && onlyOld.length === 0) {
      identical++;
    } else {
      diffs.push({ rev, onlyNew, onlyOld });
    }
  }

  process.stdout.write(`\nCommits compared: ${commits.length}\n`);
  process.stdout.write(`Identical signals: ${identical}\n`);
  process.stdout.write(`Commits with a difference: ${diffs.length}\n\n`);

  for (const d of diffs) {
    process.stdout.write(`--- ${d.rev} ---\n`);
    for (const s of d.onlyNew) {
      process.stdout.write(`  + NEW ONLY: ${s.id} ${s.severity} ${s.file}: ${s.message}\n    ${s.line}\n`);
    }
    for (const s of d.onlyOld) {
      process.stdout.write(`  - OLD ONLY: ${s.id} ${s.severity} ${s.file}: ${s.message}\n    ${s.line}\n`);
    }
  }
}

main();
