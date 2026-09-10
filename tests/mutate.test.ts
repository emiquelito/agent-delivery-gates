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
  grammarUnavailablePaths,
  hasMutableExtension,
  isMutablePath,
  planFileMutations,
  planMutations,
  planMutationsWarmed,
  selectMutablePaths,
  summarize,
  unsupportedLanguagePaths,
  warmAndSplitByGrammar,
  type Mutation,
  type MutationResult,
} from "../src/mutate.ts";
import { warmLanguageServices } from "../src/code-mask.ts";

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

// --- Python: boolean literal and connective, per-language operator selection

test("Python comparison and arithmetic operators already work through the shared table", () => {
  // These are the same characters in Python as in the C family; nothing
  // Python-specific needed to be added for them.
  const mutations = planFileMutations("order.py", "if total >= 100:\n    return total - 10\n");
  assert.deepEqual(
    mutations.map((m) => m.after),
    ["if total > 100:", "    return total + 10"],
  );
});

test("Python boolean literal: True becomes False and False becomes True", () => {
  const text = "ok = True\nother = False\n";
  const mutations = planFileMutations("flags.py", text);
  assert.deepEqual(
    mutations.map((m) => [m.operator, m.original, m.after]),
    [
      ["boolean-literal", "True", "ok = False"],
      ["boolean-literal", "False", "other = True"],
    ],
  );
});

test("Python boolean connective: and becomes or and or becomes and", () => {
  const text = "flag = a and b\nboth = a or b\n";
  const mutations = planFileMutations("flags.py", text);
  assert.deepEqual(
    mutations.map((m) => [m.operator, m.original, m.after]),
    [
      ["boolean-connective", "and", "flag = a or b"],
      ["boolean-connective", "or", "both = a and b"],
    ],
  );
});

test("a Python identifier containing True, False, and, or or is not itself mutated", () => {
  const text = "Truelove = 1\nFalsehood = 2\nandromeda = 3\nordinary = 4\nband = 5\n";
  assert.deepEqual(planFileMutations("x.py", text), []);
});

test("per-language operator selection: True, False, and, or are never offered in a Rust file", () => {
  // Same four words, same surrounding whitespace, but in a language where
  // they read as ordinary identifiers, not Python's keywords.
  const text = "let ok = True;\nlet other = False;\nlet flag = a and b;\nlet both = a or b;\n";
  assert.deepEqual(planFileMutations("main.rs", text), []);
});

test("per-language operator selection: lowercase true/false still work in a Rust file", () => {
  // The C-family table is untouched by adding Python: true/false stay
  // reachable everywhere they always were.
  assert.deepEqual(planFileMutations("main.rs", "let ok = true;\n").map((m) => m.after), ["let ok = false;"]);
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
  // .rb has no operator table of its own (see PYTHON_OPERATOR_RULES's
  // comment in src/mutate.ts for why Python earned one and other
  // languages have not yet), so it stays outside MUTABLE_EXTENSIONS the
  // way every extension without a table does.
  assert.equal(hasMutableExtension("script.rb"), false);
  assert.equal(hasMutableExtension("src/order.ts"), true);
  assert.equal(hasMutableExtension("src/order.go"), true);
  assert.equal(hasMutableExtension("run.py"), true);
});

test("selectMutablePaths drops test files and sorts what is left", () => {
  const selected = selectMutablePaths(["src/b.ts", "tests/a.test.ts", "src/a.ts", "docs/x.md"]);
  assert.deepEqual(selected, ["src/a.ts", "src/b.ts"]);
});

test("unsupportedLanguagePaths reports a non-test file in a known language with no operator table, and only that", () => {
  const paths = ["app/main.rb", "spec/main_spec.rb", "src/a.ts", "README.md", "package.json", "run.py"];
  // main.rb: a real candidate in a language this tool already masks
  // (see src/tree-sitter-grammars.ts) but has no operator table for ->
  // reported.
  // main_spec.rb: a test file, dropped for being a test, not for its
  // language -> not reported, same as selectMutablePaths would drop it.
  // a.ts: mutable -> not reported.
  // README.md, package.json: not a language this tool models at all, the
  // same as any other markup, config, or data format -> not reported,
  // exactly as before this change, so an ordinary run that merely touches
  // a config file never reports "unmeasured" for it.
  // run.py: now mutable -> not reported.
  assert.deepEqual(unsupportedLanguagePaths(paths), ["app/main.rb"]);
});

// unsupportedLanguagePaths used to allowlist a fixed set of "languages
// this project already recognises" (Python plus the six tree-sitter
// languages). A file in any other real language -- Elixir here -- fell
// outside that allowlist and vanished without a trace, exactly the
// silence this function exists to close, just moved one language further
// out; the reviewer's own reproduction used lib/discount.ex next to
// lib/main.rb and watched the .ex file disappear entirely, not even
// counted. It is a denylist of known non-source extensions now (see
// NON_SOURCE_EXTENSIONS in src/mutate.ts), so nothing selected has to be
// on a list of known languages to be reported; only a config, markup, or
// data extension buys silence.
test("unsupportedLanguagePaths reports a language this tool has never heard of, next to one it has: neither vanishes", () => {
  const paths = ["lib/discount.ex", "lib/main.rb"];
  assert.deepEqual(unsupportedLanguagePaths(paths), ["lib/discount.ex", "lib/main.rb"]);
});

test("unsupportedLanguagePaths still keeps common data, config, and markup extensions silent", () => {
  const paths = [
    "README.md",
    "package-lock.json",
    "yarn.lock",
    ".github/workflows/ci.yml",
    "styles/app.css",
    "assets/logo.svg",
    "notes.txt",
  ];
  assert.deepEqual(unsupportedLanguagePaths(paths), []);
});

test("unsupportedLanguagePaths does not flag an extensionless file", () => {
  // A Makefile, a Dockerfile, a bare LICENSE: overwhelmingly build
  // metadata or documentation, not program source, and with no extension
  // to say otherwise. Flagging every one of these would be exactly the
  // noise NON_SOURCE_EXTENSIONS exists to keep out.
  assert.deepEqual(unsupportedLanguagePaths(["Makefile", "Dockerfile", "LICENSE"]), []);
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

// An output-cap kill and a signal kill are unmeasured for the same reason
// a timeout is: the run was cut off before it could report a verdict, so
// crediting either one as a catch would credit the suite with a catch it
// never made (reviewer finding 2). Both get the same exit 3 a timeout gets.
test("an output-overflow kill and a killed-by-signal run are unmeasured, not credited as a catch", () => {
  assert.equal(exitCodeFor([resultWith("output-overflow")]), 3);
  assert.equal(exitCodeFor([resultWith("killed-by-signal")]), 3);
  assert.equal(exitCodeFor([resultWith("killed"), resultWith("output-overflow")]), 3);
  assert.equal(exitCodeFor([resultWith("killed"), resultWith("killed-by-signal")]), 3);
});

test("a survivor wins over a mutation that never got a verdict", () => {
  assert.equal(exitCodeFor([resultWith("survived"), resultWith("timeout")]), 1);
  assert.equal(exitCodeFor([resultWith("timeout"), resultWith("survived")]), 1);
  assert.equal(exitCodeFor([resultWith("survived"), resultWith("skipped"), resultWith("killed")]), 1);
  assert.equal(exitCodeFor([resultWith("survived"), resultWith("output-overflow")]), 1);
  assert.equal(exitCodeFor([resultWith("survived"), resultWith("killed-by-signal")]), 1);
});

test("exit code is 3 when nothing survived but a candidate's language had no operator set", () => {
  // No mutable file at all is not the same outcome as every mutation
  // being killed: both are unmeasured, but for different reasons, and
  // both have to keep this run out of exit 0.
  assert.equal(exitCodeFor([], ["app/main.rb"]), 3);
  assert.equal(exitCodeFor([resultWith("killed")], ["app/main.rb"]), 3);
});

test("a survivor still wins over an unsupported-language file", () => {
  assert.equal(exitCodeFor([resultWith("survived")], ["app/main.rb"]), 1);
});

// CRITICAL fix: a file whose tree-sitter grammar failed to load has an
// operator table (unlike an unsupported-language file) but no trustworthy
// mask to apply it through, so it is exactly as unmeasured as the other
// two exit-3 reasons and must keep a run out of exit 0 the same way.
test("exit code is 3 when nothing survived but a candidate's grammar failed to load", () => {
  assert.equal(exitCodeFor([], [], ["lib/discount.py"]), 3);
  assert.equal(exitCodeFor([resultWith("killed")], [], ["lib/discount.py"]), 3);
});

test("a survivor still wins over a grammar-unavailable file", () => {
  assert.equal(exitCodeFor([resultWith("survived")], [], ["lib/discount.py"]), 1);
});

test("no mutable file found and every mutation killed both read differently in the report", () => {
  const noneFound = formatReportText({
    command: "npm test",
    baselineMs: 1000,
    timeoutMs: 13000,
    filesConsidered: [],
    planned: 0,
    attempted: 0,
    results: [],
    unsupportedFiles: ["app/main.rb", "lib/other.rb"],
  });
  assert.match(noneFound, /No operator set for these \(2\):/);
  assert.match(noneFound, /app\/main\.rb/);
  assert.match(noneFound, /lib\/other\.rb/);
  assert.match(noneFound, /2 selected file\(s\) had no operator set for their language.*unmeasured, not passed over \(exit 3\)/);

  const allKilled = formatReportText({
    command: "npm test",
    baselineMs: 1000,
    timeoutMs: 13000,
    filesConsidered: ["src/a.ts"],
    planned: 1,
    attempted: 1,
    results: [resultWith("killed")],
  });
  assert.doesNotMatch(allKilled, /No operator set for these/);
  assert.match(allKilled, /No mutation survived: every break this tool made was caught\./);
});

test("a grammar-unavailable file gets its own section and its own exit-3 explanation", () => {
  const report = formatReportText({
    command: "npm test",
    baselineMs: 1000,
    timeoutMs: 13000,
    filesConsidered: [],
    planned: 0,
    attempted: 0,
    results: [],
    grammarUnavailableFiles: ["lib/discount.py"],
  });
  assert.match(report, /Grammar failed to load for these \(1\):/);
  assert.match(report, /lib\/discount\.py/);
  assert.match(report, /1 file\(s\) could not be trusted because their grammar failed to load.*\(exit 3\)/);
  assert.doesNotMatch(report, /No operator set for these/);
});

test("all three exit-3 reasons at once are joined into one sentence, and the existing two-reason wording is untouched", () => {
  const allThree = formatReportText({
    command: "npm test",
    baselineMs: 1000,
    timeoutMs: 13000,
    filesConsidered: ["src/a.py"],
    planned: 1,
    attempted: 1,
    results: [resultWith("timeout")],
    unsupportedFiles: ["app/main.rb"],
    grammarUnavailableFiles: ["lib/discount.py"],
  });
  assert.match(allThree, /No verdict on these \(1\):/);
  assert.match(allThree, /No operator set for these \(1\):/);
  assert.match(allThree, /Grammar failed to load for these \(1\):/);
  assert.match(
    allThree,
    /No mutation survived, but 1 never got a verdict, 1 file\(s\) had no operator set for their language, and 1 file\(s\) could not be trusted because their grammar failed to load: all of that is unmeasured \(exit 3\)\./,
  );

  // The existing two-reason (unmeasured + unsupported, no grammar failure)
  // wording is pinned exactly as it was before this change, unchanged.
  const twoReasons = formatReportText({
    command: "npm test",
    baselineMs: 1000,
    timeoutMs: 13000,
    filesConsidered: ["src/a.ts"],
    planned: 1,
    attempted: 1,
    results: [resultWith("timeout")],
    unsupportedFiles: ["app/main.rb"],
  });
  assert.match(
    twoReasons,
    /No mutation survived, but 1 never got a verdict and 1 file\(s\) had no operator set for their language: both are unmeasured \(exit 3\)\./,
  );
});

test("a timeout is its own verdict, not a kill and not a survivor", () => {
  const results = [resultWith("timeout")];
  assert.deepEqual(summarize(results), {
    killed: 0,
    survived: 0,
    timeout: 1,
    skipped: 0,
    outputOverflow: 0,
    killedBySignal: 0,
  });
  assert.equal(exitCodeFor(results), 3);
});

test("an output-overflow kill and a killed-by-signal run are each counted apart from killed", () => {
  const results = [resultWith("killed"), resultWith("output-overflow"), resultWith("killed-by-signal")];
  assert.deepEqual(summarize(results), {
    killed: 1,
    survived: 0,
    timeout: 0,
    skipped: 0,
    outputOverflow: 1,
    killedBySignal: 1,
  });
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

test("the text report separates an output-overflow kill and a killed-by-signal run from a plain kill", () => {
  const text = formatReportText({
    command: "npm test",
    baselineMs: 1000,
    timeoutMs: 13000,
    filesConsidered: ["src/a.ts"],
    planned: 2,
    attempted: 2,
    results: [resultWith("output-overflow"), resultWith("killed-by-signal")],
  });
  assert.match(text, /killed 0, survived 0, timeout 0, skipped 0, output-overflow 1, killed-by-signal 1/);
  assert.match(text, /No verdict on these \(2\):/);
  assert.match(text, /output-overflow\s+src\/a\.ts:1:7/);
  assert.match(text, /killed-by-signal\s+src\/a\.ts:1:7/);
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

// --- the mutate path and the Python language service --------------------

// planFileMutations is the exact function hooks/mutate.ts reaches through
// planMutations: `languageServiceFor(path).codeMask(text)` directly, with
// no way of its own to know whether warmLanguageServices ran first. .py is
// in MUTABLE_EXTENSIONS now, so an ordinary `adg mutate` run does select a
// .py file, through hooks/mutate.ts's own planMutationsWarmed call; this
// test drives planFileMutations directly instead, unwarmed, the same way
// the reviewer's own reproduction of the original bug did, to prove what
// mask a .py file gets when the batch that reaches it was, and was not,
// warmed first.
//
// The docstring's interior falls out of the regex scanner's own
// documented per-line limit: a plain quote unclosed on the line it opened
// is read as unterminated and abandoned, so the second and third quotes of
// `"""` are read as one empty string followed by one unterminated string
// that dies at the end of that same line, and everything after it,
// including the next line, is ordinary code again to a scanner that never
// heard of a triple-quoted string. That is what puts a mutation inside the
// docstring below when nothing warmed the Python service first: the
// tree-sitter grammar, once loaded, knows the docstring for what it is and
// the mask this file's own differential test already covers agrees.
const PY_DOCSTRING_TEXT = ["def f():", '    """', "    a == b", '    """', "    return 1 == 2", ""].join("\n");

test("planFileMutations mutates inside a Python docstring when nothing warmed the Python service first", () => {
  const mutations = planFileMutations("foo.py", PY_DOCSTRING_TEXT);
  const lines = mutations.map((m) => m.line);
  // Line 3 is "    a == b", inside the docstring; line 5 is the real
  // "return 1 == 2". Only line 5 is an actual mutation candidate; line 3
  // is the regex scanner's mistake.
  assert.deepEqual(lines, [3, 5]);
});

test("planFileMutations mutates only the real code once warmLanguageServices resolved the Python service", async () => {
  await warmLanguageServices(["foo.py"]);
  const mutations = planFileMutations("foo.py", PY_DOCSTRING_TEXT);
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].line, 5);
  assert.equal(mutations[0].after, "    return 1 != 2");
});

test("planMutationsWarmed plans the same mutations planMutations does for files with no Python in the batch", async () => {
  const files = [{ path: "src/order.ts", text: "if (a < b) f();" }];
  const sync = planMutations(files);
  const warmed = await planMutationsWarmed(files);
  assert.deepEqual(warmed, sync);
});

// --- Python: proof the mask is consulted, not just the operator table ------
//
// Placed after the warmed-vs-unwarmed tests above, and not earlier: the
// Python tree-sitter service is resolved once per process and cached (see
// resolvedServices in src/code-mask.ts), so a test here that warms it
// would otherwise leak into the two "unwarmed" tests above and silently
// change what they are proving.

test("planMutationsWarmed never mutates inside a Python docstring, an f-string literal, or after a # comment", async () => {
  const text = [
    "def f(x, y):",
    '    """',
    "    x == y and x != y",
    '    """',
    '    name = f"{x} and {y}"',
    "    ok = x == y  # x and y, True or False",
    "    return x == y",
    "",
  ].join("\n");
  const mutations = await planMutationsWarmed([{ path: "foo.py", text }]);
  // Line 3 sits inside the docstring, line 5's "and" sits inside the
  // f-string's own literal text (its {x}/{y} interpolations hold no
  // operator), and line 6's trailing comment holds "and"/"or"/"True"/
  // "False" that must stay untouched. Only line 6's real "==" and line 7's
  // real "==" are candidates.
  assert.deepEqual(
    mutations.map((m) => [m.line, m.original]),
    [
      [6, "=="],
      [7, "=="],
    ],
  );
});

// --- grammarUnavailablePaths / warmAndSplitByGrammar ------------------------
//
// The CRITICAL fix: a file whose tree-sitter grammar failed to load must
// never be handed to planMutations, because there is no correct mask for
// it, only the C-family regex scanner applied to a language it was never
// written for. Reproducing an actual load failure needs tree-sitter-python
// and web-tree-sitter absent from node_modules in a fresh process --
// resolvedServices in src/code-mask.ts caches a resolved service for the
// life of a process, so nothing in this same test process can make .py's
// grammar fail here once anything else in this file has warmed it
// successfully. That real reproduction, matching what an adopter's install
// leaves, is tests/mutate-cli.test.ts's own subprocess tests, which rename
// the real packages out of this repository's real node_modules and
// restore them afterward. What is tested here, in-process, is the ordinary path: a
// grammar that did load leaves both functions reporting no failure at all.

test("grammarUnavailablePaths reports nothing when every extension's grammar loaded (or needed none)", async () => {
  await warmLanguageServices(["src/order.ts", "lib/discount.py"]);
  assert.deepEqual(grammarUnavailablePaths(["src/order.ts", "lib/discount.py"]), []);
});

test("warmAndSplitByGrammar puts every mutable path in `trustworthy` when nothing failed to load", async () => {
  const result = await warmAndSplitByGrammar(["src/order.ts", "lib/discount.py"]);
  assert.deepEqual(result, { trustworthy: ["src/order.ts", "lib/discount.py"], grammarUnavailable: [] });
});
