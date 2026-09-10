// Regression test for src/code-mask.ts's Yarn Plug'n'Play branch
// (isPackageManifestResolvable's getPnpApi() path, added alongside
// isModuleAbsenceError's ERR_PACKAGE_PATH_NOT_EXPORTED guard): the commit
// that added it shipped with no automated test, verified only by a real
// Plug'n'Play install and manual reproduction. This exercises the real
// shipped code -- no ADG_TEST_FORCE_GRAMMAR_FAILURE/ABSENT shortcut, which
// bypasses isModuleAbsenceError entirely and so cannot see this bug class
// at all -- through tests/support/pnp-grammar-presence-probe.ts, which
// fakes only the two seams a real Yarn PnP process provides
// (process.versions.pnp and the pnpapi virtual module) plus the one real
// module-resolution failure needed to reach the code under test, without
// touching this repository's real node_modules. See that file's own
// comment for the full mechanism.
//
// Each case below is its own subprocess: src/code-mask.ts's per-extension
// caches (resolvedServices, grammarAbsentExtensions, grammarGenuineFailures)
// are permanent for the life of a process, so ".rs" can only be resolved
// once per node invocation -- the same reason
// tests/agent-adapter-grammar-load-failure.test.ts spawns a subprocess per
// case instead of asking one process to answer more than once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE_PATH = join(HERE, "support", "pnp-grammar-presence-probe.ts");

interface ProbeResult {
  hadGrammarAbsent: boolean;
  hadGenuineGrammarLoadFailure: boolean;
}

function runProbe(mode: "present" | "absent" | "other-throw"): ProbeResult {
  const result = spawnSync("node", [PROBE_PATH, mode], { encoding: "utf8" });
  assert.equal(result.status, 0, `probe(${mode}) exited ${result.status}, stderr:\n${result.stderr}`);
  const lastLine = result.stdout.trim().split("\n").at(-1) ?? "";
  return JSON.parse(lastLine) as ProbeResult;
}

test("Finding 1: pnpapi reports the grammar package present -> a real load failure with the manifest unreadable is a real failure, not absence", () => {
  const probe = runProbe("present");
  assert.equal(probe.hadGrammarAbsent, false);
  assert.equal(probe.hadGenuineGrammarLoadFailure, true);
});

test("Finding 1: pnpapi reports the grammar package not a declared dependency -> absence", () => {
  const probe = runProbe("absent");
  assert.equal(probe.hadGrammarAbsent, true);
  assert.equal(probe.hadGenuineGrammarLoadFailure, false);
});

test("Finding 1: pnpapi throws something other than a not-found error -> isPackageManifestResolvable's bare catch still reads that as unresolvable, same as absence", () => {
  const probe = runProbe("other-throw");
  assert.equal(probe.hadGrammarAbsent, true);
  assert.equal(probe.hadGenuineGrammarLoadFailure, false);
});
