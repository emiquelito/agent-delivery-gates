// Tests for scripts/scan-prose.sh. The script is bash, so every test spawns
// it the same way a caller would. It had no automated coverage until now,
// which meant an edit inverting its exit codes would have gone unnoticed:
// the gate would report success on prose that violates the constraints.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "scripts", "scan-prose.sh");

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function scan(args: string[], cwd?: string): Run {
  const r = spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", cwd });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "adg-scan-prose-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function fileWith(dir: string, name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

// --- the core verdict: clean passes, banned prose fails ----------------------

test("a clean markdown file exits 0", () => {
  withTempDir((dir) => {
    const p = fileWith(dir, "clean.md", "This sentence says nothing banned.\n");
    assert.equal(scan([p]).status, 0);
  });
});

test("a banned word in markdown exits 1 and names the file and line", () => {
  withTempDir((dir) => {
    const p = fileWith(dir, "bad.md", "first line\nthis works seamlessly now\n");
    const r = scan([p]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /bad\.md:2:/);
  });
});

test("an em dash in markdown exits 1", () => {
  withTempDir((dir) => {
    const p = fileWith(dir, "dash.md", "A line with an em dash — right here.\n");
    assert.equal(scan([p]).status, 1);
  });
});

test("a spaced hyphen in markdown exits 1", () => {
  withTempDir((dir) => {
    const p = fileWith(dir, "hy.md", "The gate fired - the build stopped.\n");
    assert.equal(scan([p]).status, 1);
  });
});

test("an uppercase banned word still exits 1", () => {
  withTempDir((dir) => {
    const p = fileWith(dir, "up.md", "SEAMLESSLY handled, or so it claims.\n");
    assert.equal(scan([p]).status, 1);
  });
});

// --- prose rules that must not apply to source -------------------------------

test("subtraction in a TypeScript file exits 0", () => {
  withTempDir((dir) => {
    const p = fileWith(dir, "ok.ts", "const remaining = total - count;\n");
    assert.equal(scan([p]).status, 0);
  });
});

test("a banned word in a TypeScript comment exits 1", () => {
  withTempDir((dir) => {
    const p = fileWith(dir, "bad.ts", "// this seamlessly handles it\nconst a = 1;\n");
    assert.equal(scan([p]).status, 1);
  });
});

test("an em dash in a TypeScript comment exits 1", () => {
  withTempDir((dir) => {
    const p = fileWith(dir, "dash.ts", "// an em dash — here\nconst a = 1;\n");
    assert.equal(scan([p]).status, 1);
  });
});

test("an uppercase extension is treated as source, not prose", () => {
  withTempDir((dir) => {
    const p = fileWith(dir, "up.TS", "const remaining = total - count;\n");
    assert.equal(scan([p]).status, 0);
  });
});

// --- failing loud: it must never report a clean scan it did not do -----------

test("a path that does not exist exits 2", () => {
  withTempDir((dir) => {
    assert.equal(scan([join(dir, "absent.md")]).status, 2);
  });
});

test("a directory argument exits 2", () => {
  withTempDir((dir) => {
    const sub = join(dir, "sub");
    mkdirSync(sub);
    assert.equal(scan([sub]).status, 2);
  });
});

test("run outside a git repository with no arguments exits 2", () => {
  withTempDir((dir) => {
    const r = scan([], dir);
    assert.equal(r.status, 2);
  });
});

test("one bad file among several still exits 1 and names the bad one", () => {
  withTempDir((dir) => {
    const good = fileWith(dir, "a.md", "nothing wrong here\n");
    const bad = fileWith(dir, "b.md", "this works seamlessly\n");
    const r = scan([good, bad, good]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /b\.md:1:/);
    assert.doesNotMatch(r.stdout, /a\.md:/);
  });
});

// With no arguments the script scans what git tracks. Narrowing that list is
// invisible to every test that passes explicit paths, so this builds a real
// repository and checks each covered kind of file is picked up.
function initRepo(dir: string): void {
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.invalid"]);
  git(["config", "user.name", "Test"]);
}

test("default mode picks up a tracked TypeScript file", () => {
  withTempDir((dir) => {
    initRepo(dir);
    fileWith(dir, "clean.md", "nothing wrong here\n");
    fileWith(dir, "bad.ts", "// this seamlessly handles it\nconst a = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
    const r = scan([], dir);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /bad\.ts:1:/);
  });
});

test("default mode picks up a tracked rule record", () => {
  withTempDir((dir) => {
    initRepo(dir);
    mkdirSync(join(dir, "rules"));
    fileWith(dir, "rules/a.json", '{ "note": "this works seamlessly" }\n');
    execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
    const r = scan([], dir);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /rules\/a\.json:1:/);
  });
});

test("default mode exits 0 on a repository whose tracked files are clean", () => {
  withTempDir((dir) => {
    initRepo(dir);
    fileWith(dir, "clean.md", "nothing wrong here\n");
    execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
    assert.equal(scan([], dir).status, 0);
  });
});
