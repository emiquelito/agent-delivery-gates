// Shared helpers for the pre-mutation-clean-tree hook. Kept apart from the
// hook entry point so the logic can be exercised without spawning a process,
// though the tests in this repo spawn the hook anyway to check the real
// stdin/stdout/exit-code contract an agent actually sees.

import { execFileSync } from "node:child_process";
import { readFileSync, readSync, existsSync } from "node:fs";
import { join } from "node:path";

// The tool names this gate treats as a mutation. "Edit", "Write",
// "MultiEdit", "NotebookEdit" are verified: they are the exact names Claude
// Code's own PreToolUse payload carries. Every other entry below is a guess
// at the name another coding agent gives its own file-writing tool. No
// research was available while writing this list, so none of the guesses
// are checked against a real payload from those tools; they are included
// because a name this set fails to recognise is a silent hole, and an
// extra name checked needlessly costs nothing but one comparison. Override
// with ADG_MUTATING_TOOLS (a comma separated list) when a project knows its
// agent's real tool names, see resolveMutatingTools below.
export const MUTATING_TOOLS = new Set([
  // Verified: Claude Code's own PreToolUse tool names.
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  // Guesses below, grouped loosely by what they are guesses for. None of
  // these have been checked against a real agent payload.
  // Codex CLI / OpenAI-style patch and file tools:
  "apply_patch",
  "ApplyPatch",
  "patch",
  "shell_apply_patch",
  // Generic "editor" tool names seen across various agent frameworks:
  "str_replace_editor",
  "str_replace_based_edit_tool",
  "text_editor",
  "editor",
  // Plain-English CRUD-style names some agents use for file tools:
  "create_file",
  "edit_file",
  "write_file",
  "update_file",
  "delete_file",
  "patch_file",
  "CreateFile",
  "EditFile",
  "WriteFile",
  "UpdateFile",
  "DeleteFile",
  "PatchFile",
  "FileEdit",
  "FileWrite",
  "FileCreate",
]);

/**
 * The mutating-tool set this gate actually checks against, for one run.
 * ADG_MUTATING_TOOLS, a comma separated list, replaces MUTATING_TOOLS
 * entirely when set and non-empty, for a project whose agent's tool names
 * are known and differ from every guess above. An empty entry between two
 * commas is dropped instead of kept as an empty string nothing could ever
 * match.
 */
export function resolveMutatingTools(env: Record<string, string | undefined>): Set<string> {
  const override = env.ADG_MUTATING_TOOLS;
  if (typeof override === "string" && override.trim() !== "") {
    return new Set(
      override
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== ""),
    );
  }
  return MUTATING_TOOLS;
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
