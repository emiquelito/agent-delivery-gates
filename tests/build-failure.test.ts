import { test } from "node:test";
import assert from "node:assert/strict";
import { isBuildFailure } from "../src/build-failure.ts";

test("Go: the build-failed marker, with the real compiler line above it", () => {
  const out =
    '# github.com/google/uuid\nuuid.go:197:9: invalid operation: operator - not defined on "uuid: Parse(" (constant of type string)\nFAIL\tgithub.com/google/uuid [build failed]\n';
  assert.equal(isBuildFailure(out), true);
});

test("Go: a real test failure is not a build failure", () => {
  assert.equal(isBuildFailure("--- FAIL: TestX (0.00s)\n    x_test.go:9: got 1\nFAIL\nFAIL\tpkg\t0.004s\n"), false);
});

test("Go: a build failure in one package next to a real test failure in another stays a kill", () => {
  assert.equal(isBuildFailure("--- FAIL: TestX (0.00s)\nFAIL\tpkg/a\t0.004s\nFAIL\tpkg/b [build failed]\n"), false);
});

test("Rust: could not compile, from real cargo output", () => {
  assert.equal(
    isBuildFailure("error[E0369]: cannot subtract\nerror: could not compile `fx` (lib test) due to 1 previous error\n"),
    true,
  );
});

test("Rust: a failing test is not a build failure", () => {
  assert.equal(isBuildFailure("test result: FAILED. 1 passed; 1 failed; 0 ignored\n\nerror: test failed, to rerun pass `--lib`\n"), false);
});

test("Rust: could not compile next to a failed test result stays a kill", () => {
  assert.equal(isBuildFailure("test result: FAILED. 1 passed; 1 failed;\nerror: could not compile `fx` (bin)\n"), false);
});

test("tsc: a diagnostic with a position, and a bare one", () => {
  assert.equal(isBuildFailure("src/a.ts(1,5): error TS2322: Type 'string' is not assignable to type 'number'.\n"), true);
  assert.equal(isBuildFailure("error TS5023: Unknown compiler option 'x'.\n"), true);
});

test("unrecognised output stays a kill", () => {
  assert.equal(isBuildFailure(""), false);
  assert.equal(isBuildFailure("main.c:3:5: error: expected ';' before 'return'\nmake: *** [all] Error 1\n"), false);
  assert.equal(isBuildFailure("AssertionError: expected 1 to equal 2\n"), false);
});
