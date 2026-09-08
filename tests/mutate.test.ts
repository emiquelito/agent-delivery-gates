// Tests for the pure core in src/mutate.ts: which files may be mutated,
// which tokens count, what a mutation does to a line, and that two runs
// over the same input plan the same mutations in the same order. Nothing
// here writes to a file or runs a command; the CLI's own contract is
// covered in tests/mutate-cli.test.ts against a real git repository.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyMutation,
  codeMask,
  exitCodeFor,
  formatReportText,
  hasMutableExtension,
  isMutablePath,
  planFileMutations,
  planMutations,
  selectMutablePaths,
  summarize,
  type Mutation,
  type MutationResult,
} from "../src/mutate.ts";

function mutationsFor(line: string): Mutation[] {
  return planFileMutations("src/example.ts", line);
}

function afterTexts(line: string): string[] {
  return mutationsFor(line).map((m) => m.after);
}

// --- one operator at a time --------------------------------------------------

test("comparison boundary: < becomes <= and <= becomes <", () => {
  assert.deepEqual(afterTexts("if (a < b) f();"), ["if (a <= b) f();"]);
  assert.deepEqual(afterTexts("if (a <= b) f();"), ["if (a < b) f();"]);
});

test("comparison boundary: > becomes >= and >= becomes >", () => {
  assert.deepEqual(afterTexts("if (a > b) f();"), ["if (a >= b) f();"]);
  assert.deepEqual(afterTexts("if (a >= b) f();"), ["if (a > b) f();"]);
});

test("equality: === and !== swap, == and != swap", () => {
  assert.deepEqual(afterTexts("if (a === b) f();"), ["if (a !== b) f();"]);
  assert.deepEqual(afterTexts("if (a !== b) f();"), ["if (a === b) f();"]);
  assert.deepEqual(afterTexts("if (a == b) f();"), ["if (a != b) f();"]);
  assert.deepEqual(afterTexts("if (a != b) f();"), ["if (a == b) f();"]);
});

test("boolean connective: && becomes || and || becomes &&", () => {
  assert.deepEqual(afterTexts("const c = a && b;"), ["const c = a || b;"]);
  assert.deepEqual(afterTexts("const c = a || b;"), ["const c = a && b;"]);
});

test("boolean literal: true becomes false and false becomes true", () => {
  assert.deepEqual(afterTexts("return true;"), ["return false;"]);
  assert.deepEqual(afterTexts("return false;"), ["return true;"]);
});

test("arithmetic: + becomes - and - becomes +", () => {
  assert.deepEqual(afterTexts("const n = a + b;"), ["const n = a - b;"]);
  assert.deepEqual(afterTexts("const n = a - b;"), ["const n = a + b;"]);
});

test("each mutation records its operator, token, line and column", () => {
  const [mutation] = mutationsFor("  if (a >= b) f();");
  assert.equal(mutation.operator, "comparison-boundary");
  assert.equal(mutation.original, ">=");
  assert.equal(mutation.replacement, ">");
  assert.equal(mutation.line, 1);
  assert.equal(mutation.column, 9);
  assert.equal(mutation.file, "src/example.ts");
});

// --- what is left alone ------------------------------------------------------

test("a comment line is never mutated", () => {
  assert.deepEqual(mutationsFor("// if (a < b) return true;"), []);
  assert.deepEqual(mutationsFor("  # a < b"), []);
  assert.deepEqual(mutationsFor(" * a && b"), []);
});

test("a line inside a block comment is never mutated", () => {
  const text = ["/*", "if (a < b) return true;", "*/", "const n = a + b;"].join("\n");
  const lines = planFileMutations("src/example.ts", text).map((m) => m.line);
  assert.deepEqual(lines, [4]);
});

test("an import line is never mutated", () => {
  assert.deepEqual(mutationsFor("import { a, b } from './x.ts';"), []);
  assert.deepEqual(mutationsFor("const x = require('y');"), []);
});

test("a string literal is never mutated", () => {
  assert.deepEqual(mutationsFor("const s = 'a < b && true';"), []);
  assert.deepEqual(mutationsFor('const s = "a === b";'), []);
  assert.deepEqual(mutationsFor("const s = `a + b`;"), []);
});

test("code beside a string literal on the same line is still mutated", () => {
  assert.deepEqual(afterTexts("const s = 'a < b' + label;"), ["const s = 'a < b' - label;"]);
});

test("a regular expression literal is never mutated", () => {
  assert.deepEqual(mutationsFor("const re = /a + b/;"), []);
});

test("a trailing line comment is never mutated", () => {
  assert.deepEqual(afterTexts("const n = a + b; // a - b"), ["const n = a - b; // a - b"]);
});

test("an operator with no space on both sides is left alone", () => {
  // The whitespace rule is what keeps a generic, an arrow, a compound
  // assignment and a unary minus out of the candidate list.
  assert.deepEqual(mutationsFor("const xs: Array<string> = [];"), []);
  assert.deepEqual(mutationsFor("const f = (n: number) => n;"), []);
  assert.deepEqual(mutationsFor("count += 1;"), []);
  assert.deepEqual(mutationsFor("count++;"), []);
  assert.deepEqual(mutationsFor("f(-1);"), []);
  assert.deepEqual(mutationsFor("const n = a<<b;"), []);
});

test("a word containing true or false is not a boolean literal", () => {
  assert.deepEqual(mutationsFor("const isTrueish = value;"), []);
  assert.deepEqual(mutationsFor("const falsey = value;"), []);
});

test("codeMask marks string and comment characters as not code", () => {
  const text = "a + 'b + c' // d + e";
  const mask = codeMask(text);
  assert.equal(mask[2], true, "the first plus is code");
  assert.equal(mask[7], false, "the plus inside the string is not code");
  assert.equal(mask[16], false, "the plus inside the comment is not code");
});

// --- which files -------------------------------------------------------------

test("a test file is never a mutation candidate", () => {
  assert.equal(isMutablePath("src/order.ts"), true);
  assert.equal(isMutablePath("tests/order.test.ts"), false);
  assert.equal(isMutablePath("src/__tests__/order.ts"), false);
  assert.equal(isMutablePath("app/order_test.go"), false);
  assert.equal(isMutablePath("src/OrderTest.java"), false);
});

test("a file with an unsupported extension is never a candidate", () => {
  assert.equal(hasMutableExtension("README.md"), false);
  assert.equal(hasMutableExtension("data.json"), false);
  assert.equal(hasMutableExtension("run.py"), false);
  assert.equal(hasMutableExtension("src/order.ts"), true);
  assert.equal(hasMutableExtension("src/order.go"), true);
});

test("selectMutablePaths drops test files and sorts what is left", () => {
  const selected = selectMutablePaths(["src/b.ts", "tests/a.test.ts", "src/a.ts", "docs/x.md"]);
  assert.deepEqual(selected, ["src/a.ts", "src/b.ts"]);
});

test("planMutations never plans a mutation in a test file", () => {
  const files = [
    { path: "tests/order.test.ts", text: "if (a < b) f();" },
    { path: "src/order.ts", text: "if (a < b) f();" },
  ];
  const planned = planMutations(files);
  assert.equal(planned.length, 1);
  assert.equal(planned[0].file, "src/order.ts");
});

// --- ordering ----------------------------------------------------------------

test("ordering is the same for two runs over the same input", () => {
  const files = [
    { path: "src/b.ts", text: "if (a < b) f();\nconst n = a + b;" },
    { path: "src/a.ts", text: "const c = a && b;\nreturn true;" },
  ];
  const first = planMutations(files);
  const second = planMutations(files);
  assert.deepEqual(first, second);
});

test("ordering does not depend on the order the files arrived in", () => {
  const a = { path: "src/a.ts", text: "const c = a && b;" };
  const b = { path: "src/b.ts", text: "if (a < b) f();" };
  const forward = planMutations([a, b]).map((m) => `${m.file}:${m.line}:${m.column}`);
  const backward = planMutations([b, a]).map((m) => `${m.file}:${m.line}:${m.column}`);
  assert.deepEqual(forward, backward);
  assert.deepEqual(forward, ["src/a.ts:1:13", "src/b.ts:1:7"]);
});

test("within a file, mutations come in line then column order", () => {
  const text = ["const c = a && b;", "if (x < y || z > 0) f();"].join("\n");
  const positions = planFileMutations("src/a.ts", text).map((m) => [m.line, m.column]);
  assert.deepEqual(positions, [
    [1, 13],
    [2, 7],
    [2, 11],
    [2, 16],
  ]);
});

test("--max keeps the first N of the same ordered list", () => {
  const files = [{ path: "src/a.ts", text: "if (x < y || z > 0) f();" }];
  const all = planMutations(files);
  const capped = planMutations(files, { max: 2 });
  assert.equal(all.length, 3);
  assert.deepEqual(capped, all.slice(0, 2));
});

// --- applying ----------------------------------------------------------------

test("applyMutation changes only the planned line", () => {
  const text = ["const a = 1;", "if (a < b) f();", "const c = 3;"].join("\n");
  const [mutation] = planFileMutations("src/a.ts", text);
  assert.equal(applyMutation(text, mutation), ["const a = 1;", "if (a <= b) f();", "const c = 3;"].join("\n"));
});

test("applyMutation keeps a trailing newline intact", () => {
  const text = "if (a < b) f();\n";
  const [mutation] = planFileMutations("src/a.ts", text);
  assert.equal(applyMutation(text, mutation), "if (a <= b) f();\n");
});

test("applyMutation throws when the line no longer matches the plan", () => {
  const text = "if (a < b) f();\n";
  const [mutation] = planFileMutations("src/a.ts", text);
  assert.throws(() => applyMutation("something else entirely\n", mutation), /no longer matches/);
});

// --- verdicts and reporting --------------------------------------------------

function resultWith(verdict: MutationResult["verdict"]): MutationResult {
  const [mutation] = planFileMutations("src/a.ts", "if (a < b) f();");
  return { mutation, verdict, durationMs: 1, exitCode: verdict === "survived" ? 0 : 1 };
}

test("exit code is 1 when anything survived and 0 otherwise", () => {
  assert.equal(exitCodeFor([resultWith("killed"), resultWith("killed")]), 0);
  assert.equal(exitCodeFor([resultWith("killed"), resultWith("survived")]), 1);
  assert.equal(exitCodeFor([]), 0);
});

test("a timeout is its own verdict, not a kill and not a survivor", () => {
  const results = [resultWith("timeout")];
  assert.deepEqual(summarize(results), { killed: 0, survived: 0, timeout: 1, skipped: 0 });
  assert.equal(exitCodeFor(results), 0);
});

test("the text report names each survivor with its file, line and both texts", () => {
  const results = [resultWith("survived")];
  const text = formatReportText({
    command: "npm test",
    baselineMs: 2000,
    timeoutMs: 16000,
    filesConsidered: ["src/a.ts"],
    planned: 1,
    attempted: 1,
    results,
  });
  assert.match(text, /Survivors \(1\)/);
  assert.match(text, /src\/a\.ts:1:7\s+comparison-boundary\s+< to <=/);
  assert.match(text, /before: if \(a < b\) f\(\);/);
  assert.match(text, /after:\s+if \(a <= b\) f\(\);/);
});

test("the text report says plainly when nothing survived", () => {
  const text = formatReportText({
    command: "npm test",
    baselineMs: 1000,
    timeoutMs: 13000,
    filesConsidered: ["src/a.ts"],
    planned: 1,
    attempted: 1,
    results: [resultWith("killed")],
  });
  assert.match(text, /killed 1, survived 0, timeout 0, skipped 0/);
  assert.match(text, /No mutation survived/);
});
