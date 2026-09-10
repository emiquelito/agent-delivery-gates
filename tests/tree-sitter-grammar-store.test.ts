// Tests for src/tree-sitter-grammar-store.ts: the table of languages
// `adg lang add` knows about, the local directory an adopter's grammars
// live in, and the fetch itself. `fetchGrammar` is tested against a
// stubbed `globalThis.fetch`, restored after every test that touches it,
// so this suite never makes a real network request -- consistent with
// every other test in this project, and with the one thing this whole
// phase promises: nothing but `adg lang add` (and `adg init`, with a yes)
// ever calls the real network, and even those only when a person actually
// runs them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LANGUAGES,
  findLanguage,
  languageForPath,
  grammarStoreDir,
  localWasmPath,
  fetchGrammar,
} from "../src/tree-sitter-grammar-store.ts";

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "adg-grammar-store-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("LANGUAGES names all seven grammars this project masks with tree-sitter, once each", () => {
  const names = LANGUAGES.map((l) => l.name).sort();
  assert.deepEqual(names, ["csharp", "go", "java", "php", "python", "rust", "ruby"].sort());
  assert.equal(new Set(LANGUAGES.map((l) => l.ext)).size, LANGUAGES.length, "two languages share an extension");
});

test("every language entry names a real, pinned version, not a range", () => {
  for (const entry of LANGUAGES) {
    assert.doesNotMatch(entry.version, /[\^~*]/, `${entry.name}'s version '${entry.version}' is a range, not a pin`);
  }
});

test("findLanguage is case-insensitive and undefined for an unknown name", () => {
  assert.equal(findLanguage("python")?.packageName, "tree-sitter-python");
  assert.equal(findLanguage("PYTHON")?.packageName, "tree-sitter-python");
  assert.equal(findLanguage("cobol"), undefined);
});

test("languageForPath reads the extension, case-insensitively, and ignores an unknown one", () => {
  assert.equal(languageForPath("src/main.rs")?.name, "rust");
  assert.equal(languageForPath("SRC/Main.RB")?.name, "ruby");
  assert.equal(languageForPath("README.md"), undefined);
  assert.equal(languageForPath("no-extension"), undefined);
});

test("grammarStoreDir and localWasmPath live under .adg/grammars in the given root, not node_modules", () => {
  withTempDir((dir) => {
    assert.equal(grammarStoreDir(dir), join(dir, ".adg", "grammars"));
    assert.equal(localWasmPath(dir, "tree-sitter-python.wasm"), join(dir, ".adg", "grammars", "tree-sitter-python.wasm"));
  });
});

// A minimal fake Response, holding only the three Fetch API fields
// fetchGrammar actually reads (`ok`, `status`, `arrayBuffer`).
function fakeResponse(ok: boolean, status: number, body: Uint8Array): Response {
  return {
    ok,
    status,
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  } as unknown as Response;
}

test("fetchGrammar writes the wasm bytes to the local store, at the exact path resolveWasmPath looks for", async () => {
  const python = findLanguage("python")!;
  const bytes = new Uint8Array([0, 1, 2, 3, 4]);
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = (async (url: string) => {
    requestedUrl = url;
    return fakeResponse(true, 200, bytes);
  }) as typeof fetch;
  try {
    await withTempDirAsync(async (dir) => {
      const result = await fetchGrammar(python, dir);
      assert.equal(result.ok, true, result.message);
      assert.equal(requestedUrl, `https://unpkg.com/tree-sitter-python@${python.version}/tree-sitter-python.wasm`);
      const written = readFileSync(localWasmPath(dir, python.wasmFileName));
      assert.deepEqual(new Uint8Array(written), bytes);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchGrammar reports an HTTP failure without writing a file, and leaves no temp file behind", async () => {
  const rust = findLanguage("rust")!;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => fakeResponse(false, 404, new Uint8Array())) as typeof fetch;
  try {
    await withTempDirAsync(async (dir) => {
      const result = await fetchGrammar(rust, dir);
      assert.equal(result.ok, false);
      assert.match(result.message, /404/);
      assert.equal(existsSync(localWasmPath(dir, rust.wasmFileName)), false);
      assert.equal(existsSync(grammarStoreDir(dir)), false, "the store directory should not be created on a failed fetch");
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchGrammar reports a network error the same clean way as an HTTP failure", async () => {
  const go = findLanguage("go")!;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("getaddrinfo ENOTFOUND unpkg.com");
  }) as typeof fetch;
  try {
    await withTempDirAsync(async (dir) => {
      const result = await fetchGrammar(go, dir);
      assert.equal(result.ok, false);
      assert.match(result.message, /ENOTFOUND/);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchGrammar overwrites a previous grammar file for the same language cleanly", async () => {
  const ruby = findLanguage("ruby")!;
  const originalFetch = globalThis.fetch;
  try {
    await withTempDirAsync(async (dir) => {
      mkdirSync(grammarStoreDir(dir), { recursive: true });
      writeFileSync(localWasmPath(dir, ruby.wasmFileName), "stale");
      globalThis.fetch = (async () => fakeResponse(true, 200, new Uint8Array([9, 9, 9]))) as typeof fetch;
      const result = await fetchGrammar(ruby, dir);
      assert.equal(result.ok, true);
      assert.deepEqual(new Uint8Array(readFileSync(localWasmPath(dir, ruby.wasmFileName))), new Uint8Array([9, 9, 9]));
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

async function withTempDirAsync(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "adg-grammar-store-test-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
