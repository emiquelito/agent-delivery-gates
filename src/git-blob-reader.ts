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
 * The two-dot and three-dot forms are not told apart here. Git's own
 * three-dot meaning -- diff against the merge-base of A and B, not A
 * itself -- is not reproduced; the old side is read from A directly. Where
 * that disagrees with the actual pre-image, `maskDiffLine`'s own
 * raw-text check in src/test-diff-separator.ts catches the mismatch line
 * by line and falls back to per-line masking for exactly the lines it
 * disagrees on, so a three-dot range degrades gracefully instead of
 * masking the wrong file's text as if it were right.
 */
export function splitRange(range: string): { oldRev: string; newRev: string } | null {
  const idx = range.indexOf("..");
  if (idx === -1) return null;
  const oldRev = range.slice(0, idx);
  let rest = range.slice(idx + 2);
  if (rest.startsWith(".")) rest = rest.slice(1); // the range's third dot, if any
  if (oldRev === "" || rest === "") return null;
  return { oldRev, newRev: rest };
}
