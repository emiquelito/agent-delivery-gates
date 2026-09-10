// Pure core for `adg mutate`. Takes source text and returns the list of
// mutations that could be applied to it, in a fixed order, plus the code
// that applies one and the code that reports on a finished run. No I/O, no
// git, no subprocess, no process exit: the CLI in hooks/mutate.ts does all
// of that, so the decision about what counts as a mutation lives in exactly
// one place and can be tested without writing to anyone's files.
//
// The point of this check: a test suite that stays green while the code
// under it is broken is not holding that line. Breaking the code on purpose
// and watching the suite is the only way to tell a test that proves
// something from a test that merely runs.
//
// The scanner that says which characters are code and which sit inside a
// string, a comment, or a regular expression used to live here. It is in
// src/code-mask.ts now, because src/test-diff-separator.ts needs it too and
// this file already imports from that one.

import { languageServiceFor, warmLanguageServices, IDENT_CHAR } from "./code-mask.ts";
import { classifyTestPath, isCommentLine, isImportLine, type RuleSet } from "./test-diff-separator.ts";
import { GRAMMAR_SPECS } from "./tree-sitter-grammars.ts";

/** The fixed operator set. One mutation per run, one operator per mutation. */
export type MutationOperator =
  | "comparison-boundary"
  | "equality"
  | "boolean-connective"
  | "boolean-literal"
  | "arithmetic";

export type Verdict = "killed" | "survived" | "timeout" | "skipped" | "output-overflow" | "killed-by-signal";

export interface Mutation {
  /** Path as the caller gave it, usually relative to the repository root. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column of the first character of the token replaced. */
  column: number;
  operator: MutationOperator;
  /** The token as written in the original. */
  original: string;
  /** The token it becomes. */
  replacement: string;
  /** The whole original line, without its newline. */
  before: string;
  /** The whole mutated line, without its newline. */
  after: string;
}

export interface MutationResult {
  mutation: Mutation;
  verdict: Verdict;
  /** How long the command took for this mutation, in milliseconds. */
  durationMs: number;
  /** The command's exit code, or null when it was killed or never ran. */
  exitCode: number | null;
}

// --- which files can be mutated ----------------------------------------------

// The extensions this tool will touch. Every operator except the four
// Python-only ones below (see PYTHON_OPERATOR_RULES) is written for
// C-family and JavaScript-family syntax, and so is the whitespace-bounded
// matching rule in matchRuleAt: a file outside this list is left alone
// instead of being mutated by rules that were never written for it.
//
// Python earns its own entry now that its triple-quoted strings,
// f-strings, and comments have a correct scanner of their own
// (src/tree-sitter-python-service.ts, reached through
// languageServiceFor in src/code-mask.ts, proven behaviour-identical
// across 141,245 real files): its comparison and arithmetic operators are
// the same characters as the C family and already matched by
// OPERATOR_RULES below, so the only new work was its own boolean literals
// and connectives, written as words: True/False/and/or. Every other
// markup, config, and data format stays excluded.
export const MUTABLE_EXTENSIONS: readonly string[] = [
  ".c",
  ".cc",
  ".cjs",
  ".cpp",
  ".cs",
  ".cts",
  ".dart",
  ".go",
  ".h",
  ".hpp",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".mjs",
  ".mts",
  ".php",
  ".py",
  ".rs",
  ".scala",
  ".swift",
  ".ts",
  ".tsx",
];

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

/** True when the extension is one the operators were written for. */
export function hasMutableExtension(path: string): boolean {
  return MUTABLE_EXTENSIONS.includes(extensionOf(path));
}

/**
 * Whether one path is a candidate for mutation: a supported extension and
 * not a test file. The test-file question is answered by classifyTestPath in
 * src/test-diff-separator.ts and nowhere else, so this tool and the
 * test-diff gate can never disagree about what a test file is. Mutating a
 * test file would measure nothing: the suite would be marking its own work.
 */
export function isMutablePath(path: string, rules?: RuleSet): boolean {
  if (!hasMutableExtension(path)) return false;
  return !classifyTestPath(path, rules).isTest;
}

/**
 * The mutable paths out of a list, sorted by path. Sorting here is what
 * makes two runs over the same commit produce the same mutations in the
 * same order: nothing downstream may depend on the order a directory
 * listing or a git call happened to hand back.
 */
export function selectMutablePaths(paths: string[], rules?: RuleSet): string[] {
  return paths.filter((path) => isMutablePath(path, rules)).sort();
}

/**
 * Extensions this project already knows how to read as a programming
 * language: Python's own tree-sitter-python-service.ts, plus every
 * language src/tree-sitter-grammars.ts lists a GrammarSpec for (Rust,
 * Ruby, PHP, Go, Java, C#). A working code mask exists for each of these,
 * whether or not MUTABLE_EXTENSIONS above has an operator table for it
 * yet: right now that is every one of them except Ruby, which this
 * project can already tell code from a comment or a string in, but has
 * not yet written mutation rules for. A config file, a markup file, or a
 * data format is deliberately not in this set: it was never going to grow
 * an operator table, so treating one as "unmeasured" on an ordinary run
 * would drown the signal unsupportedLanguagePaths exists to give in
 * noise (a commit that merely touches package.json would report exit 3
 * for no real reason). This set is specifically "a language this tool
 * could write mutation rules for tomorrow, the same way it just did for
 * Python."
 */
const KNOWN_LANGUAGE_EXTENSIONS: ReadonlySet<string> = new Set([".py", ...Object.keys(GRAMMAR_SPECS)]);

/**
 * The candidate paths `selectMutablePaths` above drops for want of an
 * operator set: a real, non-test source file in a language this project
 * already recognises (see KNOWN_LANGUAGE_EXTENSIONS) but MUTABLE_EXTENSIONS
 * has no rules for. A test file is not included here, because it was
 * never going to be mutated anyway, and neither is a config, markup, or
 * data file, for the reason KNOWN_LANGUAGE_EXTENSIONS' own comment gives.
 *
 * A caller that silently drops these reports a run over, say, an
 * all-Ruby diff exactly the way it reports a run that mutated everything
 * and found no survivors: nothing printed, exit 0. See ReportInput's
 * `unsupportedFiles` and exitCodeFor below for how this list turns that
 * silence into an unmeasured file, reported by name, with its own exit
 * code.
 */
export function unsupportedLanguagePaths(paths: string[], rules?: RuleSet): string[] {
  return paths
    .filter(
      (path) =>
        KNOWN_LANGUAGE_EXTENSIONS.has(extensionOf(path)) &&
        !hasMutableExtension(path) &&
        !classifyTestPath(path, rules).isTest,
    )
    .sort();
}

// --- the operator table -------------------------------------------------------

interface OperatorRule {
  token: string;
  replacement: string;
  operator: MutationOperator;
  /** A word needs boundaries around it; punctuation needs spaces around it. */
  kind: "punctuation" | "word";
}

// Longest token first: "===" has to be tried before "==", and "<=" before
// "<", or a three character operator would be read as a two character one
// and mutated into something that does not parse.
const OPERATOR_RULES: readonly OperatorRule[] = [
  { token: "===", replacement: "!==", operator: "equality", kind: "punctuation" },
  { token: "!==", replacement: "===", operator: "equality", kind: "punctuation" },
  { token: "==", replacement: "!=", operator: "equality", kind: "punctuation" },
  { token: "!=", replacement: "==", operator: "equality", kind: "punctuation" },
  { token: "<=", replacement: "<", operator: "comparison-boundary", kind: "punctuation" },
  { token: ">=", replacement: ">", operator: "comparison-boundary", kind: "punctuation" },
  { token: "&&", replacement: "||", operator: "boolean-connective", kind: "punctuation" },
  { token: "||", replacement: "&&", operator: "boolean-connective", kind: "punctuation" },
  { token: "<", replacement: "<=", operator: "comparison-boundary", kind: "punctuation" },
  { token: ">", replacement: ">=", operator: "comparison-boundary", kind: "punctuation" },
  { token: "+", replacement: "-", operator: "arithmetic", kind: "punctuation" },
  { token: "-", replacement: "+", operator: "arithmetic", kind: "punctuation" },
  { token: "true", replacement: "false", operator: "boolean-literal", kind: "word" },
  { token: "false", replacement: "true", operator: "boolean-literal", kind: "word" },
];

// This table stays exactly as it was for the six languages it already
// covered: rewriting it to a node-type-driven table, the way the six
// tree-sitter grammars in src/tree-sitter-grammars.ts decide what is a
// comment or a string, would be a large behaviour change on every
// existing user's mutation runs, on every language at once, and it
// deserves its own phase with its own evidence, not a side effect of
// adding Python. Python turned out not to need it: see
// PYTHON_OPERATOR_RULES and operatorRulesFor below.

/**
 * Python's boolean literals and connectives are words, not punctuation:
 * `True`, `False`, `and`, `or`. Its comparison and arithmetic operators
 * (==, !=, <, >, <=, >=, +, -) are the same characters as the C family and
 * need no rule of their own; OPERATOR_RULES above already matches them
 * through the same whitespace-bounded scan every other language uses.
 *
 * Kept apart from OPERATOR_RULES, and applied only to a `.py` path (see
 * operatorRulesFor), so `True` is never offered as a mutation candidate in,
 * say, a Rust file, where it reads as an ordinary identifier and not a
 * keyword. Lowercase `true`/`false` already in OPERATOR_RULES above are
 * left reachable on a `.py` path too: they are not Python syntax, so they
 * can only ever match a Python identifier that happens to be spelled that
 * way, the same low-probability case every other language already accepts.
 */
const PYTHON_OPERATOR_RULES: readonly OperatorRule[] = [
  { token: "True", replacement: "False", operator: "boolean-literal", kind: "word" },
  { token: "False", replacement: "True", operator: "boolean-literal", kind: "word" },
  { token: "and", replacement: "or", operator: "boolean-connective", kind: "word" },
  { token: "or", replacement: "and", operator: "boolean-connective", kind: "word" },
];

/**
 * The operator rules that apply to one file, chosen from its path. Every
 * mutable extension gets OPERATOR_RULES; a `.py` path also gets
 * PYTHON_OPERATOR_RULES. This is the per-language selection point: adding
 * an eighth language's own word operators means adding a table here and
 * one more branch, not touching what any other language matches.
 */
function operatorRulesFor(path: string): readonly OperatorRule[] {
  return extensionOf(path) === ".py" ? [...OPERATOR_RULES, ...PYTHON_OPERATOR_RULES] : OPERATOR_RULES;
}

/**
 * A punctuation operator counts only with whitespace on both sides. That
 * single rule does a lot of work and is the reason this tool needs no
 * parser: it skips `=>`, `+=`, `-=`, `++`, `--`, `<<`, `>>`, `->`, a
 * TypeScript generic such as `Array<string>`, a JSX tag, and a unary minus
 * in `f(-1)`, all of which would otherwise turn into text that does not
 * compile. The cost is real: `i<n` written without spaces is never
 * mutated. A skipped candidate understates the hole in a suite, which is
 * the direction to err in.
 */
function spacedOnBothSides(line: string, start: number, end: number): boolean {
  const before = line[start - 1];
  const after = line[end];
  return (before === " " || before === "\t") && (after === " " || after === "\t");
}

function wordBounded(line: string, start: number, end: number): boolean {
  const before = line[start - 1];
  const after = line[end];
  if (before !== undefined && IDENT_CHAR.test(before)) return false;
  if (after !== undefined && IDENT_CHAR.test(after)) return false;
  return true;
}

// --- planning -----------------------------------------------------------------

export interface PlanOptions {
  rules?: RuleSet;
  /** How many mutations to keep, counted after ordering. */
  max?: number;
}

export interface SourceFile {
  path: string;
  text: string;
}

/**
 * Every mutation for one file, in line then column order. A comment line
 * and an import line are skipped whole, using the same two helpers the
 * test-diff gate uses, so "what is a comment" is answered once for this
 * project. A line inside a block comment is skipped by the mask instead.
 */
export function planFileMutations(path: string, text: string): Mutation[] {
  const mask = languageServiceFor(path).codeMask(text);
  const rules = operatorRulesFor(path);
  const mutations: Mutation[] = [];
  const lines = text.split("\n");
  let offset = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const lineStart = offset;
    offset += line.length + 1;
    if (line.trim() === "") continue;
    if (isCommentLine(line) || isImportLine(line)) continue;

    for (let col = 0; col < line.length; col++) {
      if (!mask[lineStart + col]) continue;
      const rule = matchRuleAt(line, col, rules);
      if (rule === undefined) continue;
      const end = col + rule.token.length;
      const after = `${line.slice(0, col)}${rule.replacement}${line.slice(end)}`;
      mutations.push({
        file: path,
        line: lineIndex + 1,
        column: col + 1,
        operator: rule.operator,
        original: rule.token,
        replacement: rule.replacement,
        before: line,
        after,
      });
      col = end - 1; // one token cannot overlap the next
    }
  }
  return mutations;
}

function matchRuleAt(line: string, col: number, rules: readonly OperatorRule[]): OperatorRule | undefined {
  for (const rule of rules) {
    if (!line.startsWith(rule.token, col)) continue;
    const end = col + rule.token.length;
    if (rule.kind === "punctuation") {
      if (!spacedOnBothSides(line, col, end)) continue;
      return rule;
    }
    if (!wordBounded(line, col, end)) continue;
    return rule;
  }
  return undefined;
}

/**
 * Every mutation for a set of files, ordered by path, then line, then
 * column, then capped at `max`. The order comes from the sort here and
 * from the scan order inside each file, never from the order the caller
 * happened to collect the files in: two runs over the same input have to
 * produce the same list.
 */
export function planMutations(files: SourceFile[], options: PlanOptions = {}): Mutation[] {
  const ordered = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const all: Mutation[] = [];
  for (const file of ordered) {
    if (!isMutablePath(file.path, options.rules)) continue;
    all.push(...planFileMutations(file.path, file.text));
  }
  if (options.max === undefined) return all;
  return all.slice(0, Math.max(0, options.max));
}

/**
 * `planMutations`, warmed first. `planFileMutations` reaches
 * `languageServiceFor` directly (see the comment there), which answers a
 * `.py` file with the tree-sitter mask only once `warmLanguageServices`
 * has resolved it for this process; anything asked before that gets the
 * regex scanner's answer instead, silently. `hooks/test-diff-separator.ts`,
 * `hooks/test-diff-post-tool-hook.ts`, and `src/mcp-server.ts` each warm
 * for their own paths before calling into their own synchronous work;
 * `hooks/mutate.ts` used to call `planMutations` straight, without a
 * fourth warm call to match, which is why a Python file taken through
 * `adg mutate` got the regex mask with nothing to say a better one was
 * ever available.
 *
 * This is that fourth warm call, folded into the one function every
 * caller of `planMutations` should now reach for instead: warming and
 * planning together, so getting the right mask for whichever languages a
 * batch of files actually contains no longer depends on the caller
 * remembering a second, separate step. `planMutations` itself stays
 * synchronous and unwarmed on purpose, for callers (tests among them)
 * that already hold files in memory and have no `.py` file in the mix, or
 * warm some other way; this wrapper is for the ones that do not.
 */
export async function planMutationsWarmed(files: SourceFile[], options: PlanOptions = {}): Promise<Mutation[]> {
  await warmLanguageServices(files.map((file) => file.path));
  return planMutations(files, options);
}

/**
 * Applies one mutation to a file's text and returns the new text. Throws
 * when the line is not where the mutation says it is: a tool that writes to
 * a user's files must fail loudly on a mismatch, never write a guess.
 */
export function applyMutation(text: string, mutation: Mutation): string {
  const lines = text.split("\n");
  const index = mutation.line - 1;
  if (index < 0 || index >= lines.length) {
    throw new Error(`${mutation.file}: line ${mutation.line} is past the end of the file`);
  }
  if (lines[index] !== mutation.before) {
    throw new Error(`${mutation.file}: line ${mutation.line} no longer matches the planned mutation`);
  }
  lines[index] = mutation.after;
  return lines.join("\n");
}

// --- reporting ----------------------------------------------------------------

export interface RunSummary {
  killed: number;
  survived: number;
  timeout: number;
  skipped: number;
  /** A mutation whose run was killed for printing more than the output
   * cap, before it could be judged. Reported apart from `killed`, the way
   * Stryker separates "no coverage" from "killed" and PIT gives resource
   * exhaustion its own status: neither tool folds a run nobody judged into
   * a run the suite caught. */
  outputOverflow: number;
  /** A mutation whose run was killed by a signal other than the timeout or
   * the output cap: a segfault, an out-of-memory kill, a command that
   * signalled itself. That kill says nothing about whether the suite would
   * have noticed the mutation either, so it is kept apart from `killed`
   * for the same reason `outputOverflow` is. */
  killedBySignal: number;
}

export function summarize(results: MutationResult[]): RunSummary {
  const summary: RunSummary = { killed: 0, survived: 0, timeout: 0, skipped: 0, outputOverflow: 0, killedBySignal: 0 };
  for (const result of results) {
    if (result.verdict === "output-overflow") summary.outputOverflow++;
    else if (result.verdict === "killed-by-signal") summary.killedBySignal++;
    else summary[result.verdict]++;
  }
  return summary;
}

/** A mutation the run never judged: it hung until the timeout, printed
 * more than this tool will hold, was killed by a signal that had nothing
 * to do with the suite, or was skipped before the command ever ran. None
 * of those says anything about whether the suite would have caught that
 * break. An output-cap kill and a signal kill are as unmeasured as a
 * timeout for exactly the same reason isUnmeasured already gives for a
 * timeout: the run was cut off before it could report a verdict, so
 * crediting it as a catch would credit the suite with a catch it never
 * made. */
function isUnmeasured(result: MutationResult): boolean {
  return (
    result.verdict === "timeout" ||
    result.verdict === "skipped" ||
    result.verdict === "output-overflow" ||
    result.verdict === "killed-by-signal"
  );
}

/**
 * Exit code for a finished run:
 *   0  every attempted mutation got a verdict and none survived
 *   1  at least one mutation survived
 *   3  nothing survived, but at least one mutation never got a verdict, or
 *      at least one selected file's language had no operator set to try
 * A survivor wins over an unmeasured mutation or file, because a hole a
 * test left open is the more useful thing to report. Exit 3 exists so a
 * run that could not judge part of its work never reads the same as a run
 * that judged all of it and found nothing: that is the whole point of this
 * project, and folding a timeout into 0 broke it here. `unsupportedFiles`
 * (see unsupportedLanguagePaths above) is the same principle applied one
 * level earlier: a file skipped before planning because this tool has no
 * operators for its language is exactly as unmeasured as a mutation that
 * timed out, and a run whose every candidate fell into that bucket must
 * not read as exit 0 either. The CLI owns exit 2, which means the run
 * could not happen at all.
 */
export function exitCodeFor(results: MutationResult[], unsupportedFiles: readonly string[] = []): 0 | 1 | 3 {
  if (results.some((result) => result.verdict === "survived")) return 1;
  if (results.some(isUnmeasured) || unsupportedFiles.length > 0) return 3;
  return 0;
}

export interface ReportInput {
  command: string;
  baselineMs: number;
  timeoutMs: number;
  filesConsidered: string[];
  planned: number;
  attempted: number;
  results: MutationResult[];
  /** Candidate files skipped before planning because this tool has no
   * operator set for their language: see unsupportedLanguagePaths above.
   * Reported by name and folded into exit 3 the same way an unjudged
   * mutation is, so a run over files in a language this tool cannot yet
   * speak never prints the same report as a run that mutated everything
   * and found no survivors. Absent or empty when every candidate had a
   * language this tool covers. */
  unsupportedFiles?: string[];
}

function describeMutation(mutation: Mutation): string {
  return `${mutation.file}:${mutation.line}:${mutation.column}  ${mutation.operator}  ${mutation.original} to ${mutation.replacement}`;
}

export function formatReportText(input: ReportInput): string {
  const summary = summarize(input.results);
  const unsupportedFiles = input.unsupportedFiles ?? [];
  const lines: string[] = [];
  lines.push(`Command: ${input.command}`);
  lines.push(`Baseline: passed in ${(input.baselineMs / 1000).toFixed(1)}s`);
  lines.push(`Per-mutation timeout: ${(input.timeoutMs / 1000).toFixed(1)}s`);
  lines.push(`Files: ${input.filesConsidered.length === 0 ? "(none)" : input.filesConsidered.join(", ")}`);
  lines.push(`Mutations: ${input.planned} planned, ${input.attempted} attempted`);
  lines.push("");
  lines.push(
    `killed ${summary.killed}, survived ${summary.survived}, timeout ${summary.timeout}, skipped ${summary.skipped}, ` +
      `output-overflow ${summary.outputOverflow}, killed-by-signal ${summary.killedBySignal}`,
  );

  if (input.attempted < input.planned) {
    const stopped = input.planned - input.attempted;
    lines.push("");
    lines.push(`Not every planned mutation was attempted: --max stopped the run at ${input.attempted} of ${input.planned}.`);
    lines.push(
      `Mutations run in path, then line, then column order, and the cap keeps the first ${input.attempted} of that order, so a`,
    );
    lines.push(
      `file early in the order can use the whole budget and a file after it is never touched at all. That`,
    );
    lines.push(`leaves ${stopped} of the ${input.planned} planned mutations unmeasured, and nothing below says anything about them.`);
  }

  const survivors = input.results.filter((result) => result.verdict === "survived");
  if (survivors.length > 0) {
    lines.push("");
    lines.push(`Survivors (${survivors.length}):`);
    for (const result of survivors) {
      lines.push(`  ${describeMutation(result.mutation)}`);
      lines.push(`    before: ${result.mutation.before.trim()}`);
      lines.push(`    after:  ${result.mutation.after.trim()}`);
    }
  }

  const unmeasured = input.results.filter(isUnmeasured);
  if (unmeasured.length > 0) {
    lines.push("");
    lines.push(`No verdict on these (${unmeasured.length}):`);
    for (const result of unmeasured) lines.push(`  ${result.verdict}  ${describeMutation(result.mutation)}`);
  }

  if (unsupportedFiles.length > 0) {
    lines.push("");
    lines.push(`No operator set for these (${unsupportedFiles.length}):`);
    for (const path of unsupportedFiles) lines.push(`  ${path}`);
  }

  lines.push("");
  if (survivors.length > 0) {
    lines.push("A surviving mutation means no test noticed the code changed.");
  } else if (unmeasured.length > 0 && unsupportedFiles.length > 0) {
    lines.push(
      `No mutation survived, but ${unmeasured.length} never got a verdict and ${unsupportedFiles.length} ` +
        `file(s) had no operator set for their language: both are unmeasured (exit 3).`,
    );
  } else if (unsupportedFiles.length > 0) {
    lines.push(
      `No mutation survived, but ${unsupportedFiles.length} selected file(s) had no operator set for their ` +
        `language: those files are unmeasured, not passed over (exit 3).`,
    );
  } else if (unmeasured.length > 0) {
    lines.push(
      `No mutation survived, but ${unmeasured.length} never got a verdict: those lines are still unmeasured (exit 3).`,
    );
  } else if (input.attempted < input.planned) {
    lines.push("No attempted mutation survived, but the run stopped at the cap, so part of the selection is unmeasured.");
  } else {
    lines.push("No mutation survived: every break this tool made was caught.");
  }
  return lines.join("\n");
}

export function formatReportJson(input: ReportInput): string {
  return `${JSON.stringify(
    {
      command: input.command,
      baselineMs: input.baselineMs,
      timeoutMs: input.timeoutMs,
      files: input.filesConsidered,
      planned: input.planned,
      attempted: input.attempted,
      summary: summarize(input.results),
      results: input.results,
      unsupportedFiles: input.unsupportedFiles ?? [],
    },
    null,
    2,
  )}\n`;
}
