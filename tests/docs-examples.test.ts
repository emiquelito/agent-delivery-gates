// Tests for the worked examples and the README: every subcommand named in
// a fenced command line, and every repo-relative path named in prose, has
// to be real. A doc that names a subcommand nobody built, or a path that
// does not exist, teaches a reader to run something that fails, or to look
// for a file that was never there.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runInit } from "../src/init.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLES_DIR = join(ROOT, "docs", "examples");
const README = join(ROOT, "README.md");

// A path a doc names does not have to exist in this checkout to be real: a
// good chunk of what the README and the examples document is what `init`
// writes into an ADOPTING project, not into this one (this repository does
// not run its own `init` on itself, so e.g. `.mcp.json` and
// `.github/workflows/agent-delivery-gates.yml` never appear here even
// though they are exactly what a reader gets). Running `init` in dry-run
// mode against an empty directory lists every relative path it would
// create, which is the ground truth for "or is one init creates" from the
// task this test enforces.
function pathsInitWouldCreate(): Set<string> {
  const dir = mkdtempSync(join(tmpdir(), "adg-docs-examples-test-"));
  try {
    const outcome = runInit({
      targetDir: dir,
      packageRoot: ROOT,
      dryRun: true,
      force: false,
      prosePreset: "house-style",
      baseline: true,
    });
    const paths = new Set<string>();
    for (const line of outcome.lines) {
      const m = /^would (?:create|overwrite): (.+)$/.exec(line);
      if (m) paths.add(m[1]);
    }
    return paths;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Local session state that a gate reads but that `init` never writes and
// this repository's own .gitignore keeps out of every checkout on purpose
// (see CLAUDE.md and .gitignore): a real path, verified against
// src/clean-tree-gate.ts, that can never exist as a tracked file.
const KNOWN_LOCAL_ONLY_PATHS = new Set([".claude/adg-phase"]);

function read(path: string): string {
  assert.ok(existsSync(path), `${path} does not exist`);
  return readFileSync(path, "utf8");
}

function docFiles(): string[] {
  return readdirSync(EXAMPLES_DIR)
    .filter((name) => name.endsWith(".md"))
    .map((name) => join(EXAMPLES_DIR, name));
}

function knownSubcommands(): Set<string> {
  return new Set(
    readFileSync(join(ROOT, "bin", "adg.ts"), "utf8")
      .split("\n")
      .flatMap((line) => [...line.matchAll(/case "([\w-]+)":/g)].map((m) => m[1])),
  );
}

// Matches "agent-delivery-gates <subcommand>" or "adg <subcommand>" the way
// the examples and the README actually write commands, including through
// "npx agent-delivery-gates ..." and "npx adg ...". Only horizontal
// whitespace separates the binary name from the subcommand: "\s" would also
// match a newline, which turns an unrelated word starting the next line or
// paragraph (a table row, a heading) into a fake "subcommand".
function subcommandsNamedIn(text: string): string[] {
  return [...text.matchAll(/\b(?:agent-delivery-gates|adg)[ \t]+([\w-]+)/g)].map((m) => m[1]);
}

// Matches a backtick-quoted repo-relative path, the way both docs name a
// file: `rules/schema.json`, `.claude/adg-phase`, `docs/gate-tally.md`. A
// path with no "/" is almost always a bare command name or flag quoted for
// emphasis (`init`, `--dry-run`), not a file, so those are skipped; every
// path this project actually documents has at least one separator.
function pathsNamedIn(text: string): string[] {
  const candidates = [...text.matchAll(/`([^`\s]+\/[^`\s]+)`/g)].map((m) => m[1]);
  return candidates.filter((p) => {
    // Drop anything that is plainly not a path this repository owns: a URL,
    // a glob some tool prints back, an environment-variable expansion, or a
    // package name from node_modules-style output.
    if (/^https?:\/\//.test(p)) return false;
    if (p.includes("*")) return false;
    if (p.includes("$")) return false;
    if (p.startsWith("~")) return false;
    return true;
  });
}

test("every command in docs/examples/ names a real subcommand", () => {
  const known = knownSubcommands();
  for (const file of docFiles()) {
    const text = read(file);
    const used = subcommandsNamedIn(text);
    for (const name of used) {
      assert.ok(known.has(name), `${file} runs 'agent-delivery-gates ${name}', which is not a real subcommand`);
    }
  }
});

test("every command in the README names a real subcommand", () => {
  const known = knownSubcommands();
  const text = read(README);
  const used = subcommandsNamedIn(text);
  assert.ok(used.length > 0, "the README runs no subcommand at all");
  for (const name of used) {
    assert.ok(known.has(name), `the README runs 'agent-delivery-gates ${name}', which is not a real subcommand`);
  }
});

function assertPathIsReal(p: string, generated: Set<string>, source: string): void {
  const ok = existsSync(join(ROOT, p)) || generated.has(p) || KNOWN_LOCAL_ONLY_PATHS.has(p);
  assert.ok(
    ok,
    `${source} names '${p}', which does not exist in the repository, is not written by 'init', ` +
      "and is not a known local-only path",
  );
}

test("every repo-relative path named in docs/examples/ exists, or is one init creates", () => {
  const generated = pathsInitWouldCreate();
  for (const file of docFiles()) {
    const text = read(file);
    for (const p of pathsNamedIn(text)) {
      assertPathIsReal(p, generated, file);
    }
  }
});

test("every repo-relative path named in the README exists, or is one init creates", () => {
  const generated = pathsInitWouldCreate();
  const text = read(README);
  const paths = pathsNamedIn(text);
  assert.ok(paths.length > 0, "the README names no path at all");
  for (const p of paths) {
    assertPathIsReal(p, generated, README);
  }
});

test("docs/examples/README.md links to every example file that exists", () => {
  const index = read(join(EXAMPLES_DIR, "README.md"));
  const exampleFiles = readdirSync(EXAMPLES_DIR).filter(
    (name) => name.endsWith(".md") && name !== "README.md",
  );
  assert.ok(exampleFiles.length > 0, "docs/examples/ has no example files");
  for (const name of exampleFiles) {
    assert.ok(index.includes(name), `docs/examples/README.md does not link to ${name}`);
  }
});
