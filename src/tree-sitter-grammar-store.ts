// Where an adopter's tree-sitter grammars live, and how `adg lang add`
// fetches one.
//
// web-tree-sitter is a real dependency of this package now (see
// package.json): MIT licensed, no dependencies of its own, about 4.7MB
// unpacked, and the wasm grammar it loads has no capability to open a
// socket, read a file it was not handed, or make a syscall -- so carrying
// it as a dependency costs one direct package and zero transitive ones.
// That is the whole of what "no API key, zero dependencies" used to
// promise, still true under a different, honest label.
//
// The seven grammar packages stay devDependencies of THIS repository --
// this project's own differential tests need them installed -- but are
// never a dependency an adopter's `npm install` reaches: installing all
// seven the ordinary way pulls about 180MB, because each one vendors
// copies of the others and ships native prebuilds for platforms this
// project's WASM-only loader never touches. What is actually small is the
// plain .wasm file each package carries next to those prebuilds (0.2MB for
// Go up to 3.8MB for C#). `adg lang add <language>` fetches just that one
// file, for just the language asked for, from unpkg -- a plain static file
// server over an npm package's own published tarball, not an `npm install`
// -- and writes it to `.adg/grammars/` in the adopter's own project. That
// directory, not node_modules, is where an adopter's grammars live; see
// tree-sitter-language-service.ts and tree-sitter-python-service.ts for the
// loader change that looks there once node_modules resolution fails.
//
// The one rule this file exists to keep: nothing here ever runs from a gate.
// `fetchGrammar` is reached only from `adg lang add` and, with a person's
// explicit yes, from `adg init` -- both are things a person runs once, on
// purpose, never something `check`, `mutate`, `census`, `induce`, or
// `test-diff` calls on your behalf.

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GRAMMAR_SPECS } from "./tree-sitter-grammars.ts";

/** One language `adg lang add` knows how to install. */
export interface LanguageEntry {
  /** The name `adg lang add <name>` takes, e.g. "python". */
  name: string;
  /** The lowercase file extension this language owns, e.g. ".py". */
  ext: string;
  packageName: string;
  wasmFileName: string;
  /**
   * Pinned to the exact version this project's own differential tests were
   * built and checked against (see package.json's devDependencies for the
   * same numbers, without the caret). Not "latest": a newer grammar release
   * can rename or restructure a node type a config in tree-sitter-grammars.ts
   * depends on, and that config was only ever checked against this version.
   */
  version: string;
}

// One version per grammar package, matching package.json's devDependencies
// exactly (the caret stripped: a fetch needs one real version, not a range).
// Bumping a grammar here without also re-running this project's own
// tree-sitter-*-differential tests against the new version is exactly the
// mistake this pin exists to prevent.
const GRAMMAR_VERSIONS: Readonly<Record<string, string>> = {
  "tree-sitter-python": "0.25.0",
  "tree-sitter-rust": "0.24.0",
  "tree-sitter-ruby": "0.23.1",
  "tree-sitter-php": "0.24.2",
  "tree-sitter-go": "0.25.0",
  "tree-sitter-java": "0.23.5",
  "tree-sitter-c-sharp": "0.23.5",
};

const NAME_BY_EXT: Readonly<Record<string, string>> = {
  ".rs": "rust",
  ".rb": "ruby",
  ".php": "php",
  ".go": "go",
  ".java": "java",
  ".cs": "csharp",
};

const PYTHON_ENTRY: LanguageEntry = {
  name: "python",
  ext: ".py",
  packageName: "tree-sitter-python",
  wasmFileName: "tree-sitter-python.wasm",
  version: GRAMMAR_VERSIONS["tree-sitter-python"],
};

/** Every language `adg lang add` can install, one table, derived from
 * tree-sitter-grammars.ts's GRAMMAR_SPECS so a package name and wasm file
 * name are never typed twice. Python keeps its own bespoke loader (see
 * tree-sitter-python-service.ts) and so is not itself a GrammarSpec, hence
 * the one hand-written entry above. */
export const LANGUAGES: readonly LanguageEntry[] = [
  PYTHON_ENTRY,
  ...Object.entries(GRAMMAR_SPECS).map(
    ([ext, spec]): LanguageEntry => ({
      name: NAME_BY_EXT[ext],
      ext,
      packageName: spec.packageName,
      wasmFileName: spec.wasmFileName,
      version: GRAMMAR_VERSIONS[spec.packageName],
    }),
  ),
];

export function findLanguage(name: string): LanguageEntry | undefined {
  return LANGUAGES.find((entry) => entry.name === name.toLowerCase());
}

/** The language, if any, that owns `path`'s extension. */
export function languageForPath(path: string): LanguageEntry | undefined {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot === -1) return undefined;
  const ext = lower.slice(dot);
  return LANGUAGES.find((entry) => entry.ext === ext);
}

/** The directory an adopter's grammars live in, under their own project
 * root -- never node_modules, which npm never populates with this
 * package's devDependencies for anyone but this repository's own
 * checkout. */
export function grammarStoreDir(root: string): string {
  return join(root, ".adg", "grammars");
}

export function localWasmPath(root: string, wasmFileName: string): string {
  return join(grammarStoreDir(root), wasmFileName);
}

export interface FetchGrammarResult {
  ok: boolean;
  message: string;
  path?: string;
}

/**
 * Fetches one language's plain .wasm grammar from unpkg's static serving of
 * the package's own published tarball -- not `npm install`, so none of that
 * package's native prebuilds or vendored copies of the other six grammars
 * ever reach disk -- and writes it into `root`'s local grammar store.
 *
 * Network use happens only here, at the moment this is actually called:
 * `adg lang add`, or `adg init` after a person answers yes. Nothing a gate
 * runs (`check`, `mutate`, `census`, `induce`, `test-diff`, or any hook)
 * ever calls this.
 *
 * Writes through a temp file and renames into place, so a run interrupted
 * mid-download (a killed process, a dropped connection) never leaves a
 * truncated .wasm file where the loader would find and try to parse it as
 * whole; either the rename lands and the file is complete, or nothing at
 * the final path changes at all.
 */
export async function fetchGrammar(entry: LanguageEntry, root: string): Promise<FetchGrammarResult> {
  const url = `https://unpkg.com/${entry.packageName}@${entry.version}/${entry.wasmFileName}`;
  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    return { ok: false, message: `could not reach ${url}: ${(err as Error).message}` };
  }
  if (!response.ok) {
    return { ok: false, message: `fetching ${url} failed: HTTP ${response.status}` };
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const dir = grammarStoreDir(root);
  mkdirSync(dir, { recursive: true });
  const finalPath = localWasmPath(root, entry.wasmFileName);
  const tmpPath = `${finalPath}.download-${process.pid}`;
  try {
    writeFileSync(tmpPath, bytes);
    renameSync(tmpPath, finalPath);
  } finally {
    if (existsSync(tmpPath)) {
      try {
        rmSync(tmpPath, { force: true });
      } catch {
        // best effort: a failed cleanup of a stray temp file is not worth
        // failing an otherwise-successful install over
      }
    }
  }
  return { ok: true, message: `installed ${entry.name}: ${finalPath} (${bytes.length} bytes)`, path: finalPath };
}
