// Shared helpers for the pre-mutation-clean-tree hook. Kept apart from the
// hook entry point so the logic can be exercised without spawning a process,
// though the tests in this repo spawn the hook anyway to check the real
// stdin/stdout/exit-code contract an agent actually sees.

import { execFileSync } from "node:child_process";
import { readFileSync, readSync, existsSync } from "node:fs";
import { join } from "node:path";

export const MUTATING_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export const ACCEPTED_PHASES = new Set(["review", "mutation-testing", "build"]);

export type Phase = "review" | "mutation-testing" | "build";

export interface HookInput {
  tool_name: string;
  tool_input?: unknown;
  cwd?: string;
  hook_event_name?: string;
  [key: string]: unknown;
}

/** Reads all of a stream's data and returns it as a string. */
export function readAllStdin(fd: number = 0): string {
  // A single readFileSync on fd 0 stops at the pipe buffer, about 64KB, and
  // returns what it got. A hook payload carries the whole file being written,
  // so it goes past that often. Read in a loop until EOF instead.
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(65536);
  for (;;) {
    let read: number;
    try {
      read = readSync(fd, buf, 0, buf.length, null);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") continue;
      if (code === "EOF") break;
      return chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : "";
    }
    if (read === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, read)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Parses the hook's stdin payload. Returns the parsed object on success, or
 * an error string describing why parsing failed. Never throws.
 */
export function parseHookInput(raw: string): HookInput | { error: string } {
  if (raw.trim() === "") {
    return { error: "stdin was empty" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `stdin was not valid JSON: ${message}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: "stdin JSON was not an object" };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.tool_name !== "string" || obj.tool_name === "") {
    return { error: "stdin JSON was missing a string 'tool_name' field" };
  }
  return obj as unknown as HookInput;
}

/**
 * Determines the active phase. ADG_PHASE wins when set and non-empty;
 * otherwise falls back to a trimmed single line from .claude/adg-phase under
 * repoRoot, if that file exists. Returns null when no phase is configured
 * anywhere, in which case the hook stays inactive. Returns an error string
 * when a phase was configured but is not one of the accepted values.
 */
export function resolvePhase(
  env: Record<string, string | undefined>,
  repoRoot: string,
): Phase | null | { error: string } {
  // The file wins over the variable. The variable is ambient: a session sets
  // it once and everything spawned inside inherits it, so a reviewer started
  // inside a building session would inherit "build" and switch its own gate
  // off. The file is written on purpose, in this checkout, by whoever is
  // about to review, and it is gitignored, so it stays local session state.
  let raw: string | undefined;
  let source = ".claude/adg-phase";
  const phaseFile = join(repoRoot, ".claude", "adg-phase");
  if (existsSync(phaseFile)) {
    // A file that exists and cannot be read is an error, never a reason to
    // treat the phase as unset. Failing open here would let a mutation run
    // against a dirty tree.
    try {
      raw = readFileSync(phaseFile, "utf8").split("\n")[0]?.trim();
    } catch (err) {
      return {
        error: `could not read .claude/adg-phase: ${(err as Error).message}`,
      };
    }
  }
  if (raw === undefined || raw === "") {
    raw = env.ADG_PHASE?.trim();
    source = "ADG_PHASE";
  }
  if (raw === undefined || raw === "") {
    return null;
  }
  if (!ACCEPTED_PHASES.has(raw)) {
    return {
      error: `unrecognised phase '${raw}' from ${source}; accepted values are review, mutation-testing, build`,
    };
  }
  return raw as Phase;
}

export interface GitStatusResult {
  clean: boolean;
  dirtyLines: string[];
}

/**
 * Runs `git rev-parse --show-toplevel` then `git status --porcelain` in that
 * root. Uses the default newline-delimited porcelain form, not -z: each
 * dirty entry becomes its own array element already, and this hook only
 * needs to display paths to a human on stderr, never to parse them back into
 * a shell command, so the one edge the -z form exists for (a path containing
 * a newline) does not apply here. Git quotes any path with unusual
 * characters, including a leading/trailing space or a literal quote, in C
 * style (wrapped in double quotes with escapes) when using the default form,
 * so those still render intact instead of corrupting the output.
 *
 * Throws when either git call fails, carrying the git error text.
 */
/**
 * Builds the environment for a git call with every GIT_* override removed.
 * GIT_WORK_TREE or GIT_DIR left over from an earlier command would point git
 * at a different tree, so a dirty repository would come back clean and the
 * gate would allow the mutation it exists to block.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  return env;
}

export function getGitStatus(cwd: string): GitStatusResult {
  let root: string;
  try {
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      env: gitEnv(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    throw new Error(`git rev-parse --show-toplevel failed: ${describeExecError(err)}`);
  }

  let output: string;
  try {
    output = execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      env: gitEnv(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw new Error(`git status --porcelain failed: ${describeExecError(err)}`);
  }

  const dirtyLines = output.split("\n").filter((line) => line.length > 0);
  return { clean: dirtyLines.length === 0, dirtyLines };
}

function describeExecError(err: unknown): string {
  // Both execFileSync calls pass encoding: "utf8", so on failure the error
  // object's stderr is already a decoded string, not a Buffer.
  if (err && typeof err === "object") {
    const e = err as { stderr?: string; message?: string };
    if (typeof e.stderr === "string" && e.stderr.trim() !== "") {
      return e.stderr.trim();
    }
    if (e.message) return e.message;
  }
  return String(err);
}

const MAX_LISTED_DIRTY_PATHS = 20;

/** Builds the stderr message for a dirty tree, capping the listed paths. */
export function formatDirtyTreeMessage(dirtyLines: string[]): string {
  const shown = dirtyLines.slice(0, MAX_LISTED_DIRTY_PATHS);
  const remaining = dirtyLines.length - shown.length;
  const lines = [
    "pre-mutation-clean-tree: the working tree is not clean.",
    "Commit the work before this phase mutates anything: a reviewer's checkout can destroy uncommitted work with no ground truth left.",
    "Dirty paths (porcelain status code, then path):",
    ...shown.map((line) => `  ${line}`),
  ];
  if (remaining > 0) {
    lines.push(`  ...and ${remaining} more`);
  }
  return lines.join("\n");
}
