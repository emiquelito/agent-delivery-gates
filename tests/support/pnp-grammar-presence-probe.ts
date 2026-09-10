// Standalone probe run as its own subprocess by
// tests/pnp-grammar-presence.test.ts. Not a test file itself (no `node:test`
// import, not named *.test.ts, so `npm test`'s glob never picks it up
// directly): it exists only to be spawned fresh once per mode, because
// src/code-mask.ts's resolvedServices/grammarAbsentExtensions/
// grammarGenuineFailures are permanent, module-level, once-per-process
// state -- the same reason tests/agent-adapter-grammar-load-failure.test.ts
// already runs its own case as a subprocess.
//
// Reproduces a real Yarn Plug'n'Play environment's two defining facts for
// one grammar package (tree-sitter-rust, chosen arbitrarily among the
// six src/tree-sitter-grammars.ts entries -- nothing below is Rust-specific)
// without creating one and without touching this repository's real
// node_modules at all:
//
//   1. There is no real node_modules directory tree to walk on disk. An
//      actual PnP install never creates one; simulated here by making
//      Module._resolveLookupPaths (what `require.resolve.paths` calls
//      internally) report "no candidate directories" for exactly the two
//      package names src/code-mask.ts's TREE_SITTER_LOADERS[".rs"] cares
//      about, leaving every other module resolution in this process --
//      including the real web-tree-sitter and tree-sitter-rust loads this
//      probe still needs to reach the code under test -- untouched.
//   2. `require("pnpapi")` answers presence questions instead. Simulated
//      by making Module._load return a stub PnpApi (see src/code-mask.ts's
//      own PnpApi interface) when asked for "pnpapi", with
//      `resolveToUnqualified` behaving per `process.argv[2]`:
//        "present"     -- returns a path (package is a declared dependency)
//        "absent"      -- throws an error carrying code MODULE_NOT_FOUND
//                          (not a declared dependency at all)
//        "other-throw" -- throws something that carries no such code, to
//                          confirm isPackageManifestResolvable's bare
//                          `catch { return false }` treats that the same
//                          as "absent" instead of letting it escape
//
// A third patch, on Module._resolveFilename, makes the one real
// `require.resolve("tree-sitter-rust/package.json")` call inside
// src/tree-sitter-language-service.ts's resolveWasmPath throw
// MODULE_NOT_FOUND -- the trigger that reaches src/code-mask.ts's catch
// block and isModuleAbsenceError at all, in every mode. This is what a
// present-but-broken grammar package looks like: the pnpapi stub reports
// it as a declared dependency (in "present" mode), but the actual load
// still fails, the way a corrupted Plug'n'Play store or an unplugged
// directory missing its manifest would fail in reality. Everything else
// resolves normally, including web-tree-sitter's own real WASM boot
// (Parser.init(), called before resolveWasmPath), so the only thing this
// probe fakes is exactly the seam src/code-mask.ts added the PnP branch
// for.
import Module from "node:module";

const mode = process.argv[2];
if (mode !== "present" && mode !== "absent" && mode !== "other-throw") {
  throw new Error(`unknown mode ${JSON.stringify(mode)}: expected present, absent, or other-throw`);
}

// `process.versions.pnp` is what src/code-mask.ts's getPnpApi() checks
// before ever trying `require("pnpapi")`; a real Yarn PnP process has this
// set by its generated .pnp.cjs loader before any of this project's own
// code runs.
(process.versions as { pnp?: string }).pnp = "3";

interface PatchableModule {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, ...rest: unknown[]): string;
  _resolveLookupPaths(request: string, parent: unknown): string[] | null;
}
const patchable = Module as unknown as PatchableModule;

const originalLoad = patchable._load;
patchable._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "pnpapi") {
    return {
      resolveToUnqualified(specifier: string): string | null {
        if (mode === "present") return `/fake/pnp/store/${specifier}`;
        if (mode === "absent") {
          const err = new Error(`Cannot find module '${specifier}'`) as NodeJS.ErrnoException;
          err.code = "MODULE_NOT_FOUND";
          throw err;
        }
        // mode === "other-throw": deliberately not a not-found error, and
        // not even an Error with a .code -- the widest thing
        // isPackageManifestResolvable's bare catch has to handle.
        throw new TypeError(`pnpapi stub: simulated unrelated resolution failure for ${specifier}`);
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const originalResolveFilename = patchable._resolveFilename;
patchable._resolveFilename = function (this: unknown, request: string, ...rest: unknown[]) {
  if (request === "tree-sitter-rust/package.json") {
    const err = new Error(`Cannot find module '${request}'`) as NodeJS.ErrnoException;
    err.code = "MODULE_NOT_FOUND";
    throw err;
  }
  return originalResolveFilename.call(this, request, ...rest);
};

const originalResolveLookupPaths = patchable._resolveLookupPaths;
patchable._resolveLookupPaths = function (this: unknown, request: string, parent: unknown) {
  if (request === "tree-sitter-rust" || request === "web-tree-sitter") return null;
  return originalResolveLookupPaths.call(this, request, parent);
};

const { warmLanguageServices, hadGrammarAbsent, hadGenuineGrammarLoadFailure } = await import(
  "../../src/code-mask.ts"
);

await warmLanguageServices(["probe.rs"]);

// Machine-readable, one line, read back by tests/pnp-grammar-presence.test.ts.
console.log(JSON.stringify({
  hadGrammarAbsent: hadGrammarAbsent(".rs"),
  hadGenuineGrammarLoadFailure: hadGenuineGrammarLoadFailure(".rs"),
}));
