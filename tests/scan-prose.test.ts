// Tests for scripts/scan-prose.sh. The script is bash, so every test spawns
// it the same way a caller would. It had no automated coverage until now,
// which meant an edit inverting its exit codes would have gone unnoticed:
// the gate would report success on prose that violates the constraints.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "scripts", "scan-prose.sh");
const REPO_ROOT = join(HERE, "..");
const REPO_RULES = join(REPO_ROOT, ".adg", "prose-rules.txt");

// Fixtures have to contain the words the gate rejects, and the gate reads
// this file. Building them at runtime keeps the gate strict, with no
// exemption for its own tests, which would be the wrong thing to add here.
const BANNED_WORD = "seam" + "lessly";
const BANNED_UPPER = BANNED_WORD.toUpperCase();
const EM_DASH = "\u2014";

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function scan(args: string[], cwd?: string, env?: Record<string, string>): Run {
  const r = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
  });
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
    const p = fileWith(dir, "bad.md", `first line\nthis works ${BANNED_WORD} now\n`);
    const r = scan([p]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /bad\.md:2:/);
  });
});

test("an em dash in markdown exits 1", () => {
  withTempDir((dir) => {
    const p = fileWith(dir, "dash.md", `A line with an em dash ${EM_DASH} right here.\n`);
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
    const p = fileWith(dir, "up.md", `${BANNED_UPPER} handled, or so it claims.\n`);
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
    const p = fileWith(dir, "bad.ts", `// this ${BANNED_WORD} handles it\nconst a = 1;\n`);
    assert.equal(scan([p]).status, 1);
  });
});

test("an em dash in a TypeScript comment exits 1", () => {
  withTempDir((dir) => {
    const p = fileWith(dir, "dash.ts", `// an em dash ${EM_DASH} here\nconst a = 1;\n`);
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
    const bad = fileWith(dir, "b.md", `this works ${BANNED_WORD}\n`);
    const r = scan([good, bad, good]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /b\.md:1:/);
    assert.doesNotMatch(r.stdout, /a\.md:/);
  });
});

// With no arguments the script scans what git tracks. Narrowing that list is
// invisible to every test that passes explicit paths, so this builds a real
// repository and checks each covered kind of file is picked up.
// The patterns are no longer built into the script; a repository needs its
// own rules file for default-mode scanning to find anything. initRepo gives
// every fixture repo a minimal one, so the default-mode tests below still
// exercise real pattern matching instead of falling into the no-rules path.
function initRepo(dir: string): void {
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.invalid"]);
  git(["config", "user.name", "Test"]);
  mkdirSync(join(dir, ".adg"), { recursive: true });
  writeFileSync(join(dir, ".adg", "prose-rules.txt"), `\\b${BANNED_WORD}\\b\n`);
}

test("default mode picks up a tracked TypeScript file", () => {
  withTempDir((dir) => {
    initRepo(dir);
    fileWith(dir, "clean.md", "nothing wrong here\n");
    fileWith(dir, "bad.ts", `// this ${BANNED_WORD} handles it\nconst a = 1;\n`);
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
    fileWith(dir, "rules/a.json", `{ "note": "this works ${BANNED_WORD}" }\n`);
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

// The default set has to cover the tracked files that carry prose, not only
// markdown. An audit found eight tracked files outside it, config comments
// among them.
test("default mode picks up a tracked shell script", () => {
  withTempDir((dir) => {
    initRepo(dir);
    fileWith(dir, "run.sh", `#!/usr/bin/env bash\n# this ${BANNED_WORD} works\n`);
    execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
    const r = scan([], dir);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /run\.sh:2:/);
  });
});

test("default mode picks up a tracked config file outside rules", () => {
  withTempDir((dir) => {
    initRepo(dir);
    fileWith(dir, "package.json", `{ "description": "this works ${BANNED_WORD}" }\n`);
    execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
    const r = scan([], dir);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /package\.json:1:/);
  });
});

test("a shell script is read as code, so subtraction passes", () => {
  withTempDir((dir) => {
    const p = fileWith(dir, "calc.sh", "n=$(( total - count ))\n");
    assert.equal(scan([p]).status, 0);
  });
});

// --- rules files: where they come from, and what they can say ---------------

// Explicit-path invocations run with no cwd override, so bash falls back to
// the test runner's own working directory, which is this repository. That
// makes the repository's own .adg/prose-rules.txt the rules file in effect
// for every test above this point, and for the ones below that pass neither
// --rules nor ADG_PROSE_RULES.

test("the repository's own rules catch a banned word, catch an em dash, and let source subtraction pass", () => {
  withTempDir((dir) => {
    const word = fileWith(dir, "word.md", `this works ${BANNED_WORD} now\n`);
    const dash = fileWith(dir, "dash.md", `an em dash ${EM_DASH} here\n`);
    const sub = fileWith(dir, "sub.ts", "const remaining = total - count;\n");
    assert.equal(scan(["--rules", REPO_RULES, word]).status, 1);
    assert.equal(scan(["--rules", REPO_RULES, dash]).status, 1);
    assert.equal(scan(["--rules", REPO_RULES, sub]).status, 0);
  });
});

test("--rules points at a custom file that catches only its own word", () => {
  withTempDir((dir) => {
    const rules = fileWith(dir, "rules.txt", "\\bwidget\\b\n");
    const hit = fileWith(dir, "hit.md", "a widget appears here\n");
    const miss = fileWith(dir, "miss.md", `this works ${BANNED_WORD} now\n`);
    assert.equal(scan(["--rules", rules, hit]).status, 1);
    // The repo's own banned word is not in this custom rules file at all.
    assert.equal(scan(["--rules", rules, miss]).status, 0);
  });
});

test("ADG_PROSE_RULES is used when --rules is absent", () => {
  withTempDir((dir) => {
    const rules = fileWith(dir, "rules.txt", "\\bwidget\\b\n");
    const hit = fileWith(dir, "hit.md", "a widget appears here\n");
    const r = scan([hit], undefined, { ADG_PROSE_RULES: rules });
    assert.equal(r.status, 1);
  });
});

test("--rules wins over ADG_PROSE_RULES when both are set", () => {
  withTempDir((dir) => {
    const envRules = fileWith(dir, "env-rules.txt", "\\bwidget\\b\n");
    const cliRules = fileWith(dir, "cli-rules.txt", "\\bgadget\\b\n");
    const p = fileWith(dir, "p.md", "a widget and a gadget\n");
    // ADG_PROSE_RULES alone would catch "widget"; --rules only knows "gadget".
    const withEnvOnly = scan([p], undefined, { ADG_PROSE_RULES: envRules });
    assert.equal(withEnvOnly.status, 1);
    assert.match(withEnvOnly.stdout, /widget/);
    const withBoth = scan(["--rules", cliRules, p], undefined, { ADG_PROSE_RULES: envRules });
    assert.equal(withBoth.status, 1);
    assert.match(withBoth.stdout, /gadget/);
  });
});

test("a rules file with only comments and blank lines counts as no rules", () => {
  withTempDir((dir) => {
    const rules = fileWith(dir, "empty.txt", "# just a comment\n\n   \n# another\n");
    const p = fileWith(dir, "p.md", `this works ${BANNED_WORD} now\n`);
    const r = scan(["--rules", rules, p]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /no prose rules are configured/);
  });
});

test("no rules at all: exit 0, a plain message, and not the usual scanned-files line", () => {
  withTempDir((dir) => {
    // No --rules, no ADG_PROSE_RULES, and dir has no .adg/prose-rules.txt of
    // its own (it is not even a git repository, so the default lookup finds
    // nothing to look in).
    const p = fileWith(dir, "p.md", `this works ${BANNED_WORD} now\n`);
    const r = scan([p], dir, { ADG_PROSE_RULES: "" });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /no prose rules are configured/);
    assert.doesNotMatch(r.stdout, /scanned \d+ file/);
  });
});

test("--require-rules with no rules configured exits 2", () => {
  withTempDir((dir) => {
    const p = fileWith(dir, "p.md", "nothing here\n");
    const r = scan(["--require-rules", p], dir, { ADG_PROSE_RULES: "" });
    assert.equal(r.status, 2);
  });
});

test("include: pulls in another rules file, including a nested include", () => {
  withTempDir((dir) => {
    fileWith(dir, "leaf.txt", "\\bwidget\\b\n");
    fileWith(dir, "mid.txt", "include: leaf.txt\n");
    const root = fileWith(dir, "root.txt", "include: mid.txt\n");
    const hit = fileWith(dir, "hit.md", "a widget appears here\n");
    const r = scan(["--rules", root, hit]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /widget/);
  });
});

test(
  "a cycle of includes stops with an error and exits 2 instead of hanging",
  { timeout: 10_000 },
  () => {
    withTempDir((dir) => {
      fileWith(dir, "a.txt", "include: b.txt\n");
      fileWith(dir, "b.txt", "include: a.txt\n");
      const p = fileWith(dir, "p.md", "nothing here\n");
      const r = scan(["--rules", join(dir, "a.txt"), p]);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /cycle/i);
    });
  },
);

test("exclude: keeps a file out of the default scan", () => {
  withTempDir((dir) => {
    initRepo(dir);
    // initRepo already wrote a rules file catching BANNED_WORD; add an
    // exclude for the file that would otherwise be caught.
    writeFileSync(
      join(dir, ".adg", "prose-rules.txt"),
      `\\b${BANNED_WORD}\\b\nexclude: excluded.md\n`,
    );
    fileWith(dir, "excluded.md", `this works ${BANNED_WORD} now\n`);
    fileWith(dir, "kept.md", "nothing wrong here\n");
    execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
    const r = scan([], dir);
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /excluded\.md/);
  });
});

test("prose-only: applies to a markdown file and not to a TypeScript file", () => {
  withTempDir((dir) => {
    const rules = fileWith(dir, "rules.txt", "prose-only: \\bwidget\\b\n");
    const md = fileWith(dir, "p.md", "a widget appears here\n");
    const ts = fileWith(dir, "p.ts", "const widget = 1;\n");
    assert.equal(scan(["--rules", rules, md]).status, 1);
    assert.equal(scan(["--rules", rules, ts]).status, 0);
  });
});

test("a rules file named by --rules that does not exist exits 2", () => {
  withTempDir((dir) => {
    const p = fileWith(dir, "p.md", "nothing here\n");
    const r = scan(["--rules", join(dir, "absent-rules.txt"), p]);
    assert.equal(r.status, 2);
  });
});

// --- baselines: an existing project turns the gate on without failing on -----
// everything it already has

function widgetRules(dir: string): string {
  return fileWith(dir, "widget-rules.txt", "\\bwidget\\b\n");
}

test("--write-baseline records the current matches, exits 0, and reports the count", () => {
  withTempDir((dir) => {
    const rules = widgetRules(dir);
    const p = fileWith(dir, "p.md", "a widget here\nanother widget there\n");
    const base = join(dir, "base.txt");
    const r = scan(["--rules", rules, "--write-baseline", base, p]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /wrote 2 match/);
  });
});

test("scanning again with that baseline exits 0", () => {
  withTempDir((dir) => {
    const rules = widgetRules(dir);
    const p = fileWith(dir, "p.md", "a widget here\nanother widget there\n");
    const base = join(dir, "base.txt");
    assert.equal(scan(["--rules", rules, "--write-baseline", base, p]).status, 0);
    const r = scan(["--rules", rules, "--baseline", base, p]);
    assert.equal(r.status, 0, r.stderr);
  });
});

test("a newly added violation with the baseline in place exits 1 and names only the new one", () => {
  withTempDir((dir) => {
    const rules = widgetRules(dir);
    const p = fileWith(dir, "p.md", "a widget here\n");
    const base = join(dir, "base.txt");
    assert.equal(scan(["--rules", rules, "--write-baseline", base, p]).status, 0);
    writeFileSync(p, "a widget here\na second widget shows up\n");
    const r = scan(["--rules", rules, "--baseline", base, p]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /second widget/);
    // Only the new line is named, once.
    const occurrences = (r.stdout.match(/p\.md:/g) || []).length;
    assert.equal(occurrences, 1);
  });
});

test("fixing a recorded violation still exits 0, and reports one baseline entry not seen", () => {
  withTempDir((dir) => {
    const rules = widgetRules(dir);
    const p = fileWith(dir, "p.md", "a widget here\n");
    const base = join(dir, "base.txt");
    assert.equal(scan(["--rules", rules, "--write-baseline", base, p]).status, 0);
    writeFileSync(p, "nothing wrong here\n");
    const r = scan(["--rules", rules, "--baseline", base, p]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1 baseline entries not seen/);
  });
});

test("the same offending text moved to a different line in the same file is still forgiven", () => {
  withTempDir((dir) => {
    const rules = widgetRules(dir);
    const p = fileWith(dir, "p.md", "line one\na widget here\n");
    const base = join(dir, "base.txt");
    assert.equal(scan(["--rules", rules, "--write-baseline", base, p]).status, 0);
    writeFileSync(p, "inserted at the top\nline one\na widget here\n");
    const r = scan(["--rules", rules, "--baseline", base, p]);
    assert.equal(r.status, 0, r.stderr);
  });
});

test("a fourth copy of a line recorded three times fails", () => {
  withTempDir((dir) => {
    const rules = widgetRules(dir);
    const p = fileWith(dir, "p.md", "a widget here\na widget here\na widget here\n");
    const base = join(dir, "base.txt");
    assert.equal(scan(["--rules", rules, "--write-baseline", base, p]).status, 0);
    writeFileSync(p, "a widget here\na widget here\na widget here\na widget here\n");
    const r = scan(["--rules", rules, "--baseline", base, p]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /1 new/);
  });
});

test("the same text in a different file fails", () => {
  withTempDir((dir) => {
    const rules = widgetRules(dir);
    const p = fileWith(dir, "p.md", "a widget here\n");
    const other = fileWith(dir, "other.md", "a widget here\n");
    const base = join(dir, "base.txt");
    assert.equal(scan(["--rules", rules, "--write-baseline", base, p]).status, 0);
    const r = scan(["--rules", rules, "--baseline", base, other]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /other\.md/);
  });
});

test("--baseline naming a file that does not exist exits 2", () => {
  withTempDir((dir) => {
    const rules = widgetRules(dir);
    const p = fileWith(dir, "p.md", "a widget here\n");
    const r = scan(["--rules", rules, "--baseline", join(dir, "absent-base.txt"), p]);
    assert.equal(r.status, 2);
  });
});

test("--baseline and --write-baseline together exit 2", () => {
  withTempDir((dir) => {
    const rules = widgetRules(dir);
    const p = fileWith(dir, "p.md", "a widget here\n");
    const base = fileWith(dir, "base.txt", "");
    const r = scan(["--rules", rules, "--baseline", base, "--write-baseline", join(dir, "other-base.txt"), p]);
    assert.equal(r.status, 2);
  });
});

test("an empty baseline file behaves as no forgiveness at all", () => {
  withTempDir((dir) => {
    const rules = widgetRules(dir);
    const p = fileWith(dir, "p.md", "a widget here\n");
    const base = fileWith(dir, "base.txt", "");
    const r = scan(["--rules", rules, "--baseline", base, p]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /p\.md/);
  });
});

// --- a file grep would call binary --------------------------------------------
//
// One NUL byte anywhere in a file makes grep treat the whole file as binary.
// It still exits 0 on a match, but prints "binary file matches" to stderr and
// nothing to stdout, so the loop that counts matches saw none and the file
// passed with its banned words in place. This repository shipped exactly that
// state: hooks/test-diff-separator.ts held a literal NUL as a field separator
// and was never really scanned.

test("a banned word in a file holding a NUL byte is caught, not skipped", () => {
  withTempDir((dir) => {
    const rules = fileWith(dir, "rules.txt", `\\b${BANNED_WORD}\\b\n`);
    const doc = fileWith(dir, "doc.md", `a \u0000 byte, then ${BANNED_WORD} after it\n`);
    const r = scan(["--rules", rules, "--require-rules", doc]);
    assert.equal(r.status, 1, "a file grep calls binary passed the scan");
    assert.match(r.stdout, /1 contained matches/);
  });
});

test("no tracked file in this repository holds a NUL byte", () => {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\u0000")
    .filter((p) => p.length > 0);
  const binary = tracked.filter((p) => readFileSync(join(REPO_ROOT, p)).includes(0));
  assert.deepEqual(binary, [], "these files are invisible to the prose scan");
});
