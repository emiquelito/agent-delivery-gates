// Reads a file's whole content as it stood on one side of a diff, through
// `git show <rev>:<path>`. This is what src/test-diff-separator.ts's
// `readWholeFile` option needs: a changed file masked once, as a whole,
// instead of one diff line at a time (see that file's own header on
// `FileMaskContext` for why, and src/code-mask.ts's file header for the
// limit this closes). Every production caller of separateTestDiff already
// knows which two revisions bound the diff it built -- a commit's parent
// and the commit itself, a range's two ends, HEAD and the index for
// --staged -- so this is the one place that turns "old"/"new" into the
// right `git show` argument, instead of four copies of the same git call
// (the CLI, the PostToolUse hook, src/agent-adapter.ts, src/mcp-server.ts)
// drifting apart the way this project's own gitEnv() helper already has.

import { execFileSync } from "node:child_process";

/**
 * Builds a readWholeFile function bound to two fixed revisions: `oldRev`
 * for the "old" side (a removed line's pre-image), `newRev` for the "new"
 * side (an added line's post-image). Either may be null, meaning that side
 * has no revision to read from at all -- a root commit has no parent, so
 * its "old" side is null; nothing here invents one, and every lookup on
 * that side answers undefined without ever calling git. `newRev` of ""
 * (the empty string) is git's own way of naming the index, used for a
 * --staged diff: `git show :path` reads the staged content, not a commit.
 *
 * A path that does not exist at that revision (the file was added,
 * deleted, or renamed on this side), a revision that does not resolve, or
 * any other git failure all read the same: undefined, so the caller falls
 * back to masking the one diff line it has instead of throwing an
 * operational failure over a gap src/test-diff-separator.ts already has a
 * safe answer for.
 *
 * Every answer is cached per path and side for the life of the returned
 * function, since one whole file is read from git at most once regardless
 * of how many of its own diff lines ask to be masked against it.
 */
export function makeGitWholeFileReader(opts: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  oldRev: string | null;
  newRev: string | null;
}): (path: string, side: "old" | "new") => string | undefined {
  const cache = new Map<string, string | undefined>();
  return (path: string, side: "old" | "new"): string | undefined => {
    const rev = side === "old" ? opts.oldRev : opts.newRev;
    if (rev === null) return undefined;
    const key = `${side} ${path}`;
    if (cache.has(key)) return cache.get(key);
    let text: string | undefined;
    try {
      text = execFileSync("git", ["show", `${rev}:${path}`], {
        cwd: opts.cwd,
        env: opts.env,
        encoding: "utf8",
        // A whole file, not a diff line: large enough for a large real
        // source file (a generated file, a bundled asset) without being
        // unbounded. Exceeding this reads as a git failure below, the
        // same as any other file this side cannot supply.
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      text = undefined;
    }
    cache.set(key, text);
    return text;
  };
}

/**
 * Splits a `git diff`-style range argument ("A..B" or "A...B") into its two
 * endpoints, for a caller that has the range as one string (--range on the
 * CLI, `range` on the MCP tool) but needs the two revisions separately to
 * build a whole-file reader. Returns null for a string with no ".." in it
 * at all, which reads as "cannot supply whole-file context for this diff",
 * not as a parse error: the range still goes to `git diff` exactly as
 * typed, unaffected by anything this function decides.
 *
 * `threeDot` says which form was given. Git's own three-dot meaning --
 * diff against the merge-base of A and B, not A itself -- is not decided
 * here: this function only parses the string. A caller building a
 * whole-file reader for a three-dot range must resolve the merge base
 * itself (see `resolveMergeBase` below) and read the old side from THAT
 * revision, not from `oldRev` as returned here; reading `oldRev` directly
 * for a three-dot range answers the wrong pre-image for any file that
 * diverged before the merge base.
 */
export function splitRange(range: string): { oldRev: string; newRev: string; threeDot: boolean } | null {
  const idx = range.indexOf("..");
  if (idx === -1) return null;
  const oldRev = range.slice(0, idx);
  let rest = range.slice(idx + 2);
  const threeDot = rest.startsWith(".");
  if (threeDot) rest = rest.slice(1); // the range's third dot
  if (oldRev === "" || rest === "") return null;
  return { oldRev, newRev: rest, threeDot };
}

/**
 * Resolves the merge base of `oldRev` and `newRev`, through `git
 * merge-base`, for a caller building a whole-file reader over a three-dot
 * range (see `splitRange`'s own doc above for why the merge base, not
 * `oldRev` itself, is the correct old side there). Returns undefined on
 * any git failure -- the two revisions share no common ancestor, either
 * fails to resolve, or git itself is unavailable -- so a caller can fall
 * back to reading no old side at all (`oldRev: null` on
 * `makeGitWholeFileReader`) instead of trusting a wrong one. That fallback
 * is not silent: every line it would have answered instead falls through
 * to src/test-diff-separator.ts's own per-line masking, which is counted
 * in `SeparateResult.wholeFileMaskFallbackCount`.
 */
export function resolveMergeBase(
  oldRev: string,
  newRev: string,
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): string | undefined {
  try {
    return execFileSync("git", ["merge-base", oldRev, newRev], {
      cwd: opts.cwd,
      env: opts.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * `splitRange`, with a three-dot range's old side already turned into the
 * merge base (see `resolveMergeBase` above), so a caller that only wants
 * the two revisions to build a whole-file reader from never has to branch
 * on `threeDot` itself. Returns null exactly when `splitRange` would (no
 * ".." in the string, or either side empty). For a three-dot range whose
 * merge base could not be resolved, `oldRev` comes back null -- no old
 * side to read from at all -- instead of the wrong revision; the old side
 * of every removed line then falls back to per-line masking, counted in
 * `SeparateResult.wholeFileMaskFallbackCount`, exactly as a caller that
 * had no reader to build in the first place already degrades.
 */
export function resolveRangeRevisions(
  range: string,
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): { oldRev: string | null; newRev: string } | null {
  const split = splitRange(range);
  if (split === null) return null;
  if (!split.threeDot) return { oldRev: split.oldRev, newRev: split.newRev };
  const base = resolveMergeBase(split.oldRev, split.newRev, opts);
  return { oldRev: base ?? null, newRev: split.newRev };
}
