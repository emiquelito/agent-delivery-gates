// Tests for hooks/scan-prose.ts, the TypeScript prose scan. Every test
// spawns the CLI as a real subprocess and asserts on exit code and output,
// the contract a caller actually sees.
//
// Every case in tests/scan-prose.test.ts, which covers the bash script this
// file's subject was ported from, is repeated here against the port. The two
// implementations are held to one behaviour on purpose: while both are in
// the tree, a divergence has to show up as a failing test and not as an
// opinion about which one is right.
//
// Fixtures live under a fresh directory in os.tmpdir() per test and are
// removed afterward. Nothing here ever touches this repository's own tree.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "hooks", "scan-prose.ts");
const REPO_ROOT = join(HERE, "..");
const REPO_RULES = join(REPO_ROOT, ".adg", "prose-rules.txt");

// Fixtures have to contain the words the gate rejects, and the gate reads
// this file. Building them at runtime keeps the gate strict, with no
// exemption for its own tests, which would be the wrong thing to add here.
const BANNED_WORD = "seam" + "lessly";
const BANNED_UPPER = BANNED_WORD.toUpperCase();
const EM_DASH = "\u2014";
const NUL = "\u0000";

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function scan(args: string[], cwd?: string, env?: Record<string, string>): Run {
  const r = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "adg-prose-scan-cli-test-"));
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

test("every source extension is read as code, and a plain .txt file as prose", () => {
  withTempDir((dir) => {
    for (const name of ["a.ts", "a.tsx", "a.js", "a.mjs", "a.cjs", "a.sh", "b.TSX", "b.Sh"]) {
      const p = fileWith(dir, name, "const remaining = total - count;\n");
      assert.equal(scan(["--rules", REPO_RULES, p]).status, 0, name);
    }
    for (const name of ["a.txt", "a.md", "a.json", "README"]) {
      const p = fileWith(dir, name, "the total - the count\n");
      assert.equal(scan(["--rules", REPO_RULES, p]).status, 1, name);
    }
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

test("a symlink whose target does not exist exits 2 and says so", () => {
  withTempDir((dir) => {
    const link = join(dir, "dangling.md");
    symlinkSync(join(dir, "absent.md"), link);
    const r = scan([link]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /symlink whose target does not exist/);
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

// With no arguments the scan reads what git tracks. Narrowing that list is
// invisible to every test that passes explicit paths, so this builds a real
// repository and checks each covered kind of file is picked up.
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

test("default mode picks up a file that is new and not yet committed", () => {
  withTempDir((dir) => {
    initRepo(dir);
    fileWith(dir, "brand-new.md", `this works ${BANNED_WORD} now\n`);
    const r = scan([], dir);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /brand-new\.md:1:/);
  });
});

test("default mode on a repository holding no file of a scanned kind says nothing was tracked", () => {
  withTempDir((dir) => {
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
    // A ".rules" file is outside the extensions the default list asks git
    // for, so the repository has rules and no file to apply them to.
    const rules = fileWith(dir, "house.rules", "\\bwidget\\b\n");
    const r = scan(["--rules", rules], dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /nothing tracked to scan/);
  });
});

test("a shell script is read as code, so subtraction passes", () => {
  withTempDir((dir) => {
    const p = fileWith(dir, "calc.sh", "n=$(( total - count ))\n");
    assert.equal(scan([p]).status, 0);
  });
});

// --- rules files: where they come from, and what they can say ---------------

// Explicit-path invocations run with no cwd override, so the scan falls back
// to the test runner's own working directory, which is this repository. That
// makes the repository's own .adg/prose-rules.txt the rules file in effect
// for every test above this point that passes neither --rules nor
// ADG_PROSE_RULES.

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

test("--rules=PATH in one argument works the same as two", () => {
  withTempDir((dir) => {
    const rules = fileWith(dir, "rules.txt", "\\bwidget\\b\n");
    const hit = fileWith(dir, "hit.md", "a widget appears here\n");
    assert.equal(scan([`--rules=${rules}`, hit]).status, 1);
  });
});

test("--rules with no path argument exits 2", () => {
  const r = scan(["--rules"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--rules requires a path argument/);
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
    assert.match(r.stderr, /no prose rules are configured/);
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

test("an include is resolved against the including file's own directory", () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, "nested"));
    fileWith(dir, "nested/leaf.txt", "\\bwidget\\b\n");
    fileWith(dir, "nested/mid.txt", "include: leaf.txt\n");
    const root = fileWith(dir, "root.txt", "include: nested/mid.txt\n");
    const hit = fileWith(dir, "hit.md", "a widget appears here\n");
    assert.equal(scan(["--rules", root, hit]).status, 1);
  });
});

test("an include naming a file that does not exist exits 2", () => {
  withTempDir((dir) => {
    const root = fileWith(dir, "root.txt", "include: absent.txt\n");
    const p = fileWith(dir, "p.md", "nothing here\n");
    const r = scan(["--rules", root, p]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /does not exist/);
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

test("a rules file that includes itself exits 2", { timeout: 10_000 }, () => {
  withTempDir((dir) => {
    const self = fileWith(dir, "self.txt", "include: self.txt\n");
    const p = fileWith(dir, "p.md", "nothing here\n");
    const r = scan(["--rules", self, p]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /cycle/i);
  });
});

test("the same rules file included twice down two branches is not a cycle", () => {
  withTempDir((dir) => {
    fileWith(dir, "leaf.txt", "\\bwidget\\b\n");
    fileWith(dir, "one.txt", "include: leaf.txt\n");
    fileWith(dir, "two.txt", "include: leaf.txt\n");
    const root = fileWith(dir, "root.txt", "include: one.txt\ninclude: two.txt\n");
    const hit = fileWith(dir, "hit.md", "a widget appears here\n");
    assert.equal(scan(["--rules", root, hit]).status, 1);
  });
});

test("exclude: keeps a file out of the default scan", () => {
  withTempDir((dir) => {
    initRepo(dir);
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

test("exclude: does not apply to a file named on the command line", () => {
  withTempDir((dir) => {
    const rules = fileWith(dir, "rules.txt", "\\bwidget\\b\nexclude: named.md\n");
    const named = fileWith(dir, "named.md", "a widget appears here\n");
    assert.equal(scan(["--rules", rules, named]).status, 1);
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

test("a rules file holding only prose-only fragments leaves a source file alone", () => {
  withTempDir((dir) => {
    // An empty pattern for source files must never be handed to a matcher:
    // an empty extended regex matches every line, which would fail the file.
    const rules = fileWith(dir, "rules.txt", "prose-only: \\bwidget\\b\n");
    const ts = fileWith(dir, "p.ts", "const a = 1;\nconst b = 2;\n");
    const r = scan(["--rules", rules, ts]);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /scanned 1 file\(s\), 0 contained matches/);
  });
});

test("a rules file named by --rules that does not exist exits 2", () => {
  withTempDir((dir) => {
    const p = fileWith(dir, "p.md", "nothing here\n");
    const r = scan(["--rules", join(dir, "absent-rules.txt"), p]);
    assert.equal(r.status, 2);
  });
});

test("ADG_PROSE_RULES naming a file that does not exist exits 2", () => {
  withTempDir((dir) => {
    const p = fileWith(dir, "p.md", "nothing here\n");
    const r = scan([p], undefined, { ADG_PROSE_RULES: join(dir, "absent-rules.txt") });
    assert.equal(r.status, 2);
  });
});

// --- POSIX extended regex, translated for JavaScript -------------------------
//
// Rules files hold POSIX extended regular expressions written for grep -E.
// JavaScript has no POSIX character classes, so the scan translates the ones
// it knows and refuses the rest by name. A refusal is exit 2: a pattern that
// quietly meant something else would report clean having looked for the
// wrong text.

const POSIX_CASES: ReadonlyArray<[string, string, string]> = [
  ["alpha", "[[:alpha:]]+", "letters"],
  ["digit", "[[:digit:]]+", "12345"],
  ["alnum", "[[:alnum:]]+", "abc123"],
  ["upper", "[[:upper:]]+", "ABC"],
  ["lower", "[[:lower:]]+", "abc"],
  ["space", "a[[:space:]]b", "a b"],
  ["punct", "[[:punct:]]+", "a;;b"],
];

for (const [name, fragment, hit] of POSIX_CASES) {
  test(`the POSIX class [:${name}:] is translated and still matches`, () => {
    withTempDir((dir) => {
      const rules = fileWith(dir, "rules.txt", `${fragment}\n`);
      const p = fileWith(dir, "p.md", `${hit}\n`);
      const r = scan(["--rules", rules, "--require-rules", p]);
      assert.equal(r.status, 1, `[:${name}:] matched nothing: ${r.stderr}`);
    });
  });
}

test("a POSIX class inside a wider bracket expression is translated", () => {
  withTempDir((dir) => {
    const rules = fileWith(dir, "rules.txt", "x[[:digit:]qrs]y\n");
    const hit = fileWith(dir, "hit.md", "x7y\n");
    const alsoHit = fileWith(dir, "also.md", "xqy\n");
    const miss = fileWith(dir, "miss.md", "xzy\n");
    assert.equal(scan(["--rules", rules, "--require-rules", hit]).status, 1);
    assert.equal(scan(["--rules", rules, "--require-rules", alsoHit]).status, 1);
    assert.equal(scan(["--rules", rules, "--require-rules", miss]).status, 0);
  });
});

test("a negated bracket expression holding a POSIX class is translated", () => {
  withTempDir((dir) => {
    const rules = fileWith(dir, "rules.txt", "q[^[:space:]]q\n");
    const hit = fileWith(dir, "hit.md", "qxq\n");
    const miss = fileWith(dir, "miss.md", "q q\n");
    assert.equal(scan(["--rules", rules, "--require-rules", hit]).status, 1);
    assert.equal(scan(["--rules", rules, "--require-rules", miss]).status, 0);
  });
});

test("[:space:] does not stretch to a non-breaking space the way JavaScript's \\s would", () => {
  withTempDir((dir) => {
    const rules = fileWith(dir, "rules.txt", "a[[:space:]]b\n");
    const miss = fileWith(dir, "miss.md", "a\u00a0b\n");
    assert.equal(scan(["--rules", rules, "--require-rules", miss]).status, 0);
  });
});

test("a POSIX class this scan cannot translate exits 2 and names the fragment", () => {
  withTempDir((dir) => {
    const rules = fileWith(dir, "rules.txt", "[[:xdigit:]]+\n");
    const p = fileWith(dir, "p.md", "abc123\n");
    const r = scan(["--rules", rules, "--require-rules", p]);
    assert.equal(r.status, 2, "an untranslatable class was quietly accepted");
    assert.match(r.stderr, /\[:xdigit:\]/);
    assert.match(r.stderr, /\[\[:xdigit:\]\]\+/);
  });
});

test("a GNU-only word anchor exits 2 instead of compiling to something else", () => {
  withTempDir((dir) => {
    const rules = fileWith(dir, "rules.txt", "\\<widget\\>\n");
    const p = fileWith(dir, "p.md", "a widget here\n");
    const r = scan(["--rules", rules, "--require-rules", p]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /GNU-only anchor/);
  });
});

test("a fragment JavaScript will not compile exits 2 and names it", () => {
  withTempDir((dir) => {
    const rules = fileWith(dir, "rules.txt", "a{2,1}\n");
    const p = fileWith(dir, "p.md", "aa\n");
    const r = scan(["--rules", rules, "--require-rules", p]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /cannot use the rule fragment/);
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

test("a written baseline holds the header and one sorted entry per key", () => {
  withTempDir((dir) => {
    const rules = widgetRules(dir);
    const p = fileWith(dir, "p.md", "a widget here\na widget here\nzz widget\n");
    const base = join(dir, "base.txt");
    assert.equal(scan(["--rules", rules, "--write-baseline", base, p]).status, 0);
    const written = readFileSync(base, "utf8");
    assert.match(written, /^# Prose scan baseline/);
    const entries = written.split("\n").filter((l) => l !== "" && !l.startsWith("#"));
    assert.deepEqual(entries, [`2\t${p}\ta widget here`, `1\t${p}\tzz widget`]);
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

test("a third copy of a line recorded three times is still forgiven", () => {
  withTempDir((dir) => {
    const rules = widgetRules(dir);
    const p = fileWith(dir, "p.md", "a widget here\na widget here\na widget here\n");
    const base = join(dir, "base.txt");
    assert.equal(scan(["--rules", rules, "--write-baseline", base, p]).status, 0);
    const r = scan(["--rules", rules, "--baseline", base, p]);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /3 found, 3 forgiven, 0 new/);
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

test("leading and trailing whitespace does not change a baseline key", () => {
  withTempDir((dir) => {
    const rules = widgetRules(dir);
    const p = fileWith(dir, "p.md", "a widget here\n");
    const base = join(dir, "base.txt");
    assert.equal(scan(["--rules", rules, "--write-baseline", base, p]).status, 0);
    writeFileSync(p, "      a widget here   \n");
    assert.equal(scan(["--rules", rules, "--baseline", base, p]).status, 0);
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
    const r = scan([
      "--rules",
      rules,
      "--baseline",
      base,
      "--write-baseline",
      join(dir, "other-base.txt"),
      p,
    ]);
    assert.equal(r.status, 2);
  });
});

test("a malformed baseline entry exits 2", () => {
  withTempDir((dir) => {
    const rules = widgetRules(dir);
    const p = fileWith(dir, "p.md", "a widget here\n");
    const base = fileWith(dir, "base.txt", `not-a-count\t${p}\ta widget here\n`);
    const r = scan(["--rules", rules, "--baseline", base, p]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /malformed entry/);
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

test("--write-baseline with no rules configured writes an empty baseline and exits 0", () => {
  withTempDir((dir) => {
    const p = fileWith(dir, "p.md", "a widget here\n");
    const base = join(dir, "base.txt");
    const r = scan(["--write-baseline", base, p], dir, { ADG_PROSE_RULES: "" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /wrote 0 match\(es\)/);
    assert.match(readFileSync(base, "utf8"), /^# Prose scan baseline/);
  });
});

// --- a file a line-oriented tool would call binary ----------------------------
//
// One NUL byte anywhere in a file made grep treat the whole file as binary.
// It still exited 0 on a match, but printed "binary file matches" and nothing
// else, so the loop counting matches saw none and the file passed with its
// banned words in place. Reading bytes as text removes the trap; the
// behaviour it protects is tested here so it cannot come back.

test("a banned word in a file holding a NUL byte is caught, not skipped", () => {
  withTempDir((dir) => {
    const rules = fileWith(dir, "rules.txt", `\\b${BANNED_WORD}\\b\n`);
    const doc = fileWith(dir, "doc.md", `a ${NUL} byte, then ${BANNED_WORD} after it\n`);
    const r = scan(["--rules", rules, "--require-rules", doc]);
    assert.equal(r.status, 1, "a file a line-oriented tool calls binary passed the scan");
    assert.match(r.stdout, /1 contained matches/);
  });
});

test("no tracked file in this repository holds a NUL byte", () => {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split(NUL)
    .filter((p) => p.length > 0);
  const binary = tracked.filter((p) => readFileSync(join(REPO_ROOT, p)).includes(0));
  assert.deepEqual(binary, [], "these files are invisible to the prose scan");
});

// --- fenced code blocks in prose files ---------------------------------------
//
// A fenced block in a markdown file holds quoted evidence: a command and what
// it printed. A typographic prose-only rule firing in there would ask for real
// output to be edited to please a style rule, which would falsify the evidence
// the file exists to show. Word bans still apply everywhere.

test("a prose-only rule does not fire inside a fenced code block", () => {
  withTempDir((dir) => {
    const rules = fileWith(dir, "rules.txt", "prose-only: [[:alpha:]] - [[:alpha:]]\n");
    const doc = fileWith(dir, "doc.md", ["```", "total: a - b", "```", ""].join("\n"));
    const r = scan(["--rules", rules, "--require-rules", doc]);
    assert.equal(r.status, 0, "quoted output was flagged for a typographic rule");
  });
});

test("a prose-only rule still fires outside a fenced code block", () => {
  withTempDir((dir) => {
    const rules = fileWith(dir, "rules.txt", "prose-only: [[:alpha:]] - [[:alpha:]]\n");
    const doc = fileWith(dir, "doc.md", ["```", "code a - b", "```", "", "prose a - b", ""].join("\n"));
    const r = scan(["--rules", rules, "--require-rules", doc]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /prose a - b/);
    assert.doesNotMatch(r.stdout, /code a - b/);
  });
});

test("a banned word is still caught inside a fenced code block", () => {
  withTempDir((dir) => {
    const rules = fileWith(dir, "rules.txt", `\\b${BANNED_WORD}\\b\n`);
    const doc = fileWith(dir, "doc.md", ["```", `${BANNED_WORD} in a fence`, "```", ""].join("\n"));
    const r = scan(["--rules", rules, "--require-rules", doc]);
    assert.equal(r.status, 1, "a word ban stopped applying inside a fence");
  });
});

test("an indented fence opens a block, and text after the closing fence is prose again", () => {
  withTempDir((dir) => {
    const rules = fileWith(dir, "rules.txt", "prose-only: [[:alpha:]] - [[:alpha:]]\n");
    const doc = fileWith(
      dir,
      "doc.md",
      ["  ```", "inside a - b", "  ```", "after a - b", ""].join("\n"),
    );
    const r = scan(["--rules", rules, "--require-rules", doc]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /after a - b/);
    assert.doesNotMatch(r.stdout, /inside a - b/);
  });
});

test("the fence rule does not apply to a source file", () => {
  withTempDir((dir) => {
    const rules = fileWith(dir, "rules.txt", "\\bwidget\\b\n");
    const ts = fileWith(dir, "p.ts", ["// ```", "const widget = 1;", "// ```", ""].join("\n"));
    const r = scan(["--rules", rules, "--require-rules", ts]);
    assert.equal(r.status, 1);
  });
});
