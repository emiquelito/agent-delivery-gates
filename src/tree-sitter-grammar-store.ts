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

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
  /**
   * The sha256 of the exact .wasm file this pinned version publishes,
   * lowercase hex. `fetchGrammar` hashes what it downloads and refuses to
   * install anything that does not match -- a wrong host, a redirect, a
   * truncated body, or a byte-for-byte-plausible but subtly wrong grammar
   * module all fail the same way. See GRAMMAR_SHA256 below for how each
   * digest was obtained.
   */
  sha256: string;
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

// The sha256 of each package's own published .wasm file, at the exact
// version pinned above. Each one was cross-checked three independent ways
// before being written here, not merely copied from a single fetch:
//   1. `npm pack <package>@<version>`, which has npm itself verify the
//      tarball against the registry's own published integrity hash before
//      it ever reaches disk -- so this starts from a tarball npm, not this
//      project, already vouched for.
//   2. This project's own devDependency copy of the same package at the
//      same pinned version (node_modules/<package>), installed by a
//      separate npm run at a different time.
//   3. A direct fetch of the exact unpkg URL fetchGrammar itself requests,
//      to confirm unpkg serves the same bytes as the registry tarball,
//      not different ones.
// All three agreed for all seven packages. Re-derive and re-check with:
//   npm pack <package>@<version> && tar xzf <tarball> && sha256sum package/<file>.wasm
const GRAMMAR_SHA256: Readonly<Record<string, string>> = {
  "tree-sitter-python": "16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47",
  "tree-sitter-rust": "f65f354215611fd94ad34134b3427eb3d58cbb745df7b6509ba722184db73d57",
  "tree-sitter-ruby": "09a96427d7c72f0613ed470cd9812223fc4a91d6a9c025c0235cc6bd59ff96f4",
  "tree-sitter-php": "d4df6a6ff08c87c3ec4f9cbb785fe09998a0cb570e03f57d7b19b3acfb146aa7",
  "tree-sitter-go": "9504573f352b20be7f2f1911754d710622aedc15afff16d5ed8fb5645681aee7",
  "tree-sitter-java": "4fdeac4ca6ca089f06c6f7e562abcac1733cd465728cc7031ebb73c2019122c4",
  "tree-sitter-c-sharp": "6f69e1cae44e1c32c1eccc170dc5a9778fb94ff716f71113fe1f8c4299aa2f40",
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
  sha256: GRAMMAR_SHA256["tree-sitter-python"],
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
      sha256: GRAMMAR_SHA256[spec.packageName],
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

/**
 * Verifies a wasm file already sitting on disk, at `wasmPath`, against the
 * sha256 pinned in LANGUAGES for whichever language ships `wasmFileName`.
 * Throws when the bytes do not match; returns normally (does nothing else)
 * when they do, or when `wasmFileName` names no language this table knows
 * about (nothing to check against).
 *
 * `fetchGrammar` below already hashes what it downloads before ever writing
 * it, so a file this function refuses was never written by a call to
 * `fetchGrammar` that returned `ok: true` -- that path already only ever
 * lands a byte-for-byte match. A file that fails this check got to
 * `.adg/grammars/` some other way: written before this project pinned a
 * digest for it at all, copied in from another machine, committed into a
 * repository by hand or by a compromised build step, or corrupted on disk
 * after a good install. This function does not attempt to tell those apart
 * -- it cannot, from the bytes alone -- it only refuses to trust any of
 * them.
 *
 * This is deliberately not the same fact as src/code-mask.ts's
 * `grammarGenuineFailures` ("the package resolved but the load still
 * failed: a corrupt wasm file, an ABI mismatch, a truncated install"), even
 * though a digest failure ends up routed through that same bucket once it
 * reaches code-mask.ts (see the two callers of this function for how: an
 * error thrown here carries no MODULE_NOT_FOUND/ERR_MODULE_NOT_FOUND code,
 * so it can never read as "never installed" -- isModuleAbsenceError's
 * guard on the error code alone already keeps it out of that bucket, with
 * no change needed here). "Installed and broken" describes a file that
 * came from a real install and stopped working; this describes a file that
 * was never verified as the thing it claims to be in the first place, at
 * any point. The two are worth the same reaction, blocking, which is why
 * no third bucket was built for this in code-mask.ts -- but they are not
 * the same story, which is why this function's own message says exactly
 * what it found, not "your install is broken".
 *
 * Cost: this reads the whole file into memory and hashes it. Measured
 * against this project's own largest grammar (tree-sitter-c-sharp's wasm,
 * about 3.8MB) on ordinary developer hardware, sha256 over bytes already
 * read from disk runs in low single-digit milliseconds -- see this fix's
 * own measurement notes for the actual numbers. That cost is paid once per
 * language per process (the two callers below are each reached through a
 * loader that resolveTreeSitterService/resolvePythonLanguageService in
 * src/code-mask.ts caches after the first call), not once per file
 * scanned, so a gate run touching a thousand Python files still hashes the
 * grammar exactly once.
 */
export function verifyLocalGrammarDigest(wasmFileName: string, wasmPath: string): void {
  const entry = LANGUAGES.find((candidate) => candidate.wasmFileName === wasmFileName);
  if (entry === undefined) return;
  const bytes = readFileSync(wasmPath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== entry.sha256) {
    throw new Error(
      `'${wasmPath}' does not match the pinned sha256 for ${entry.packageName}@${entry.version} ` +
        `(expected ${entry.sha256}, found ${digest}). Refusing to load it: this file was never ` +
        `verified by a fetchGrammar download that actually matched -- it may be left over from ` +
        `before this check existed, or it may have been placed there some other way. Delete it and ` +
        `run 'npx adg lang add ${entry.name}' to fetch a verified copy.`,
    );
  }
}

// A grammar store directory holds nothing but a fetch cache: every file in
// it is either written by fetchGrammar's own verified download, or refused
// at load time by verifyLocalGrammarDigest above. Writing this once, the
// first time this directory is created, means a project's own `git add -A`
// (or an agent's) does not sweep a fetched .wasm file into a commit, where
// it would sit unverified against every future clone -- exactly the state
// this file's digest check exists to catch. `!.gitignore` keeps the marker
// itself trackable, so the intent is visible in the directory even if
// nothing else in it ever is.
function ensureGrammarStoreGitignore(dir: string): void {
  const gitignorePath = join(dir, ".gitignore");
  if (existsSync(gitignorePath)) return;
  try {
    writeFileSync(
      gitignorePath,
      "# Fetched by `adg lang add` / `adg init`. A cache, not source -- do not commit it.\n" +
        "*\n" +
        "!.gitignore\n",
    );
  } catch {
    // Best effort: a failed write here is not worth failing an otherwise-
    // successful grammar install over.
  }
}

export interface FetchGrammarResult {
  ok: boolean;
  message: string;
  path?: string;
}

/**
 * How long `fetchGrammar` waits, from the start of the request to the last
 * byte of the body, before giving up. A server that accepts the connection
 * and never answers -- or answers and then stalls mid-body -- would
 * otherwise hang the calling command forever, with nothing to kill it but
 * an external signal. 20 seconds is generous for the largest of these
 * files (tree-sitter-c-sharp's wasm, about 3.8MB) even on a slow link,
 * while still being a bounded wait a script can rely on.
 */
const FETCH_TIMEOUT_MS = 20_000;

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
 * Three things a hostile or merely broken server could do are refused
 * before anything is written:
 *   - A redirect anywhere else is refused outright (`redirect: "error"`),
 *     not merely followed and trusted. unpkg does not redirect a request
 *     that already names an exact version and file (verified live before
 *     this was written), so this costs nothing in the ordinary case and
 *     means the bytes this function considers come from the host it asked,
 *     never a host a redirect chain quietly substituted.
 *   - Whatever bytes do arrive are hashed and checked against `entry`'s
 *     pinned sha256 before the write. Plain text, an empty body, a
 *     different package's wasm, or a well-formed module implementing a
 *     subtly wrong grammar all fail this check the same way a corrupted
 *     download does: the digest does not match, so nothing is installed.
 *   - The whole request, connection through last byte, is bounded by
 *     FETCH_TIMEOUT_MS. A connection accepted and never answered, or a
 *     body that stops arriving partway through, ends in a reported
 *     failure instead of a hang.
 *
 * Both the initial connect and the read of the response body are inside
 * the same try/catch: a connection dropped after headers arrive throws
 * from `response.arrayBuffer()`, not from `fetch()` itself, and is caught
 * here the same clean way as every other failure in this function instead
 * of escaping as a raw stack trace.
 *
 * Writes through a temp file and renames into place, so a run interrupted
 * mid-download (a killed process, a dropped connection) never leaves a
 * truncated .wasm file where the loader would find and try to parse it as
 * whole; either the rename lands and the file is complete, or nothing at
 * the final path changes at all.
 */
export async function fetchGrammar(
  entry: LanguageEntry,
  root: string,
  options?: { timeoutMs?: number },
): Promise<FetchGrammarResult> {
  const url = `https://unpkg.com/${entry.packageName}@${entry.version}/${entry.wasmFileName}`;
  const timeoutMs = options?.timeoutMs ?? FETCH_TIMEOUT_MS;
  let bytes: Uint8Array;
  try {
    const response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return { ok: false, message: `fetching ${url} failed: HTTP ${response.status}` };
    }
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (err) {
    // undici's own fetch() collapses a refused redirect to the generic
    // TypeError "fetch failed" -- indistinguishable, by message alone,
    // from a DNS failure, a refused connection, or any other network
    // error. The actual reason lives on `.cause` (here, "unexpected
    // redirect"; confirmed live against a local server that answers with
    // a 302 while this function's own `redirect: "error"` is set).
    // Appended when present so a refused redirect reads as what it is
    // instead of a generic "could not reach" message a person has to
    // guess at.
    const cause = (err as Error & { cause?: unknown }).cause;
    const causeMessage = cause instanceof Error ? cause.message : undefined;
    const detail = causeMessage !== undefined ? `${(err as Error).message} (${causeMessage})` : (err as Error).message;
    return { ok: false, message: `could not reach ${url}: ${detail}` };
  }

  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== entry.sha256) {
    return {
      ok: false,
      message:
        `downloaded ${url} (${bytes.length} bytes) but its sha256 (${digest}) does not match the ` +
        `pinned digest for ${entry.packageName}@${entry.version} (${entry.sha256}) -- refusing to install it`,
    };
  }

  const dir = grammarStoreDir(root);
  mkdirSync(dir, { recursive: true });
  ensureGrammarStoreGitignore(dir);
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
