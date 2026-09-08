// Shared helpers for the pre-mutation-clean-tree hook. Kept apart from the
// hook entry point so the logic can be exercised without spawning a process,
// though the tests in this repo spawn the hook anyway to check the real
// stdin/stdout/exit-code contract an agent actually sees.

import { execFileSync } from "node:child_process";
import { readFileSync, readSync, existsSync } from "node:fs";
import { join } from "node:path";

// The tool names this gate treats as a mutation. This is the one place that
// decision is made: every hook and every platform adapter in this project
// calls isMutatingTool below instead of keeping its own copy, because two
// copies of this same decision have already drifted apart three times.
//
// VERIFIED_MUTATING_TOOLS carries only names checked against a real agent
// payload:
//   - "Edit", "Write", "MultiEdit", "NotebookEdit" are Claude Code's own
//     PreToolUse tool names.
//   - "apply_patch" is Codex's file-edit tool name. Codex's own matcher
//     config for a hook may be written as apply_patch, Edit, or Write, but
//     the payload it actually sends always reports tool_name: "apply_patch"
//     for a file edit (and "Bash" for a shell call, which this project does
//     not treat as a mutation to guard here; see hooks/path-confinement.ts's
//     own header for why Bash is out of scope for a path check).
//   - "unified_exec" is Codex's other tool that takes part in hooks: one
//     tool for running a shell command and reading its output.
// A name outside this list, for an agent nobody has checked a real payload
// from yet, falls to MUTATING_TOOL_HEURISTIC below instead of being
// invented and added here. An invented name that turns out wrong is not
// free: it is a chance to guard something that was never a mutation, and
// this project has already recorded that a noisy gate gets switched off.
export const VERIFIED_MUTATING_TOOLS = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "apply_patch",
  "unified_exec",
]);

// A heuristic for a tool name outside the verified list: anything that
// reads like a write, edit, delete, create, or notebook tool. This is a
// guess, not evidence, about naming across agent frameworks; it exists
// because a name this gate has never seen still needs a verdict, and erring
// toward guarding is the safer direction for a gate whose purpose is to
// stop a destructive mutation. isMutatingTool below checks the verified
// list OR this pattern, so a verified name still matches even where it
// happens not to fit this wording (apply_patch and unified_exec, for
// instance, match neither "edit" nor "write").
export const MUTATING_TOOL_HEURISTIC = /write|edit|delete|create|notebook/i;

/**
 * Whether one tool name counts as a mutation, for one run. ADG_MUTATING_TOOLS,
 * a comma separated list, replaces both the verified list and the heuristic
 * entirely when set and non-empty: a project that knows its agent's real
 * tool names gets an exact match against only those names, with no guessing
 * layered on top. An empty entry between two commas is dropped instead of
 * kept as an empty string nothing could ever match.
 *
 * With no override, a name matches when it is in VERIFIED_MUTATING_TOOLS or
 * matches MUTATING_TOOL_HEURISTIC.
 */
export function isMutatingTool(name: string, env: Record<string, string | undefined>): boolean {
  const override = resolveMutatingToolsOverride(env);
  if (override !== null) return override.has(name);
  return VERIFIED_MUTATING_TOOLS.has(name) || MUTATING_TOOL_HEURISTIC.test(name);
}

/**
 * Parses ADG_MUTATING_TOOLS into an explicit override set, or null when it
 * is unset or empty, meaning no override is active.
 */
function resolveMutatingToolsOverride(env: Record<string, string | undefined>): Set<string> | null {
  const override = env.ADG_MUTATING_TOOLS;
  if (typeof override !== "string" || override.trim() === "") return null;
  return new Set(
    override
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name !== ""),
  );
}

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

export interface MutationHookInput {
  tool_name?: string;
  tool_input?: unknown;
  cwd?: string;
  hook_event_name?: string;
  [key: string]: unknown;
}

/**
 * Parses stdin for the mutation gate specifically. Unlike parseHookInput
 * above, tool_name is optional here on purpose: this gate has to run under
 * more than one agent, whose exact payload fields past the JSON envelope
 * are not guaranteed, and a payload with no tool_name at all still needs a
 * verdict instead of an early exit. Still errors on empty stdin, invalid
 * JSON, or a payload that is not an object; those aren't "unknown tool",
 * they're "no usable payload".
 */
export function parseMutationHookInput(raw: string): MutationHookInput | { error: string } {
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
  if (obj.tool_name !== undefined && typeof obj.tool_name !== "string") {
    return { error: "stdin JSON had a non-string 'tool_name' field" };
  }
  return obj as MutationHookInput;
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

/**
 * The repository root for a working directory. The phase file lives at the
 * root, so a session running in a subdirectory has to resolve the root before
 * looking for it. Reading it from the working directory meant a session in a
 * subdirectory could not see its own phase file.
 */
export function resolveRepoRoot(cwd: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      env: gitEnv(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    throw new Error(`git rev-parse --show-toplevel failed: ${describeExecError(err)}`);
  }
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

/**
 * The porcelain lines that report a change git has not been told about: an
 * unstaged modification or deletion, an unmerged path, or an untracked
 * file. In `git status --porcelain` each line starts with two status
 * letters, the index state then the working-tree state, so a line whose
 * second letter is a space is staged and nothing more. An untracked line
 * ("??") counts here as well: a restore has no committed copy of it to
 * fall back on.
 *
 * `adg mutate --staged` is the one caller. Its job is to mutate the staged
 * diff, so a staged change is what it was asked to work on, while an
 * unstaged edit sitting under it is work no commit holds and work this
 * tool would overwrite. Every other caller wants the whole tree clean and
 * uses getGitStatus directly.
 */
export function unstagedDirtyLines(dirtyLines: string[]): string[] {
  return dirtyLines.filter((line) => {
    if (line.startsWith("??")) return true;
    const worktreeState = line[1];
    return worktreeState !== undefined && worktreeState !== " ";
  });
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
