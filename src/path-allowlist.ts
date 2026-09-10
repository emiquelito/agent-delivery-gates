// Decision logic for the path-confinement hook. Kept apart from the hook
// entry point so it can be exercised without a filesystem: the resolver that
// turns a path into its real path is injected, never called directly from
// node:fs, so a test can hand it a fake and the hook can hand it the real
// one.
//
// Confinement here is canonical, not lexical. A candidate path can look
// inside an allowed root while a symlink somewhere in it points outside, so
// every comparison happens after resolving real paths, never on the strings
// as typed. See rules/standing-adversarial-self-review.json, which names
// exactly this defect: a containment check that only inspects the path
// string is wrong because a symlink can point it somewhere else.

import { dirname, basename, join, resolve, sep } from "node:path";

/** Check ids this core can produce, as a union in the same form
 * tests/catalog-code-seam.test.ts reads out of report-validator.ts and
 * test-diff-separator.ts, so the same seam test can tie this file's checks
 * back to the rule record that owns them. */
export type CheckId = "path-allowlist-confinement";

/** Turns a path into its real, symlink-free form. Throws when the path does
 * not exist, the same contract as node:fs's realpathSync. Injected so the
 * core stays testable without touching a filesystem. */
export type PathResolver = (path: string) => string;

export interface PathAllowlistDecision {
  allowed: boolean;
  /** The check id a denial is reported under, for tracing a finding back to
   * rules/filesystem-allowlist.json. Present on every decision, allowed or
   * not, so a caller never has to special-case reading it. */
  checkId: CheckId;
  /** The candidate exactly as given. */
  candidate: string;
  /** The real path the candidate resolved to, existing ancestor plus any
   * not-yet-created remainder. */
  realPath: string;
  /** The allowed roots, resolved to their real paths, in the order given. */
  roots: string[];
  /** A message usable by a human: what was asked for, where it actually
   * points, and what the roots are. */
  message: string;
}

/** Splits an absolute path into non-empty segments, so a trailing separator
 * or the root itself never produces a spurious empty segment. */
function segmentsOf(path: string): string[] {
  return path.split(sep).filter((segment) => segment.length > 0);
}

/** True when every segment of `outer` appears, in order, at the start of
 * `inner`'s segments. A string-prefix comparison would let "/repo-evil"
 * count as inside "/repo"; comparing whole segments never does. An
 * ancestor of `outer` (fewer segments than `outer`) is denied without a
 * separate length check: `innerSegments[i]` is `undefined` past the end of
 * a shorter array, which never `===` a real segment, so `.every` already
 * returns false on its own. */
function isWithin(outerSegments: string[], innerSegments: string[]): boolean {
  return outerSegments.every((segment, i) => innerSegments[i] === segment);
}

/**
 * Resolves an absolute path to its real form, walking up to the nearest
 * existing ancestor when the path itself does not exist yet, then
 * reattaching the remainder unresolved.
 *
 * This is what lets a not-yet-created file inside an allowed root pass (a
 * Write creates the file, so it cannot exist beforehand) while still
 * catching a candidate whose parent directory is a symlink pointing outside
 * an allowed root, because that parent is the ancestor that resolves.
 */
/**
 * Best-effort realpath of `cwd` itself, before it is ever joined onto a
 * relative candidate.
 *
 * `cwd` always exists (a process cannot run from a directory that is
 * gone), so this only ever changes its spelling, never its meaning. It
 * matters on Windows, where the directory a process was launched into can
 * still carry an 8.3 short name (`RUNNER~1`) that `process.cwd()` reports
 * back verbatim, while a root read from git (`git rev-parse
 * --show-toplevel`) comes back already expanded to its long form
 * (`runneradmin`). A relative candidate resolved against the short form
 * and a root resolved through the long form are two spellings of the same
 * directory, and `isWithin`'s segment comparison treats them as
 * unrelated. Realpathing `cwd` first, before either side of the
 * comparison is built, closes that gap at its source instead of chasing
 * it through every caller.
 */
function realCwd(cwd: string, resolver: PathResolver): string {
  try {
    return resolver(cwd);
  } catch {
    return cwd;
  }
}

function resolveRealOrPending(absPath: string, resolver: PathResolver): string {
  const pendingFromLeaf: string[] = [];
  let current = absPath;
  for (;;) {
    try {
      const real = resolver(current);
      return pendingFromLeaf.length > 0 ? join(real, ...pendingFromLeaf) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        // Walked all the way to the filesystem root and even that could not
        // be resolved. Nothing left to fall back to.
        throw new Error(`no ancestor of '${absPath}' could be resolved`);
      }
      pendingFromLeaf.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * Decides whether `candidate` is allowed under `allowedRoots`. `cwd` is used
 * to resolve a relative candidate; `resolver` turns a path into its real
 * path and is the only thing here that touches a filesystem, so it is
 * always supplied by the caller.
 *
 * An empty root list denies every candidate: nothing was ever allowlisted.
 */
export function checkPathAllowed(
  candidate: string,
  allowedRoots: readonly string[],
  resolver: PathResolver,
  cwd: string,
): PathAllowlistDecision {
  // path.resolve normalizes ".." segments and, given an absolute candidate,
  // ignores cwd entirely (an absolute second argument short-circuits it), so
  // this handles both the relative and the absolute case in one call.
  const resolvedCwd = realCwd(cwd, resolver);
  const absCandidate = resolve(resolvedCwd, candidate);

  let realPath: string;
  try {
    realPath = resolveRealOrPending(absCandidate, resolver);
  } catch (err) {
    return {
      allowed: false,
      checkId: "path-allowlist-confinement",
      candidate,
      realPath: absCandidate,
      roots: [],
      message: `path-allowlist: could not resolve '${candidate}' (${(err as Error).message}).`,
    };
  }

  const resolvedRoots: string[] = [];
  for (const root of allowedRoots) {
    const absRoot = resolve(resolvedCwd, root);
    try {
      resolvedRoots.push(resolveRealOrPending(absRoot, resolver));
    } catch {
      // A root that cannot be resolved at all (does not exist, broken
      // symlink) grants nothing. It is left out of the comparison rather
      // than treated as an error: an operator may list roots defensively
      // that are not present on every machine.
      continue;
    }
  }

  const candidateSegments = segmentsOf(realPath);
  const allowed = resolvedRoots.some((root) => isWithin(segmentsOf(root), candidateSegments));

  const rootsText = resolvedRoots.length > 0 ? resolvedRoots.join(", ") : "(none)";
  const message = allowed
    ? `path-allowlist: '${candidate}' resolves to '${realPath}', inside an allowed root.`
    : `path-allowlist: '${candidate}' resolves to '${realPath}', which is outside every allowed root. Allowed roots: ${rootsText}.`;

  return {
    allowed,
    checkId: "path-allowlist-confinement",
    candidate,
    realPath,
    roots: resolvedRoots,
    message,
  };
}

// --- The shared containment helper -------------------------------------------

export interface ContainmentResult {
  /** Whether the candidate's real path is inside the root's real path. */
  contained: boolean;
  /** The root, resolved to its real path. Falls back to the lexically
   * resolved root when nothing along it exists. */
  realRoot: string;
  /** The candidate, resolved to its real path: nearest existing ancestor
   * plus any not-yet-created remainder. Falls back to the lexically
   * resolved candidate when nothing along it exists. */
  realPath: string;
}

/**
 * Decides whether `candidate` sits inside `root`, comparing the real paths
 * of both sides and never the strings as typed.
 *
 * Both sides matter. `git rev-parse --show-toplevel` hands back a root with
 * every symlink already resolved, while a path a caller typed carries
 * whatever links it was reached through, so resolving only the candidate
 * still leaves the two halves written in different alphabets. On macOS that
 * is not a corner: /tmp and /var/folders are links into /private, so every
 * scratch repository under a temp directory read as outside itself.
 *
 * Resolving is not loosening. A symlink inside the root that points outside
 * it resolves to a real path outside the real root, so it stays refused;
 * that is the whole reason to resolve, and not to relax the string test.
 *
 * A path that does not exist yet is resolved as far as its nearest existing
 * ancestor and the remainder is reattached unresolved, so a file a caller
 * is about to create passes while a not-yet-created path whose parent links
 * outside the root does not.
 */
export function resolveWithinRoot(
  root: string,
  candidate: string,
  resolver: PathResolver,
  cwd: string,
): ContainmentResult {
  const resolvedCwd = realCwd(cwd, resolver);
  const absRoot = resolve(resolvedCwd, root);
  const absCandidate = resolve(resolvedCwd, candidate);

  let realRoot: string;
  try {
    realRoot = resolveRealOrPending(absRoot, resolver);
  } catch {
    realRoot = absRoot;
  }

  let realPath: string;
  try {
    realPath = resolveRealOrPending(absCandidate, resolver);
  } catch {
    realPath = absCandidate;
  }

  const contained = isWithin(segmentsOf(realRoot), segmentsOf(realPath));
  return { contained, realRoot, realPath };
}

/**
 * Whether `candidate` is a directory inside `tempDir` and not `tempDir`
 * itself. This is the check that stands between `adg census` and a
 * recursive removal of the wrong directory, so it lives here, next to the
 * containment rule it applies, and not inline in the command: a check that
 * cannot be called on its own cannot be tested on its own either, and this
 * one is worth testing.
 *
 * The temp directory is passed in, not read from node:os, so this
 * module keeps touching nothing but the resolver it was handed.
 *
 * Both sides are resolved. On macOS the system temp directory is
 * /var/folders/..., a symlink into /private, so a string comparison could
 * refuse the very directory the run just created there. A candidate that
 * links out of the temp directory resolves to a real path outside it and
 * is still refused, and the temp directory itself is refused outright: a
 * removal aimed at the whole temp directory is never what was meant.
 */
export function isInsideSystemTemp(
  candidate: string,
  tempDir: string,
  resolver: PathResolver,
  cwd: string,
): boolean {
  const found = resolveWithinRoot(tempDir, candidate, resolver, cwd);
  if (found.realPath === found.realRoot) return false;
  return found.contained;
}
