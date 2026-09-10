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
import { checkPathAllowed, type PathResolver } from "../src/path-allowlist.ts";
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

test("a relative path is resolved against the working directory", () => {
  const resolver = fakeResolver({
    [p("srv", "project")]: p("srv", "project"),
    [p("srv", "project", "src", "a.ts")]: p("srv", "project", "src", "a.ts"),
  });
  const result = checkPathAllowed(join("src", "a.ts"), [p("srv", "project")], resolver, CWD);
  assert.equal(result.allowed, true);
  assert.equal(result.realPath, p("srv", "project", "src", "a.ts"));
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
  assert.match(result.message, /etc/);
  assert.match(result.message, /passwd/);
  assert.match(result.message, /repo/);
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
test("a real symlink out of the only allowed root is denied", () => {
  const outside = mkdtempSync(join(tmpdir(), "adg-outside-"));
  const root = mkdtempSync(join(tmpdir(), "adg-root-"));
  const link = join(root, "escape");
  try {
    writeFileSync(join(outside, "secret.txt"), "x");
    symlinkSync(outside, link);
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
