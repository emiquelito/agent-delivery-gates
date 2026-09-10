// Tests for src/path-allowlist.ts. The resolver is a plain function built
// per test, never node:fs, so these run without touching a real filesystem
// and can construct symlink-like resolution scenarios exactly as needed.
//
// src/path-allowlist.ts resolves paths with plain node:path (not
// path.posix), the same module a real caller's real filesystem paths go
// through, so the fixtures below build their absolute paths with the `p()`
// helper instead of POSIX literals: on win32, node:path.resolve treats a
// leading "/" as drive-relative to the current drive, not as an
// absolute path, so a literal "/repo/src/a.ts" would never match itself
// after resolution and every fake-resolver lookup below would miss. `p()`
// builds a path each platform's own path.resolve treats as absolute, so the
// same logic is exercised on every platform.

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPathAllowed, resolveWithinRoot, type PathResolver } from "../src/path-allowlist.ts";
import { mkdtempSync, writeFileSync, symlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import process from "node:process";

/** Joins segments into an absolute path in the current platform's own
 * flavor: forward slashes rooted at "/" on POSIX, backslashes rooted at a
 * drive on win32. Never used on a relative candidate, where cwd already
 * supplies the platform-appropriate root. */
function p(...segments: string[]): string {
  const root = process.platform === "win32" ? "C:\\" : "/";
  return root + segments.join(sep);
}

/** Escapes `text` so it can be dropped into a `RegExp` and match only
 * itself, backslashes (win32's path separator) included. */
function reEscape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds a resolver from a map of path -> real path. Any path not present
 * in the map "does not exist": the resolver throws, the same contract as
 * fs.realpathSync, so the core has to walk up to an ancestor that is in the
 * map. Every entry in the map is treated as existing and mapping to itself
 * unless overridden, which is what makes an ordinary path resolve to itself.
 */
function fakeResolver(overrides: Record<string, string>): PathResolver {
  return (path: string) => {
    if (path in overrides) return overrides[path]!;
    throw new Error(`ENOENT: no such file or directory, lstat '${path}'`);
  };
}

const CWD = p("srv", "project");

test("a path inside a root is allowed", () => {
  const resolver = fakeResolver({ [p("repo")]: p("repo"), [p("repo", "src", "a.ts")]: p("repo", "src", "a.ts") });
  const result = checkPathAllowed(p("repo", "src", "a.ts"), [p("repo")], resolver, CWD);
  assert.equal(result.allowed, true);
});

test("a path outside every root is denied", () => {
  const resolver = fakeResolver({ [p("repo")]: p("repo"), [p("etc", "passwd")]: p("etc", "passwd") });
  const result = checkPathAllowed(p("etc", "passwd"), [p("repo")], resolver, CWD);
  assert.equal(result.allowed, false);
  assert.equal(result.realPath, p("etc", "passwd"));
  assert.deepEqual(result.roots, [p("repo")]);
});

test("a path that does not exist yet, inside a root, is allowed", () => {
  // /repo/src exists; /repo/src/new-file.ts does not, the way a Write
  // target never exists beforehand.
  const resolver = fakeResolver({ [p("repo")]: p("repo"), [p("repo", "src")]: p("repo", "src") });
  const result = checkPathAllowed(p("repo", "src", "new-file.ts"), [p("repo")], resolver, CWD);
  assert.equal(result.allowed, true);
  assert.equal(result.realPath, p("repo", "src", "new-file.ts"));
});

test("a symlink inside a root pointing outside it is denied", () => {
  // /repo/link exists and resolves to a path outside /repo. This is the
  // case the whole rule turns on: the lexical path looks contained, the
  // real path is not.
  const resolver = fakeResolver({
    [p("repo")]: p("repo"),
    [p("repo", "link")]: p("outside", "secret"),
    [p("repo", "link", "file.txt")]: p("outside", "secret", "file.txt"),
  });
  const result = checkPathAllowed(p("repo", "link", "file.txt"), [p("repo")], resolver, CWD);
  assert.equal(result.allowed, false);
  assert.equal(result.realPath, p("outside", "secret", "file.txt"));
});

test("a symlinked root still matches a path inside its target", () => {
  // The root itself is given as a symlink; it resolves to /real-repo.
  const resolver = fakeResolver({
    [p("repo")]: p("real-repo"),
    [p("repo", "src", "a.ts")]: p("real-repo", "src", "a.ts"),
  });
  const result = checkPathAllowed(p("repo", "src", "a.ts"), [p("repo")], resolver, CWD);
  assert.equal(result.allowed, true);
});

test("/repo-evil is not counted as inside /repo", () => {
  const resolver = fakeResolver({
    [p("repo")]: p("repo"),
    [p("repo-evil", "x.txt")]: p("repo-evil", "x.txt"),
  });
  const result = checkPathAllowed(p("repo-evil", "x.txt"), [p("repo")], resolver, CWD);
  assert.equal(result.allowed, false);
});

// A containment check has two ways to be wrong: too loose, letting a
// sibling like /repo-evil count as inside /repo (above), and too loose the
// other direction, letting an ancestor of the root count as inside it. The
// segment-count guard in isWithin (src/path-allowlist.ts) is what stops the
// second one: a candidate with fewer segments than the root can never be
// "at least as deep", whatever its segments say. Without that guard, a
// mutant comparing only the segments the two paths have in common would
// still find every one of a root's own leading segments equal to itself
// and call the ancestor contained -- exactly the parent-counts-as-its-own-child
// hole this confinement check exists to close.
test("a candidate that is an ancestor of the root is denied, not counted as inside it", () => {
  const resolver = fakeResolver({
    [p("repo", "deep", "nested")]: p("repo", "deep", "nested"),
    [p("repo", "deep")]: p("repo", "deep"),
  });
  const result = checkPathAllowed(p("repo", "deep"), [p("repo", "deep", "nested")], resolver, CWD);
  assert.equal(result.allowed, false);
});

test("the filesystem root is denied against a deeper allowed root", () => {
  const resolver = fakeResolver({
    [p("repo", "deep", "nested")]: p("repo", "deep", "nested"),
    [p()]: p(),
  });
  const result = checkPathAllowed(p(), [p("repo", "deep", "nested")], resolver, CWD);
  assert.equal(result.allowed, false);
});

test("a relative path is resolved against the working directory", () => {
  const resolver = fakeResolver({
    [p("srv", "project")]: p("srv", "project"),
    [p("srv", "project", "src", "a.ts")]: p("srv", "project", "src", "a.ts"),
  });
  const result = checkPathAllowed(join("src", "a.ts"), [p("srv", "project")], resolver, CWD);
  assert.equal(result.allowed, true);
  assert.equal(result.realPath, p("srv", "project", "src", "a.ts"));
});

// realCwd (src/path-allowlist.ts) realpaths cwd itself before a relative
// root or candidate is ever joined onto it: this is the fix for a Windows
// short name like RUNNER~1 in process.cwd() disagreeing with the long form
// git already resolved.
//
// A relative path nested *under* cwd cannot tell this apart from cwd being
// left alone: resolveRealOrPending's own ancestor walk, given an
// unresolved candidate, always eventually revisits the literal cwd string
// as an ancestor and resolves it there anyway, arriving at the same
// answer. The gap only shows for a relative root or candidate that steps
// *above* cwd with "..": the lexical join then walks up through cwd's own
// parent, never through cwd itself, so nothing forces that walk through
// the resolver entry realCwd already used. The fake resolver below maps
// only the short cwd and the fully-resolved sibling paths, not any
// unresolved ancestor in between, so without realCwd the walk finds
// nothing to resolve through and falls back to the raw short-named
// string; with it, both the root and the candidate come back through the
// long form.
test("a working directory that resolves to a different real path is realpathed before a relative root or candidate that steps above it is joined on", () => {
  const shortCwd = p("RUNNER~1", "project");
  const longCwd = p("runneradmin", "project");
  const resolver = fakeResolver({
    [shortCwd]: longCwd,
    [longCwd]: longCwd,
    [p("runneradmin", "sibling")]: p("runneradmin", "sibling"),
    [p("runneradmin", "sibling", "file.ts")]: p("runneradmin", "sibling", "file.ts"),
  });
  const result = resolveWithinRoot(join("..", "sibling"), join("..", "sibling", "file.ts"), resolver, shortCwd);
  assert.equal(result.realRoot, p("runneradmin", "sibling"));
  assert.equal(result.realPath, p("runneradmin", "sibling", "file.ts"));
  assert.equal(result.contained, true);
});

test("a candidate equal to the root itself is allowed", () => {
  const resolver = fakeResolver({ [p("repo")]: p("repo") });
  const result = checkPathAllowed(p("repo"), [p("repo")], resolver, CWD);
  assert.equal(result.allowed, true);
});

test("several roots, candidate in the second, is allowed", () => {
  const resolver = fakeResolver({
    [p("roots", "first")]: p("roots", "first"),
    [p("roots", "second")]: p("roots", "second"),
    [p("roots", "second", "file.txt")]: p("roots", "second", "file.txt"),
  });
  const result = checkPathAllowed(
    p("roots", "second", "file.txt"),
    [p("roots", "first"), p("roots", "second")],
    resolver,
    CWD,
  );
  assert.equal(result.allowed, true);
});

test("an empty root list denies everything", () => {
  const resolver = fakeResolver({ [p("repo", "a.ts")]: p("repo", "a.ts") });
  const result = checkPathAllowed(p("repo", "a.ts"), [], resolver, CWD);
  assert.equal(result.allowed, false);
  assert.deepEqual(result.roots, []);
});

test("a path containing .. that resolves back inside a root is allowed", () => {
  // /repo/tmp/../src/a.ts is not itself in the map; node:path collapses the
  // .. before the resolver ever sees it, since path.resolve is applied to
  // the raw candidate before ancestor walking begins.
  const resolver = fakeResolver({ [p("repo")]: p("repo"), [p("repo", "src", "a.ts")]: p("repo", "src", "a.ts") });
  const result = checkPathAllowed(p("repo", "tmp", "..", "src", "a.ts"), [p("repo")], resolver, CWD);
  assert.equal(result.allowed, true);
  assert.equal(result.realPath, p("repo", "src", "a.ts"));
});

test("a path containing .. that escapes the root is denied", () => {
  const resolver = fakeResolver({ [p("repo")]: p("repo"), [p("etc", "passwd")]: p("etc", "passwd") });
  const result = checkPathAllowed(p("repo", "..", "..", "etc", "passwd"), [p("repo")], resolver, CWD);
  assert.equal(result.allowed, false);
});

test("a denied result names the candidate, real path, and roots in its message", () => {
  const resolver = fakeResolver({ [p("repo")]: p("repo"), [p("etc", "passwd")]: p("etc", "passwd") });
  const result = checkPathAllowed(p("etc", "passwd"), [p("repo")], resolver, CWD);
  // Each path must appear whole, not as three fragments a message could
  // satisfy without ever printing the path itself (e.g. "etc ... passwd
  // ... repo" split across unrelated words).
  assert.match(result.message, new RegExp(reEscape(p("etc", "passwd"))));
  assert.match(result.message, new RegExp(reEscape(p("repo"))));
});

test("a root that fails to resolve is left out, and the check still returns a decision", () => {
  const resolver = fakeResolver({ [p("repo", "a.ts")]: p("repo", "a.ts") });
  // "/missing-root" is not in the map at any ancestor level, including "/",
  // so it can never resolve. It should simply grant nothing.
  const result = checkPathAllowed(p("repo", "a.ts"), [p("missing-root")], resolver, CWD);
  assert.equal(result.allowed, false);
});

// The injected resolver proves the logic. This proves the logic against a
// real filesystem, with a real symlink, because a confinement check that only
// ever meets a fake resolver has never met the case it exists for.
test("a real symlink out of the only allowed root is denied", (t) => {
  const outside = mkdtempSync(join(tmpdir(), "adg-outside-"));
  const root = mkdtempSync(join(tmpdir(), "adg-root-"));
  const link = join(root, "escape");
  try {
    writeFileSync(join(outside, "secret.txt"), "x");
    try {
      symlinkSync(outside, link);
    } catch (err) {
      // Creating a symlink on Windows needs either Administrator
      // privilege or Developer Mode; a runner with neither throws EPERM
      // here, before this test has anything to do with the allowlist
      // logic itself. This is skipped instead of worked around, because
      // there is no portable way to create a real symlink, and a fake one
      // would stop
      // this from being the real-filesystem case the comment above says
      // it exists for.
      if (process.platform === "win32" && (err as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("creating a symlink needs Administrator privilege or Developer Mode on Windows");
        return;
      }
      throw err;
    }
    const resolver: PathResolver = (p) => realpathSync(p);
    const inside = checkPathAllowed(join(root, "ok.txt"), [root], resolver, root);
    assert.equal(inside.allowed, true);
    const escaped = checkPathAllowed(join(link, "secret.txt"), [root], resolver, root);
    assert.equal(escaped.allowed, false);
  } finally {
    rmSync(link, { force: true });
    rmSync(outside, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
