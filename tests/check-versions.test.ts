// Tests for scripts/check-versions.ts. Every test spawns the CLI as a real
// subprocess: stdout, stderr, and exit code are the contract, never an
// internal function's return value.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CLI_PATH = join(ROOT, "scripts", "check-versions.ts");

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[] = [], root?: string): RunResult {
  const env = root === undefined ? process.env : { ...process.env, CHECK_VERSIONS_ROOT: root };
  const result = spawnSync("node", [CLI_PATH, ...args], { cwd: ROOT, encoding: "utf8", env });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function realVersion(): string {
  return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
}

test("the real repository has all six version files agreeing, and exits 0", () => {
  const result = runCli([]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, new RegExp(`all agree on ${realVersion()}`));
});

test("--check on the real repository exits 0 and reports no problems", () => {
  const result = runCli(["--check"]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /no problems found/);
});

test("an unknown argument exits 2", () => {
  const result = runCli(["--bogus"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown argument/);
});

// --set: each test works in a scratch copy of the six real files, never the
// real checkout.

const FILES = [
  "package.json",
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  ".github/plugin/plugin.json",
  "gemini-extension.json",
  "package-lock.json",
];

function git(dir: string, ...args: string[]): void {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
}

function scratch(opts: { git?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "adg-cv-"));
  for (const f of FILES) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), readFileSync(join(ROOT, f)));
  }
  if (opts.git !== false) {
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "fixture");
  }
  return dir;
}

function snapshot(dir: string): string[] {
  return FILES.map((f) => readFileSync(join(dir, f), "utf8"));
}

test("--set writes the version into all six files and --check then passes", () => {
  const dir = scratch();
  try {
    const result = runCli(["--set", "9.8.7"], dir);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    for (const f of FILES) {
      assert.equal(JSON.parse(readFileSync(join(dir, f), "utf8")).version, "9.8.7", f);
    }
    const check = runCli(["--check"], dir);
    assert.equal(check.status, 0, check.stdout + check.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--set changes nothing but the version text, including the lockfile's packages entry", () => {
  const dir = scratch();
  try {
    const before = snapshot(dir);
    const old = realVersion();
    assert.equal(runCli(["--set", "9.8.7"], dir).status, 0);
    const after = snapshot(dir);
    FILES.forEach((f, i) => {
      const expectedCount = f === "package-lock.json" ? 2 : 1;
      // Undo the bump textually; the file must then be byte-identical.
      const reverted = after[i].split(`"version": "9.8.7"`).join(`"version": "${old}"`);
      assert.equal(reverted, before[i], `${f} differs by more than the version`);
      assert.equal(after[i].split(`"version": "9.8.7"`).length - 1, expectedCount, f);
      assert.equal(after[i].endsWith("\n"), before[i].endsWith("\n"), `${f} trailing newline`);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--set leaves a dependency that shares the old version string alone", () => {
  const dir = scratch();
  try {
    const old = realVersion();
    const lockPath = join(dir, "package-lock.json");
    const lock = readFileSync(lockPath, "utf8");
    const planted = lock.replace(/("node_modules\/[^"]+": \{\s*"version": ")[^"]*(")/, `$1${old}$2`);
    assert.notEqual(planted, lock, "fixture must contain a dependency entry");
    writeFileSync(lockPath, planted);
    git(dir, "commit", "-q", "-am", "plant");
    assert.equal(runCli(["--set", "9.8.7"], dir).status, 0);
    assert.match(readFileSync(lockPath, "utf8"), new RegExp(`"node_modules/[^"]+": \\{\\s*"version": "${old.replace(/\./g, "\\.")}"`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const bad of ["v1.2.3", "1.2", "1.2.3.4", "01.2.3", "abc", "", "1.2.3 ", "1.2.3-", "latest"]) {
  test(`--set rejects invalid version '${bad}' with exit 2 and writes nothing`, () => {
    const dir = scratch();
    try {
      const before = snapshot(dir);
      const result = runCli(["--set", bad], dir);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /not a valid version/);
      assert.deepEqual(snapshot(dir), before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("--set accepts a prerelease version", () => {
  const dir = scratch();
  try {
    assert.equal(runCli(["--set", "1.0.0-rc.1"], dir).status, 0);
    assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version, "1.0.0-rc.1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--set without a version, or with extra arguments, exits 2", () => {
  const dir = scratch();
  try {
    assert.equal(runCli(["--set"], dir).status, 2);
    assert.equal(runCli(["--set", "1.0.0", "--check"], dir).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--set refuses when a version file has uncommitted changes, and writes nothing", () => {
  const dir = scratch();
  try {
    const path = join(dir, "gemini-extension.json");
    writeFileSync(path, readFileSync(path, "utf8") + "\n");
    const before = snapshot(dir);
    const result = runCli(["--set", "9.8.7"], dir);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /uncommitted changes/);
    assert.deepEqual(snapshot(dir), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--set is not blocked by uncommitted changes in unrelated files", () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, "notes.txt"), "scratch\n");
    assert.equal(runCli(["--set", "9.8.7"], dir).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--set refuses outside a git checkout, and writes nothing", () => {
  const dir = scratch({ git: false });
  try {
    const before = snapshot(dir);
    const result = runCli(["--set", "9.8.7"], dir);
    assert.equal(result.status, 2);
    assert.deepEqual(snapshot(dir), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--set writes nothing when one file cannot be edited safely", () => {
  const dir = scratch();
  try {
    // A version line indented differently from the top-level key: no safe edit.
    const path = join(dir, "gemini-extension.json");
    const text = readFileSync(path, "utf8").replace(/^  "version"/m, '    "version"');
    writeFileSync(path, text);
    git(dir, "commit", "-q", "-am", "odd");
    const before = snapshot(dir);
    const result = runCli(["--set", "9.8.7"], dir);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /cannot safely edit/);
    assert.deepEqual(snapshot(dir), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
