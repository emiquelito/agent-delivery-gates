// Tests for `agent-delivery-gates init`, spawned through bin/adg.ts the same
// way tests/adg-cli.test.ts spawns every other subcommand. init's whole
// design is one rule: it only ever creates a file that does not already
// exist. Every test here checks one edge of that rule directly, because a
// tool that might overwrite a developer's own configuration is one nobody
// would trust enough to run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runInit } from "../src/init.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const BIN = join(REPO_ROOT, "bin", "adg.ts");

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runInitCli(args: string[]): Run {
  const r = spawnSync(BIN, ["init", ...args], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "adg-init-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CREATED_FILES = [".githooks/pre-commit", "AGENTS.md", "docs/gate-tally.md"];

// --- creates the expected files, in an empty directory ----------------------

test("in an empty directory: creates every expected file, exits 0", () => {
  withTempDir((dir) => {
    const result = runInitCli(["--dir", dir]);
    assert.equal(result.status, 0, result.stderr);
    for (const rel of CREATED_FILES) {
      assert.ok(existsSync(join(dir, rel)), `expected ${rel} to exist`);
    }
    // The prose rules file is opt-in only; nothing here asked for it.
    assert.equal(existsSync(join(dir, ".adg", "prose-rules.txt")), false);
  });
});

test("in an empty directory: never writes .claude/settings.json", () => {
  withTempDir((dir) => {
    runInitCli(["--dir", dir]);
    assert.equal(existsSync(join(dir, ".claude", "settings.json")), false);
  });
});

test("with an existing .claude/settings.json: leaves it unchanged", () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const settingsPath = join(dir, ".claude", "settings.json");
    const original = '{"already": "here"}';
    writeFileSync(settingsPath, original);
    runInitCli(["--dir", dir]);
    assert.equal(readFileSync(settingsPath, "utf8"), original);
  });
});

// --- running twice is safe ---------------------------------------------------

test("run twice with no flags: the second run reports everything present, creates nothing, exits 0", () => {
  withTempDir((dir) => {
    const first = runInitCli(["--dir", dir]);
    assert.equal(first.status, 0, first.stderr);

    const before: Record<string, string> = {};
    for (const rel of CREATED_FILES) before[rel] = readFileSync(join(dir, rel), "utf8");

    const second = runInitCli(["--dir", dir]);
    assert.equal(second.status, 0, second.stderr);
    for (const rel of CREATED_FILES) {
      assert.match(second.stdout, new RegExp(`exists, skipped: ${rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.equal(readFileSync(join(dir, rel), "utf8"), before[rel]);
    }
  });
});

// --- existing AGENTS.md: left alone, unless --force --------------------------

test("with an existing AGENTS.md: leaves its contents untouched", () => {
  withTempDir((dir) => {
    const agentsPath = join(dir, "AGENTS.md");
    const original = "# my own notes, not the template\n";
    writeFileSync(agentsPath, original);
    const result = runInitCli(["--dir", dir]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(agentsPath, "utf8"), original);
    assert.match(result.stdout, /exists, skipped: AGENTS\.md/);
  });
});

test("--force: replaces an existing AGENTS.md", () => {
  withTempDir((dir) => {
    const agentsPath = join(dir, "AGENTS.md");
    writeFileSync(agentsPath, "# my own notes, not the template\n");
    const result = runInitCli(["--dir", dir, "--force"]);
    assert.equal(result.status, 0, result.stderr);
    const rewritten = readFileSync(agentsPath, "utf8");
    assert.notEqual(rewritten, "# my own notes, not the template\n");
    assert.match(result.stdout, /overwrote: AGENTS\.md/);
  });
});

// --- --dry-run: a plan, not an action ----------------------------------------

test("--dry-run: creates nothing, exits 0", () => {
  withTempDir((dir) => {
    const result = runInitCli(["--dir", dir, "--dry-run"]);
    assert.equal(result.status, 0, result.stderr);
    for (const rel of CREATED_FILES) {
      assert.equal(existsSync(join(dir, rel)), false, `expected ${rel} not to exist after --dry-run`);
    }
    assert.match(result.stdout, /would create: AGENTS\.md/);
  });
});

// --- --prose-preset -----------------------------------------------------------

test("--prose-preset house-style: writes a rules file that resolves, and the scan then works", () => {
  withTempDir((dir) => {
    const result = runInitCli(["--dir", dir, "--prose-preset", "house-style"]);
    assert.equal(result.status, 0, result.stderr);
    const rulesPath = join(dir, ".adg", "prose-rules.txt");
    assert.ok(existsSync(rulesPath));
    const contents = readFileSync(rulesPath, "utf8");
    assert.match(contents, /^include: /);

    const includedPath = contents.replace(/^include:\s*/, "").trim();
    assert.ok(existsSync(includedPath), `included preset path '${includedPath}' should resolve`);

    // The scan itself now works from that directory: a file carrying a
    // banned word is caught, using the rules init just wrote.
    const filePath = join(dir, "notes.md");
    writeFileSync(filePath, "this is " + "gen" + "uinely banned prose\n");
    const scanResult = spawnSync(BIN, ["scan-prose", "--rules", rulesPath, filePath], { encoding: "utf8" });
    assert.equal(scanResult.status, 1, scanResult.stderr);
  });
});

test("without --prose-preset: no rules file exists, and the scan reports nothing configured", () => {
  withTempDir((dir) => {
    const result = runInitCli(["--dir", dir]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(dir, ".adg", "prose-rules.txt")), false);

    const filePath = join(dir, "notes.md");
    writeFileSync(filePath, "anything at all\n");
    const scanResult = spawnSync(BIN, ["scan-prose", filePath], { encoding: "utf8", cwd: dir });
    assert.equal(scanResult.status, 0);
    assert.match(scanResult.stdout, /no prose rules are configured/);
  });
});

test("an unknown preset name exits 2", () => {
  withTempDir((dir) => {
    const result = runInitCli(["--dir", dir, "--prose-preset", "no-such-preset"]);
    assert.equal(result.status, 2);
    for (const rel of CREATED_FILES) {
      assert.equal(existsSync(join(dir, rel)), false, "a bad preset name must not write a partial setup");
    }
  });
});

// --- --dir -------------------------------------------------------------------

test("--dir: targets another directory", () => {
  withTempDir((outer) => {
    const target = join(outer, "elsewhere");
    mkdirSync(target);
    const result = runInitCli(["--dir", target]);
    assert.equal(result.status, 0, result.stderr);
    for (const rel of CREATED_FILES) {
      assert.ok(existsSync(join(target, rel)));
    }
    // Nothing landed in the outer directory itself.
    for (const rel of CREATED_FILES) {
      assert.equal(existsSync(join(outer, rel)), false);
    }
  });
});

test("--dir pointing at a path that does not exist: exits 2, writes nothing", () => {
  withTempDir((dir) => {
    const missing = join(dir, "does-not-exist");
    const result = runInitCli(["--dir", missing]);
    assert.equal(result.status, 2);
    assert.equal(existsSync(missing), false);
  });
});

// --- a missing template ------------------------------------------------------
//
// Exercised by calling src/init.ts's own runInit directly, against a
// fabricated package root that carries only some of the templates a real
// install would. This is the one case bin/adg.ts alone cannot be made to
// hit without editing this repository's own installed templates.

// --- the published package actually carries what init needs -----------------
//
// Everything above spawns the binary against this checkout, where every
// template sits on disk at its normal repository path regardless of what
// package.json's "files" allowlist says. That allowlist only matters once
// the package is packed for real, so a template dropped from it would
// fail none of the tests above. This one reads the actual tarball
// manifest npm would publish and checks the files init depends on are in
// it, which is the one place that drop would show up.

test("the packed tarball carries every template and preset init needs", () => {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(result.stdout) as { files: { path: string }[] }[];
  const paths = new Set(manifest[0].files.map((f) => f.path));

  for (const required of [
    "templates/pre-commit",
    "templates/AGENTS.md",
    "templates/gate-tally.md",
    "presets/house-style.txt",
    "package.json",
  ]) {
    assert.ok(paths.has(required), `expected the packed tarball to carry '${required}'`);
  }
});

test("a missing template exits 2, not a partial setup", () => {
  withTempDir((target) => {
    const fakePackageRoot = mkdtempSync(join(tmpdir(), "adg-init-fake-pkg-"));
    try {
      mkdirSync(join(fakePackageRoot, "templates"), { recursive: true });
      // AGENTS.md and gate-tally.md are present; pre-commit is not.
      writeFileSync(join(fakePackageRoot, "templates", "AGENTS.md"), "stand-in\n");
      writeFileSync(join(fakePackageRoot, "templates", "gate-tally.md"), "stand-in\n");

      const outcome = runInit({ targetDir: target, packageRoot: fakePackageRoot, dryRun: false, force: false });
      assert.equal(outcome.exitCode, 2);
      assert.equal(existsSync(join(target, "AGENTS.md")), false, "no file should have been written");
      assert.equal(existsSync(join(target, "docs", "gate-tally.md")), false);
    } finally {
      rmSync(fakePackageRoot, { recursive: true, force: true });
    }
  });
});
