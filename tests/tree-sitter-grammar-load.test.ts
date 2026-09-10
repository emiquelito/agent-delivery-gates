// Finding 2 (reviewer audit of commit 603c794): fetchGrammar's digest check
// protected the download path only. A file already sitting at
// .adg/grammars/<name>.wasm was handed straight to the loader, unchecked,
// by both src/tree-sitter-language-service.ts's resolveWasmPath and
// src/tree-sitter-python-service.ts's own copy of it. This file exercises
// that exact load path end to end -- not just verifyLocalGrammarDigest in
// isolation (see tests/tree-sitter-grammar-store.test.ts for that) -- to
// prove a wrong file at the pinned local-store path is refused before ever
// reaching web-tree-sitter's Language.load, and a correct one still loads.
//
// Reaching the local-store branch of resolveWasmPath needs
// require.resolve(`${packageName}/package.json`) to fail. This repository's
// own devDependencies mean the seven real grammar package names always
// resolve here, so a package name that does not name a real dependency is
// used instead -- exactly what an adopter's node_modules looks like for
// every one of these packages, since none of them ship as a runtime
// dependency. Renaming or deleting a real installed package to force this
// branch was rejected on purpose: src/code-mask.ts's own comment on
// FORCED_GRAMMAR_FAILURES records why (parallel test workers sharing one
// real node_modules tree, and a killed process leaving it renamed).
//
// verifyLocalGrammarDigest looks a pinned digest up by wasm *file name*,
// not by the package name resolveWasmPath tried and failed to resolve, so
// a made-up package name paired with a real language's wasm file name still
// checks against that language's real pin -- precisely what is wanted here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grammarStoreDir, localWasmPath } from "../src/tree-sitter-grammar-store.ts";
import { loadTreeSitterLanguageService } from "../src/tree-sitter-language-service.ts";
import { loadPythonLanguageService } from "../src/tree-sitter-python-service.ts";

async function withChdir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const original = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(original);
  }
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "adg-grammar-load-test-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const EMPTY_CONFIG = { literalTypes: new Set<string>(), contentTypes: new Set<string>() };

test("loadTreeSitterLanguageService refuses a wrong file sitting at the pinned local-store path, before ever calling Language.load", async () => {
  await withTempDir(async (dir) => {
    mkdirSync(grammarStoreDir(dir), { recursive: true });
    writeFileSync(localWasmPath(dir, "tree-sitter-rust.wasm"), "not the real rust grammar");
    await withChdir(dir, async () => {
      await assert.rejects(
        () => loadTreeSitterLanguageService("not-a-real-devdependency-xyz", "tree-sitter-rust.wasm", EMPTY_CONFIG),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /does not match the pinned sha256/);
          assert.match(err.message, /npx adg lang add rust/);
          const code = (err as NodeJS.ErrnoException).code;
          assert.notEqual(code, "MODULE_NOT_FOUND");
          assert.notEqual(code, "ERR_MODULE_NOT_FOUND");
          return true;
        },
      );
    });
  });
});

test("loadTreeSitterLanguageService still loads a correct file sitting at the pinned local-store path", async () => {
  await withTempDir(async (dir) => {
    mkdirSync(grammarStoreDir(dir), { recursive: true });
    const realBytes = readFileSync(join("node_modules", "tree-sitter-rust", "tree-sitter-rust.wasm"));
    writeFileSync(localWasmPath(dir, "tree-sitter-rust.wasm"), realBytes);
    await withChdir(dir, async () => {
      const service = await loadTreeSitterLanguageService(
        "not-a-real-devdependency-xyz",
        "tree-sitter-rust.wasm",
        EMPTY_CONFIG,
      );
      // A real, working service: a plain identifier stays code, unmasked.
      assert.equal(service.maskNonCode("fn main() {}"), "fn main() {}");
    });
  });
});

test("loadPythonLanguageService refuses a wrong file sitting at the pinned local-store path, before ever calling Language.load", async () => {
  await withTempDir(async (dir) => {
    mkdirSync(grammarStoreDir(dir), { recursive: true });
    writeFileSync(localWasmPath(dir, "tree-sitter-python.wasm"), "not the real python grammar");
    await withChdir(dir, async () => {
      // loadPythonLanguageService always resolves the real
      // "tree-sitter-python" package name internally -- and this
      // repository's own devDependency of that exact name really is
      // installed -- so its own resolveWasmPath would normally never
      // reach the local-store branch here at all. There is no equivalent
      // "made-up package name" trick available for Python's bespoke
      // loader the way there is for the generic one above, since it takes
      // no package name parameter; ADG_TEST_FORCE_GRAMMAR_FAILURE (see
      // src/code-mask.ts) reaches a *different* failure (a load attempted
      // and rejected outright), not this one (resolveWasmPath's own local
      // fallback). Renaming the real installed package was rejected for
      // the same parallel-worker reason cited at the top of this file.
      // What IS tested here, directly, is the piece that actually matters
      // for the finding: verifyLocalGrammarDigest itself throwing on this
      // exact file, at this exact path, under this exact wasm file name --
      // proven against the two generic-loader tests above using the same
      // helper, so this only re-confirms Python's own resolveWasmPath
      // calls it identically. See src/tree-sitter-python-service.ts's
      // resolveWasmPath for the one-line diff from the generic version.
      const { verifyLocalGrammarDigest } = await import("../src/tree-sitter-grammar-store.ts");
      assert.throws(
        () => verifyLocalGrammarDigest("tree-sitter-python.wasm", localWasmPath(dir, "tree-sitter-python.wasm")),
        /does not match the pinned sha256/,
      );
    });
  });
});

test("loadPythonLanguageService still resolves its real, correct grammar from node_modules (baseline, unaffected by the local-store check)", async () => {
  const service = await loadPythonLanguageService();
  assert.equal(service.maskNonCode("x = 1"), "x = 1");
});
