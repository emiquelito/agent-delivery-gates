// Tests for src/path-allowlist.ts. The resolver is a plain function built
// per test, never node:fs, so these run without touching a real filesystem
// and can construct symlink-like resolution scenarios exactly as needed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPathAllowed, type PathResolver } from "../src/path-allowlist.ts";
import { mkdtempSync, writeFileSync, symlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const CWD = "/home/build/work";

test("a path inside a root is allowed", () => {
  const resolver = fakeResolver({ "/repo": "/repo", "/repo/src/a.ts": "/repo/src/a.ts" });
  const result = checkPathAllowed("/repo/src/a.ts", ["/repo"], resolver, CWD);
  assert.equal(result.allowed, true);
});

test("a path outside every root is denied", () => {
  const resolver = fakeResolver({ "/repo": "/repo", "/etc/passwd": "/etc/passwd" });
  const result = checkPathAllowed("/etc/passwd", ["/repo"], resolver, CWD);
  assert.equal(result.allowed, false);
  assert.equal(result.realPath, "/etc/passwd");
  assert.deepEqual(result.roots, ["/repo"]);
});

test("a path that does not exist yet, inside a root, is allowed", () => {
  // /repo/src exists; /repo/src/new-file.ts does not, the way a Write
  // target never exists beforehand.
  const resolver = fakeResolver({ "/repo": "/repo", "/repo/src": "/repo/src" });
  const result = checkPathAllowed("/repo/src/new-file.ts", ["/repo"], resolver, CWD);
  assert.equal(result.allowed, true);
  assert.equal(result.realPath, "/repo/src/new-file.ts");
});

test("a symlink inside a root pointing outside it is denied", () => {
  // /repo/link exists and resolves to a path outside /repo. This is the
  // case the whole rule turns on: the lexical path looks contained, the
  // real path is not.
  const resolver = fakeResolver({
    "/repo": "/repo",
    "/repo/link": "/outside/secret",
    "/repo/link/file.txt": "/outside/secret/file.txt",
  });
  const result = checkPathAllowed("/repo/link/file.txt", ["/repo"], resolver, CWD);
  assert.equal(result.allowed, false);
  assert.equal(result.realPath, "/outside/secret/file.txt");
});

test("a symlinked root still matches a path inside its target", () => {
  // The root itself is given as a symlink; it resolves to /real-repo.
  const resolver = fakeResolver({
    "/repo": "/real-repo",
    "/repo/src/a.ts": "/real-repo/src/a.ts",
  });
  const result = checkPathAllowed("/repo/src/a.ts", ["/repo"], resolver, CWD);
  assert.equal(result.allowed, true);
});

test("/repo-evil is not counted as inside /repo", () => {
  const resolver = fakeResolver({
    "/repo": "/repo",
    "/repo-evil/x.txt": "/repo-evil/x.txt",
  });
  const result = checkPathAllowed("/repo-evil/x.txt", ["/repo"], resolver, CWD);
  assert.equal(result.allowed, false);
});

test("a relative path is resolved against the working directory", () => {
  const resolver = fakeResolver({
    "/home/build/work": "/home/build/work",
    "/home/build/work/src/a.ts": "/home/build/work/src/a.ts",
  });
  const result = checkPathAllowed("src/a.ts", ["/home/build/work"], resolver, CWD);
  assert.equal(result.allowed, true);
  assert.equal(result.realPath, "/home/build/work/src/a.ts");
});

test("a candidate equal to the root itself is allowed", () => {
  const resolver = fakeResolver({ "/repo": "/repo" });
  const result = checkPathAllowed("/repo", ["/repo"], resolver, CWD);
  assert.equal(result.allowed, true);
});

test("several roots, candidate in the second, is allowed", () => {
  const resolver = fakeResolver({
    "/roots/first": "/roots/first",
    "/roots/second": "/roots/second",
    "/roots/second/file.txt": "/roots/second/file.txt",
  });
  const result = checkPathAllowed(
    "/roots/second/file.txt",
    ["/roots/first", "/roots/second"],
    resolver,
    CWD,
  );
  assert.equal(result.allowed, true);
});

test("an empty root list denies everything", () => {
  const resolver = fakeResolver({ "/repo/a.ts": "/repo/a.ts" });
  const result = checkPathAllowed("/repo/a.ts", [], resolver, CWD);
  assert.equal(result.allowed, false);
  assert.deepEqual(result.roots, []);
});

test("a path containing .. that resolves back inside a root is allowed", () => {
  // /repo/tmp/../src/a.ts is not itself in the map; node:path collapses the
  // .. before the resolver ever sees it, since path.resolve is applied to
  // the raw candidate before ancestor walking begins.
  const resolver = fakeResolver({ "/repo": "/repo", "/repo/src/a.ts": "/repo/src/a.ts" });
  const result = checkPathAllowed("/repo/tmp/../src/a.ts", ["/repo"], resolver, CWD);
  assert.equal(result.allowed, true);
  assert.equal(result.realPath, "/repo/src/a.ts");
});

test("a path containing .. that escapes the root is denied", () => {
  const resolver = fakeResolver({ "/repo": "/repo", "/etc/passwd": "/etc/passwd" });
  const result = checkPathAllowed("/repo/../../etc/passwd", ["/repo"], resolver, CWD);
  assert.equal(result.allowed, false);
});

test("a denied result names the candidate, real path, and roots in its message", () => {
  const resolver = fakeResolver({ "/repo": "/repo", "/etc/passwd": "/etc/passwd" });
  const result = checkPathAllowed("/etc/passwd", ["/repo"], resolver, CWD);
  assert.match(result.message, /\/etc\/passwd/);
  assert.match(result.message, /\/repo/);
});

test("a root that fails to resolve is left out, and the check still returns a decision", () => {
  const resolver = fakeResolver({ "/repo/a.ts": "/repo/a.ts" });
  // "/missing-root" is not in the map at any ancestor level, including "/",
  // so it can never resolve. It should simply grant nothing.
  const result = checkPathAllowed("/repo/a.ts", ["/missing-root"], resolver, CWD);
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
