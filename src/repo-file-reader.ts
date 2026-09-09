// Reads a file named in a diff, so a check can look for the fixtures marker
// inside it. It lives here, and not in either command, because both the
// test-diff CLI and the PostToolUse hook run the same check and must answer
// the same way. They did not: the hook was written without a reader, so it
// ignored a marker the CLI honoured, which is two implementations of one
// decision, a mistake this project has now made four times.

import { openSync, readSync, closeSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { resolveWithinRoot, type PathResolver } from "./path-allowlist.ts";

/** How much of a file to read. The marker has to be near the top anyway. */
const FILE_HEAD_BYTES = 64 * 1024;

/**
 * Reads a file named in the diff, from the working tree, for the fixtures
 * marker and nothing else. The working tree copy is the one a reviewer has
 * open and the one a pre-commit run is about to commit, so that is what an
 * exemption is read from. The bound this accepts, stated plainly: pointed at
 * an older commit with --rev, the marker is still read from the file as it
 * stands now, not as it stood then, so a run over old history reports what
 * the current file is exempt from.
 *
 * A path is resolved against the repository root and refused if it lands
 * outside it, since a diff read from stdin can name any path at all. Both
 * the root and the candidate are resolved to their real paths before that
 * comparison: the root usually arrives from `git rev-parse --show-toplevel`
 * with its symlinks already resolved, so a candidate named through a
 * symlinked path used to read as outside a repository it was inside. A
 * symlink pointing out of the repository still resolves to a real path
 * outside the real root, so it stays refused. An unreadable path yields
 * undefined, which means no exemption: an exemption this command could not
 * confirm is never granted.
 */
export function makeFileTextReader(
  repoRoot: string,
  resolver: PathResolver = realpathSync,
): (path: string) => string | undefined {
  const cache = new Map<string, string | undefined>();
  // Made absolute once, so a relative repoRoot cannot be joined to itself
  // when it is also used as the directory a relative candidate resolves
  // against.
  const root = resolve(repoRoot);
  return (path: string): string | undefined => {
    const cached = cache.get(path);
    if (cached !== undefined || cache.has(path)) return cached;
    let text: string | undefined;
    const found = resolveWithinRoot(root, path, resolver, root);
    if (found.contained) {
      try {
        const fd = openSync(found.realPath, "r");
        try {
          const buf = Buffer.alloc(FILE_HEAD_BYTES);
          const read = readSync(fd, buf, 0, buf.length, 0);
          text = buf.subarray(0, read).toString("utf8");
        } finally {
          closeSync(fd);
        }
      } catch {
        text = undefined;
      }
    }
    cache.set(path, text);
    return text;
  };
}
