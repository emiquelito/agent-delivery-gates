// Tests for src/tree-sitter-grammar-store.ts: the table of languages
// `adg lang add` knows about, the local directory an adopter's grammars
// live in, and the fetch itself. `fetchGrammar` is tested against a
// stubbed `globalThis.fetch`, restored after every test that touches it,
// so this suite never makes a real network request -- consistent with
// every other test in this project, and with the one thing this whole
// phase promises: nothing but `adg lang add` (and `adg init`, with a yes)
// ever calls the real network, and even those only when a person actually
// runs them.
//
// Tests that exercise a successful install (writing bytes that must pass
// the sha256 check) use this project's own devDependency copy of the real
// wasm file as the stubbed response body -- the one set of bytes
// guaranteed to match LANGUAGES' pinned digest without this file having
// to duplicate that digest's preimage by hand.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LANGUAGES,
  findLanguage,
  languageForPath,
  grammarStoreDir,
  localWasmPath,
  fetchGrammar,
  verifyLocalGrammarDigest,
} from "../src/tree-sitter-grammar-store.ts";

/** The real wasm bytes this project's own devDependency ships for
 * `entry`, read straight from node_modules -- the same bytes LANGUAGES'
 * pinned sha256 was computed from, so a test that stubs fetch to return
 * this passes the digest check exactly like a real, correct download. */
function realWasmBytes(entry: { packageName: string; wasmFileName: string }): Uint8Array {
  const path = join("node_modules", entry.packageName, entry.wasmFileName);
  return new Uint8Array(readFileSync(path));
}

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

test("every language entry pins a full, lowercase sha256 digest", () => {
  for (const entry of LANGUAGES) {
    assert.match(entry.sha256, /^[0-9a-f]{64}$/, `${entry.name}'s sha256 '${entry.sha256}' is not a 64-char lowercase hex digest`);
  }
});

test("every pinned sha256 matches this project's own devDependency copy of that exact package version", () => {
  // A second, independent check that the table in tree-sitter-grammar-store.ts
  // was not mistyped: this project's own devDependencies are pinned to the
  // same exact versions (see package.json), installed by a separate npm
  // run, so hashing them here and comparing to the table catches a
  // transcription error the table's own self-consistency tests above
  // cannot.
  for (const entry of LANGUAGES) {
    const bytes = realWasmBytes(entry);
    const digest = createHash("sha256").update(bytes).digest("hex");
    assert.equal(digest, entry.sha256, `${entry.name}: node_modules/${entry.packageName}/${entry.wasmFileName} does not match the pinned digest`);
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
  const bytes = realWasmBytes(python);
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requestedUrl = url;
    requestedInit = init;
    return fakeResponse(true, 200, bytes);
  }) as typeof fetch;
  try {
    await withTempDirAsync(async (dir) => {
      const result = await fetchGrammar(python, dir);
      assert.equal(result.ok, true, result.message);
      assert.equal(requestedUrl, `https://unpkg.com/tree-sitter-python@${python.version}/tree-sitter-python.wasm`);
      // Refuses to follow a redirect instead of trusting one: see finding 1.
      assert.equal(requestedInit?.redirect, "error");
      const written = readFileSync(localWasmPath(dir, python.wasmFileName));
      assert.deepEqual(new Uint8Array(written), bytes);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchGrammar refuses bytes that do not match the pinned sha256, and writes nothing", async () => {
  // Stands in for the reviewer's two live cases -- a server returning
  // plain text, and a redirect to a different host serving a different
  // payload -- at the point both converge: whatever bytes fetch() hands
  // back, correct final URL or not, must still match the pin.
  const python = findLanguage("python")!;
  const garbage = new TextEncoder().encode("this is definitely not a wasm binary, just text");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => fakeResponse(true, 200, garbage)) as typeof fetch;
  try {
    await withTempDirAsync(async (dir) => {
      const result = await fetchGrammar(python, dir);
      assert.equal(result.ok, false);
      assert.match(result.message, /does not match the/);
      assert.equal(existsSync(localWasmPath(dir, python.wasmFileName)), false);
      assert.equal(existsSync(grammarStoreDir(dir)), false, "the store directory should not be created on a digest mismatch");
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchGrammar refuses a redirect instead of following it", async () => {
  // The real network behaviour (a redirect to a different host actually
  // installing) is reproduced live against real local HTTP servers as
  // part of this fix's own verification, not in this suite -- this suite
  // makes no real network request, per its own header comment. What is
  // tested here is the contract: fetchGrammar asks fetch() to refuse a
  // redirect instead of following it, and treats fetch() rejecting on one
  // (undici's actual behaviour for redirect: "error") as an ordinary,
  // clean failure.
  const rust = findLanguage("rust")!;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    assert.equal(init?.redirect, "error", "fetchGrammar must ask fetch to refuse a redirect");
    throw new TypeError("fetch failed: unexpected redirect, redirect mode is set to error");
  }) as typeof fetch;
  try {
    await withTempDirAsync(async (dir) => {
      const result = await fetchGrammar(rust, dir);
      assert.equal(result.ok, false);
      assert.match(result.message, /redirect/);
      assert.equal(existsSync(localWasmPath(dir, rust.wasmFileName)), false);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchGrammar reports a refused redirect's real cause, not only fetch()'s generic message", async () => {
  // Finding 3: undici's real fetch() (confirmed live against a local
  // server answering with a 302 while redirect: "error" is set --
  // see this fix's own verification notes) throws a TypeError whose own
  // message is only ever the generic "fetch failed", with the actual
  // reason ("unexpected redirect") on `.cause`. Before this fix, only the
  // outer message reached the report, so a refused redirect and a DNS
  // failure both read as "could not reach ...: fetch failed" -- this pins
  // that the cause is folded in when present.
  const go = findLanguage("go")!;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    const err = new TypeError("fetch failed");
    (err as TypeError & { cause?: unknown }).cause = new Error("unexpected redirect");
    throw err;
  }) as typeof fetch;
  try {
    await withTempDirAsync(async (dir) => {
      const result = await fetchGrammar(go, dir);
      assert.equal(result.ok, false);
      assert.match(result.message, /fetch failed/);
      assert.match(result.message, /unexpected redirect/);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchGrammar leaves a network error with no cause exactly as it was, no stray '(undefined)' appended", async () => {
  // Guards the other branch of the same change: a plain Error (a DNS
  // failure, say) has no `.cause` at all, and the message must come
  // through unchanged, not grown a spurious "(undefined)" suffix.
  const csharp = findLanguage("csharp")!;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("getaddrinfo ENOTFOUND unpkg.com");
  }) as typeof fetch;
  try {
    await withTempDirAsync(async (dir) => {
      const result = await fetchGrammar(csharp, dir);
      assert.equal(result.ok, false);
      assert.equal(result.message, "could not reach https://unpkg.com/tree-sitter-c-sharp@" + csharp.version + "/" + csharp.wasmFileName + ": getaddrinfo ENOTFOUND unpkg.com");
      assert.doesNotMatch(result.message, /undefined/);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchGrammar writes a .gitignore into a freshly created grammar store, so an ordinary git add does not sweep a fetched file into a commit", async () => {
  const php = findLanguage("php")!;
  const bytes = realWasmBytes(php);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => fakeResponse(true, 200, bytes)) as typeof fetch;
  try {
    await withTempDirAsync(async (dir) => {
      const result = await fetchGrammar(php, dir);
      assert.equal(result.ok, true, result.message);
      const gitignorePath = join(grammarStoreDir(dir), ".gitignore");
      assert.equal(existsSync(gitignorePath), true);
      const content = readFileSync(gitignorePath, "utf8");
      assert.match(content, /^\*$/m);
      assert.match(content, /^!\.gitignore$/m);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchGrammar does not overwrite a .gitignore an adopter already customised in the grammar store", async () => {
  const ruby = findLanguage("ruby")!;
  const bytes = realWasmBytes(ruby);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => fakeResponse(true, 200, bytes)) as typeof fetch;
  try {
    await withTempDirAsync(async (dir) => {
      mkdirSync(grammarStoreDir(dir), { recursive: true });
      writeFileSync(join(grammarStoreDir(dir), ".gitignore"), "custom\n");
      const result = await fetchGrammar(ruby, dir);
      assert.equal(result.ok, true, result.message);
      assert.equal(readFileSync(join(grammarStoreDir(dir), ".gitignore"), "utf8"), "custom\n");
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- verifyLocalGrammarDigest ---------------------------------------------
//
// Finding 2 (reviewer audit of commit 603c794): a file already sitting at
// .adg/grammars/<name>.wasm used to be trusted outright, at both the point
// init decided a grammar was already reachable and the point the loader
// actually read it -- fetchGrammar's digest check protected the download
// path and nothing else. verifyLocalGrammarDigest is the one place both of
// those callers (src/init.ts's grammarState and the two service files'
// resolveWasmPath) now go through.

test("verifyLocalGrammarDigest accepts a file whose bytes match the pinned sha256", () => {
  withTempDir((dir) => {
    const python = findLanguage("python")!;
    const path = join(dir, python.wasmFileName);
    writeFileSync(path, realWasmBytes(python));
    assert.doesNotThrow(() => verifyLocalGrammarDigest(python.wasmFileName, path));
  });
});

test("verifyLocalGrammarDigest throws on a file that does not match the pinned sha256, with the mismatch itself in the message", () => {
  withTempDir((dir) => {
    const python = findLanguage("python")!;
    const path = join(dir, python.wasmFileName);
    writeFileSync(path, "definitely not the real wasm bytes");
    assert.throws(
      () => verifyLocalGrammarDigest(python.wasmFileName, path),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, new RegExp(python.sha256));
        assert.match(err.message, /does not match the pinned sha256/);
        assert.match(err.message, /npx adg lang add python/);
        return true;
      },
    );
  });
});

test("verifyLocalGrammarDigest throws no MODULE_NOT_FOUND / ERR_MODULE_NOT_FOUND code, so it can never misclassify as 'never installed'", () => {
  // src/code-mask.ts's isModuleAbsenceError reads exactly these two codes
  // to decide whether a load failure means the package was never
  // installed at all. A digest mismatch is the opposite fact -- the
  // package IS there, in some form -- so this error must carry neither
  // code, and lands in the "installed and broken" bucket by construction, with
  // no change needed in code-mask.ts itself.
  withTempDir((dir) => {
    const rust = findLanguage("rust")!;
    const path = join(dir, rust.wasmFileName);
    writeFileSync(path, "not rust's real grammar");
    try {
      verifyLocalGrammarDigest(rust.wasmFileName, path);
      assert.fail("expected verifyLocalGrammarDigest to throw");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      assert.notEqual(code, "MODULE_NOT_FOUND");
      assert.notEqual(code, "ERR_MODULE_NOT_FOUND");
    }
  });
});

test("verifyLocalGrammarDigest is a no-op for a wasm file name this table does not know about", () => {
  withTempDir((dir) => {
    const path = join(dir, "not-a-real-grammar.wasm");
    writeFileSync(path, "anything at all");
    assert.doesNotThrow(() => verifyLocalGrammarDigest("not-a-real-grammar.wasm", path));
  });
});

test("fetchGrammar reports a body read failure (a connection dropped after headers) the same clean way, instead of throwing", async () => {
  // Finding 2a: only the initial fetch() used to be inside the try/catch,
  // so a response.arrayBuffer() rejection (a truncated body) escaped as a
  // raw, uncaught TypeError instead of a reported failure.
  const java = findLanguage("java")!;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => {
      throw new TypeError("terminated");
    },
  })) as unknown as typeof fetch;
  try {
    await withTempDirAsync(async (dir) => {
      const result = await fetchGrammar(java, dir);
      assert.equal(result.ok, false);
      assert.match(result.message, /terminated/);
      assert.equal(existsSync(localWasmPath(dir, java.wasmFileName)), false);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchGrammar passes a bounded timeout signal, and reports an abort cleanly instead of hanging", async () => {
  // Finding 2b: fetchGrammar takes an optional timeoutMs so this test can
  // exercise a real abort without a real multi-second wait. The default
  // (FETCH_TIMEOUT_MS, unexported) is proven against real local servers,
  // including one that never responds, outside this suite -- see this
  // fix's own reproduction notes.
  const csharp = findLanguage("csharp")!;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    assert.ok(init?.signal instanceof AbortSignal, "fetchGrammar must pass an abort signal");
    return new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      // AbortSignal.timeout's own timer is deliberately unref'd (it must
      // not itself keep a real process alive); a real fetch() has an open
      // socket doing that job instead. This fake one has nothing else
      // pending, so it needs its own ref'd timer or the process could
      // exit before the signal ever fires.
      const keepAlive = setTimeout(() => {}, 1000);
      signal.addEventListener("abort", () => {
        clearTimeout(keepAlive);
        reject(new DOMException("The operation was aborted.", "TimeoutError"));
      });
    });
  }) as typeof fetch;
  try {
    await withTempDirAsync(async (dir) => {
      const result = await fetchGrammar(csharp, dir, { timeoutMs: 20 });
      assert.equal(result.ok, false);
      assert.match(result.message, /abort/i);
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
  const bytes = realWasmBytes(ruby);
  const originalFetch = globalThis.fetch;
  try {
    await withTempDirAsync(async (dir) => {
      mkdirSync(grammarStoreDir(dir), { recursive: true });
      writeFileSync(localWasmPath(dir, ruby.wasmFileName), "stale");
      globalThis.fetch = (async () => fakeResponse(true, 200, bytes)) as typeof fetch;
      const result = await fetchGrammar(ruby, dir);
      assert.equal(result.ok, true, result.message);
      assert.deepEqual(new Uint8Array(readFileSync(localWasmPath(dir, ruby.wasmFileName))), bytes);
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
