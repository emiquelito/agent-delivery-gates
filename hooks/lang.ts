#!/usr/bin/env node
// `agent-delivery-gates lang list` / `lang add <language>...`
//
// Installs one or more tree-sitter grammars into the current project,
// without ever running `npm install`. See src/tree-sitter-grammar-store.ts
// for why: this repository's own devDependencies for these seven packages
// pull about 180MB combined, almost all of it native prebuilds and
// vendored duplicates this project's WASM-only loader never touches. This
// command fetches only the plain .wasm file, for only the language asked
// for, from unpkg's static serving of that package's own published
// tarball, and writes it to `.adg/grammars/` in the current project --
// where src/tree-sitter-language-service.ts and
// src/tree-sitter-python-service.ts look once node_modules resolution
// finds nothing.
//
// Network use happens only here, at this explicit invocation. Nothing a
// gate runs (check, mutate, census, induce, test-diff, or any hook) ever
// calls this file.

import process from "node:process";
import { resolve } from "node:path";
import { LANGUAGES, findLanguage, fetchGrammar, type LanguageEntry } from "../src/tree-sitter-grammar-store.ts";

const KNOWN = LANGUAGES.map((entry) => entry.name).join(", ");

const USAGE = `Usage: agent-delivery-gates lang list
       agent-delivery-gates lang add <language> [<language>...] [--dir PATH]

Installs a tree-sitter grammar's plain .wasm file into .adg/grammars/ in
the current project, so mutate and test-diff can mask that language's
strings and comments instead of falling back to the regex scanner.

Known languages: ${KNOWN}

  --dir PATH   target this directory instead of the current one
  --help, -h   print this message and exit 0

Exit codes:
  0  every named language was installed
  2  an unknown language name, a missing argument, or a download failure
`;

function fail(message: string): never {
  process.stderr.write(`agent-delivery-gates lang: ${message}\n\n`);
  process.stderr.write(USAGE);
  process.exit(2);
}

async function runAdd(argv: string[]): Promise<never> {
  let dir = process.cwd();
  const names: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dir") {
      const value = argv[++i];
      if (value === undefined) fail("--dir needs a path");
      dir = resolve(process.cwd(), value);
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(USAGE);
      process.exit(0);
    } else {
      names.push(arg);
    }
  }

  if (names.length === 0) fail("name at least one language to add");

  // Every name is validated before anything is downloaded, so a typo in a
  // list of several languages fails clearly instead of leaving the earlier
  // ones installed and silently skipping the rest -- no half-install.
  const entries: LanguageEntry[] = [];
  for (const name of names) {
    const entry = findLanguage(name);
    if (entry === undefined) fail(`unknown language '${name}'. Known languages: ${KNOWN}`);
    entries.push(entry);
  }

  let failed = false;
  for (const entry of entries) {
    const result = await fetchGrammar(entry, dir);
    process.stdout.write(`${result.ok ? "" : "FAILED: "}${result.message}\n`);
    if (!result.ok) failed = true;
  }
  process.exit(failed ? 2 : 0);
}

function runList(): never {
  for (const entry of LANGUAGES) {
    process.stdout.write(`${entry.name}\t${entry.ext}\t${entry.packageName}@${entry.version}\n`);
  }
  process.exit(0);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const sub = argv[0];

  if (sub === undefined) fail("name a subcommand: list, or add <language>");
  if (sub === "--help" || sub === "-h") {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (sub === "list") runList();
  if (sub === "add") await runAdd(argv.slice(1));
  fail(`unknown subcommand '${sub}'`);
}

main();
