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

import { languageServiceFor, warmLanguageServices, hadLanguageLoadFailure, IDENT_CHAR } from "./code-mask.ts";
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
 * Extensions this project has actually built language support for: the
 * ones MUTABLE_EXTENSIONS already has an operator table for, plus every
 * language src/tree-sitter-grammars.ts has a GrammarSpec for (Rust, Ruby,
 * PHP, Go, Java, C#) -- Ruby among them being exactly the case that
 * matters: this tool can already tell Ruby code from a Ruby comment or
 * string, has never heard of a Ruby operator to mutate. `.py` is covered
 * twice over (MUTABLE_EXTENSIONS and its own tree-sitter service) and
 * costs nothing to union in again.
 *
 * This is the signal this tool already has for "I recognise this as
 * source": whether it has gone to the trouble of writing a grammar or an
 * operator table for the extension at all. It cannot be an accident of a
 * forgotten name the way a denylist of non-languages is, because the only
 * way onto this set is this project's own code doing the work -- adding a
 * seventh GrammarSpec or an eighth MUTABLE_EXTENSIONS entry is the only
 * way an extension joins it, so it never has to be maintained as a
 * separate list of "languages that exist."
 */
const RECOGNIZED_LANGUAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  ...MUTABLE_EXTENSIONS,
  ...Object.keys(GRAMMAR_SPECS),
]);

/**
 * The candidate paths `selectMutablePaths` above drops for want of an
 * operator set, restricted to a language this tool recognises (see
 * RECOGNIZED_LANGUAGE_EXTENSIONS): a real, non-test source file this tool
 * has a grammar or a mask for -- so it knows the file is source, not
 * markup or data -- but has not written mutation rules for. Ruby is the
 * standing example.
 *
 * A file whose extension this tool has never heard of at all -- a shell
 * script, Terraform, a `.proto` file, Elixir -- is deliberately NOT
 * folded in here. This function used to be the exit-3 signal for both
 * cases at once, first as an allowlist of known languages (anything
 * outside it, including a real, entirely unsupported language, vanished from
 * the report without a trace) and then as a denylist of known non-source
 * extensions (which then had to name every config, data, and script
 * extension a real repository has, and missed enough of them --
 * `.sh` among them -- to fail this project's own commits on files
 * unconnected to code quality). Neither a list of known languages nor a
 * list of known non-languages can ever be complete; the fix is not a
 * third list, it is asking a narrower question. Exit 3 means this tool
 * could not measure something it should have been able to; an extension
 * it has never attempted a grammar or an operator table for is not that
 * -- it was never going to be measured, the same way a config file never
 * was. See `unrecognizedLanguagePaths` below for where a file like that
 * is still reported, just without touching the exit code.
 */
export function unsupportedLanguagePaths(paths: string[], rules?: RuleSet): string[] {
  return paths
    .filter((path) => {
      const ext = extensionOf(path);
      if (ext === "") return false;
      if (hasMutableExtension(path)) return false;
      if (!RECOGNIZED_LANGUAGE_EXTENSIONS.has(ext)) return false;
      return !classifyTestPath(path, rules).isTest;
    })
    .sort();
}

/**
 * Extensions this project already knows are not a programming language:
 * markup and documentation, serialized data, style sheets, lockfiles and
 * other config, and common binary/media formats. This list exists only to
 * keep `unrecognizedLanguagePaths` below quiet on an ordinary commit that
 * touches package.json or README.md -- it is not wired to the exit code,
 * so a name missing from it costs this project a harmless extra report
 * line for a config file, never a failed build. That is what lets this
 * stay a short, hand-maintained list instead of a completeness project:
 * being wrong on it in the noisy direction (naming a file that was
 * really was never going to matter) is the failure worth having.
 */
const NON_SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  // markup and documentation
  ".md",
  ".mdx",
  ".txt",
  ".rst",
  ".adoc",
  ".html",
  ".htm",
  ".xml",
  ".svg",
  // serialized data
  ".json",
  ".json5",
  ".jsonc",
  ".yaml",
  ".yml",
  ".toml",
  ".csv",
  ".tsv",
  ".ndjson",
  // style sheets
  ".css",
  ".scss",
  ".sass",
  ".less",
  // lockfiles and other config
  ".lock",
  ".ini",
  ".cfg",
  ".conf",
  ".env",
  ".editorconfig",
  ".gitignore",
  ".gitattributes",
  // binary and media
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".webp",
  ".pdf",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  // build byproducts
  ".map",
  ".log",
]);

/**
 * The candidate paths that are none of the above: not mutable, not a
 * recognised-but-unsupported language (`unsupportedLanguagePaths`), not a
 * test file, and not one of the common non-source extensions this project
 * already knows to stay quiet about. A shell script, a `.proto` file, a
 * Terraform file, a notebook, a certificate, an extension this tool has
 * has plainly never seen -- this is where the "nothing selected vanishes"
 * requirement is met for them: named here, instead of silently dropped
 * the way this project used to drop them and the way an allowlist or a
 * denylist of "real" extensions always eventually drops something.
 *
 * Deliberately outside `exitCodeFor`'s reach (see ReportInput's
 * `unrecognizedFiles` below): a run over only files in a language this
 * tool has never attempted did not fail to measure anything it should
 * have been able to, so it must not read as exit 3. It also must not read
 * as a silent exit 0/2 with the file unnamed, which is the bug this
 * function exists to close. An extensionless path (a Makefile, a
 * Dockerfile, a bare "LICENSE") is left out for the same reason it always
 * was: these are overwhelmingly build metadata, not program source, and
 * carry no extension to say otherwise.
 */
export function unrecognizedLanguagePaths(paths: string[], rules?: RuleSet): string[] {
  return paths
    .filter((path) => {
      const ext = extensionOf(path);
      if (ext === "") return false;
      if (hasMutableExtension(path)) return false;
      if (RECOGNIZED_LANGUAGE_EXTENSIONS.has(ext)) return false;
      if (NON_SOURCE_EXTENSIONS.has(ext)) return false;
      return !classifyTestPath(path, rules).isTest;
    })
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
 *
 * `hooks/mutate.ts` no longer calls this directly: warming and planning
 * together here cannot tell "grammar loaded" from "grammar failed to
 * load, regex fallback in silent use" for any file in the batch, which is
 * exactly the gap that let a Python docstring get mutated on a machine
 * with no tree-sitter-python installed (see `warmAndSplitByGrammar`
 * below, which the CLI uses instead). This export stays for a caller that
 * only needs "warm, then plan" and does not write the result back to
 * disk -- tests among them -- where a wrong mask costs nothing worse than
 * a wrong assertion.
 */
export async function planMutationsWarmed(files: SourceFile[], options: PlanOptions = {}): Promise<Mutation[]> {
  await warmLanguageServices(files.map((file) => file.path));
  return planMutations(files, options);
}

/**
 * The paths, out of a list already known to be mutable (see
 * `selectMutablePaths`), whose language service is a tree-sitter grammar
 * that was attempted and failed to load -- `hadLanguageLoadFailure` in
 * src/code-mask.ts says which. Must be called after warming, not before:
 * an extension warming has not tried yet has not failed either, and
 * calling this too early would wrongly call it safe.
 *
 * A path returned here has no trustworthy mask. `languageServiceFor`
 * would answer it with the regex scanner -- the C-family scanner, applied
 * to a language it was never written for -- and calling that mask correct
 * is exactly the CRITICAL defect this function exists to close: four of
 * seven mutations planned for a Python file landed inside its docstring
 * once `tree-sitter-python`/`web-tree-sitter` were absent, and all four
 * were reported "survived," corrupting the score along with the file on
 * disk for the run's duration. See `warmAndSplitByGrammar` below for how
 * the CLI keeps a path like this out of `planMutations` altogether.
 */
export function grammarUnavailablePaths(paths: readonly string[]): string[] {
  return paths.filter((path) => hadLanguageLoadFailure(extensionOf(path))).sort();
}

/**
 * Warms every mutable path's language service, then splits them into
 * `trustworthy` (safe to hand to `planMutations`) and `grammarUnavailable`
 * (must not be mutated at all: see `grammarUnavailablePaths` above). This
 * is what `hooks/mutate.ts` calls instead of `planMutationsWarmed`,
 * precisely so a file whose grammar failed to load is never read into
 * `planMutations` in the first place -- there is no correct mutation to
 * plan for it, only a wrong one using the wrong scanner, so the only safe
 * answer is to never ask.
 */
export async function warmAndSplitByGrammar(
  mutablePaths: readonly string[],
): Promise<{ trustworthy: string[]; grammarUnavailable: string[] }> {
  await warmLanguageServices(mutablePaths);
  const grammarUnavailable = grammarUnavailablePaths(mutablePaths);
  const failed = new Set(grammarUnavailable);
  const trustworthy = mutablePaths.filter((path) => !failed.has(path));
  return { trustworthy, grammarUnavailable };
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
 *   3  nothing survived, but at least one mutation never got a verdict, at
 *      least one selected file's language had no operator set to try, or
 *      at least one selected file's grammar failed to load
 * A survivor wins over an unmeasured mutation or file, because a hole a
 * test left open is the more useful thing to report. Exit 3 exists so a
 * run that could not judge part of its work never reads the same as a run
 * that judged all of it and found nothing: that is the whole point of this
 * project, and folding a timeout into 0 broke it here. `unsupportedFiles`
 * (see unsupportedLanguagePaths above) is the same principle applied one
 * level earlier: a file skipped before planning because this tool has no
 * operators for its language is exactly as unmeasured as a mutation that
 * timed out, and a run whose every candidate fell into that bucket must
 * not read as exit 0 either. `grammarUnavailableFiles` (see
 * grammarUnavailablePaths above) is the same principle again, one level
 * earlier still: a file this tool does have an operator table for, but
 * whose tree-sitter grammar failed to load, was never mutated at all --
 * planning a mutation for it would have used the wrong scanner -- so it
 * is exactly as unmeasured as the other two. The CLI owns exit 2, which
 * means the run could not happen at all.
 *
 * A file `unrecognizedLanguagePaths` reports is deliberately not a
 * parameter here at all: this tool never had a grammar or an operator
 * table for that extension, so it never claimed it could measure it, and
 * a run over only files like that must not read as exit 3 -- reported by
 * name in the text/JSON report, never folded into this exit code.
 */
export function exitCodeFor(
  results: MutationResult[],
  unsupportedFiles: readonly string[] = [],
  grammarUnavailableFiles: readonly string[] = [],
): 0 | 1 | 3 {
  if (results.some((result) => result.verdict === "survived")) return 1;
  if (results.some(isUnmeasured) || unsupportedFiles.length > 0 || grammarUnavailableFiles.length > 0) return 3;
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
  /** Candidate files skipped before planning because their tree-sitter
   * grammar was attempted and failed to load: see grammarUnavailablePaths
   * above. This tool does have an operator table for these -- unlike
   * `unsupportedFiles` -- but no trustworthy mask to apply it through, so
   * mutating one would use the regex scanner's C-family assumptions on a
   * language it was never written for. Reported by name and folded into
   * exit 3 for the same reason unsupportedFiles is: a run over files
   * whose grammar this process could not load must not print the same
   * report as a run that mutated everything and found no survivors.
   * Absent or empty when every candidate's grammar loaded, or needed
   * none. */
  grammarUnavailableFiles?: string[];
  /** Candidate files skipped before planning because their extension is
   * not a language this tool has ever built a grammar or an operator
   * table for: see unrecognizedLanguagePaths above. Reported by name so
   * nothing a run was asked to consider vanishes from the report, but
   * deliberately NOT folded into exit 3 -- unlike unsupportedFiles and
   * grammarUnavailableFiles above, this tool never claimed it could
   * measure these, so their presence is not a failure to measure
   * something it should have. Absent or empty when every candidate's
   * language was either mutable, recognised-but-unsupported, or common
   * enough to stay quiet about entirely. */
  unrecognizedFiles?: string[];
}

function describeMutation(mutation: Mutation): string {
  return `${mutation.file}:${mutation.line}:${mutation.column}  ${mutation.operator}  ${mutation.original} to ${mutation.replacement}`;
}

/** Joins English clauses with a comma and a trailing "and", the way a
 * person would say a list of two or more reasons out loud. Used only when
 * a grammar-load failure joins the two existing unmeasured reasons below,
 * so their two-reason phrasing (see formatReportText) never has to become
 * a template that also has to cover three. */
function joinClauses(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

export function formatReportText(input: ReportInput): string {
  const summary = summarize(input.results);
  const unsupportedFiles = input.unsupportedFiles ?? [];
  const grammarUnavailableFiles = input.grammarUnavailableFiles ?? [];
  const unrecognizedFiles = input.unrecognizedFiles ?? [];
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

  if (grammarUnavailableFiles.length > 0) {
    lines.push("");
    lines.push(`Grammar failed to load for these (${grammarUnavailableFiles.length}):`);
    for (const path of grammarUnavailableFiles) lines.push(`  ${path}`);
  }

  if (unrecognizedFiles.length > 0) {
    lines.push("");
    lines.push(`Not a language this tool recognises, not measured (${unrecognizedFiles.length}):`);
    for (const path of unrecognizedFiles) lines.push(`  ${path}`);
  }

  lines.push("");
  if (survivors.length > 0) {
    lines.push("A surviving mutation means no test noticed the code changed.");
  } else if (grammarUnavailableFiles.length > 0) {
    // Kept apart from the unmeasured/unsupported-only branches below so
    // their exact wording, pinned by existing tests, never has to change
    // just because a third reason joined the other two. This branch's own
    // wording generalises across any mix of the three.
    const clauses: string[] = [];
    if (unmeasured.length > 0) clauses.push(`${unmeasured.length} never got a verdict`);
    if (unsupportedFiles.length > 0) clauses.push(`${unsupportedFiles.length} file(s) had no operator set for their language`);
    clauses.push(`${grammarUnavailableFiles.length} file(s) could not be trusted because their grammar failed to load`);
    lines.push(`No mutation survived, but ${joinClauses(clauses)}: all of that is unmeasured (exit 3).`);
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
  } else if (input.planned === 0) {
    // Every other unmeasured reason above is checked and absent, so the
    // only way to land here with zero planned mutations is that nothing
    // selected gave this tool anything to break -- an empty selection, or
    // a selection made entirely of files it does not recognise (see
    // unrecognizedFiles above). Either way, this run made no attempt, and
    // must not read as a suite that caught something it was never shown.
    lines.push("No mutation was attempted: this tool made no breaks, so the suite caught nothing and this run proves nothing.");
  } else {
    lines.push("No mutation survived: every break this tool made was caught.");
  }

  if (unrecognizedFiles.length > 0) {
    // Always appended, independent of the exit-3 reasoning above: this
    // list does not change the exit code, so its explanation stands on
    // its own instead of joining joinClauses' tally of what is unmeasured.
    lines.push(
      `${unrecognizedFiles.length} selected file(s) are in a language this tool has never built a grammar or ` +
        `operator table for; they are reported by name above and skipped, not counted toward exit 3.`,
    );
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
      grammarUnavailableFiles: input.grammarUnavailableFiles ?? [],
      unrecognizedFiles: input.unrecognizedFiles ?? [],
    },
    null,
    2,
  )}\n`;
}
