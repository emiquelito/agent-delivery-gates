// Tests for the pure core in src/mutate.ts: which files may be mutated,
// which tokens count, what a mutation does to a line, and that two runs
// over the same input plan the same mutations in the same order. Nothing
// here writes to a file or runs a command; the CLI's own contract is
// covered in tests/mutate-cli.test.ts against a real git repository.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyMutation,
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

test("an expression inside a template literal's ${...} is never mutated", () => {
  assert.deepEqual(mutationsFor("const s = `total ${a > b} end`;"), []);
  assert.deepEqual(mutationsFor("const s = `${a && b}`;"), []);
  assert.deepEqual(mutationsFor("const s = `${count + 1} left`;"), []);
});

test("a template literal nested inside an interpolation does not end the outer one", () => {
  // The scanner used to close the outer literal on the inner literal's
  // opening backtick, read the rest of the line as code, and plan a
  // mutation inside a string. The documentation claimed that could never
  // happen; this is the case that made the claim false.
  assert.deepEqual(mutationsFor("const s = `outer ${`inner ${a > b}`} end`;"), []);
  assert.deepEqual(mutationsFor("const s = `${`${a === b}`} ${c + d}`;"), []);
});

test("a brace inside a string inside an interpolation does not end the interpolation", () => {
  assert.deepEqual(mutationsFor('const s = `${f("}") + 1}`;'), []);
});

test("code after a template literal on the same line is still mutated", () => {
  assert.deepEqual(afterTexts("const s = `x ${a > b}` + label;"), ["const s = `x ${a > b}` - label;"]);
  assert.deepEqual(afterTexts("const s = `${`in ${a}`}` + label;"), ["const s = `${`in ${a}`}` - label;"]);
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

test("exit code is 3 when nothing survived but something never got a verdict", () => {
  // Exit 0 has to mean every attempted mutation was judged. A run that
  // could not judge part of its own work reading the same as a run that
  // judged all of it is the exact failure this project exists to catch.
  assert.equal(exitCodeFor([resultWith("timeout")]), 3);
  assert.equal(exitCodeFor([resultWith("skipped")]), 3);
  assert.equal(exitCodeFor([resultWith("killed"), resultWith("timeout")]), 3);
  assert.equal(exitCodeFor([resultWith("killed"), resultWith("skipped")]), 3);
});

test("a survivor wins over a mutation that never got a verdict", () => {
  assert.equal(exitCodeFor([resultWith("survived"), resultWith("timeout")]), 1);
  assert.equal(exitCodeFor([resultWith("timeout"), resultWith("survived")]), 1);
  assert.equal(exitCodeFor([resultWith("survived"), resultWith("skipped"), resultWith("killed")]), 1);
});

test("a timeout is its own verdict, not a kill and not a survivor", () => {
  const results = [resultWith("timeout")];
  assert.deepEqual(summarize(results), { killed: 0, survived: 0, timeout: 1, skipped: 0 });
  assert.equal(exitCodeFor(results), 3);
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

test("the text report announces a run the --max cap cut short", () => {
  const text = formatReportText({
    command: "npm test",
    baselineMs: 1000,
    timeoutMs: 13000,
    filesConsidered: ["src/a.ts", "src/z.ts"],
    planned: 12,
    attempted: 3,
    results: [resultWith("killed")],
  });
  assert.match(text, /Mutations: 12 planned, 3 attempted/);
  assert.match(text, /Not every planned mutation was attempted: --max stopped the run at 3 of 12\./);
  assert.match(text, /a file after it is never touched at all/);
  assert.match(text, /leaves 9 of the 12 planned mutations unmeasured/);
  assert.match(text, /the run stopped at the cap, so part of the selection is unmeasured/);
});

test("the text report says nothing about a cap when every planned mutation ran", () => {
  const text = formatReportText({
    command: "npm test",
    baselineMs: 1000,
    timeoutMs: 13000,
    filesConsidered: ["src/a.ts"],
    planned: 1,
    attempted: 1,
    results: [resultWith("killed")],
  });
  assert.doesNotMatch(text, /--max stopped the run/);
});

test("the text report names a mutation that never got a verdict", () => {
  const text = formatReportText({
    command: "npm test",
    baselineMs: 1000,
    timeoutMs: 13000,
    filesConsidered: ["src/a.ts"],
    planned: 1,
    attempted: 1,
    results: [resultWith("timeout")],
  });
  assert.match(text, /No verdict on these \(1\):/);
  assert.match(text, /timeout\s+src\/a\.ts:1:7/);
  assert.match(text, /never got a verdict: those lines are still unmeasured \(exit 3\)/);
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
