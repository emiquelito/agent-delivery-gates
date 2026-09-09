// Pure core for `adg census`. Takes the text a test runner printed and
// turns it into a census: one record per test, each with a file, a name,
// and an outcome. Then it compares two censuses and says what changed. No
// I/O, no git, no subprocess, no process exit: the CLI in hooks/census.ts
// does all of that, so the decision about what counts as a test, and what
// counts as a finding, lives in exactly one place and can be tested
// without running anybody's suite.
//
// The point of this check: a green suite says the tests that ran passed.
// It says nothing about the tests that stopped running, and nothing about
// whether a test added beside a fix would have failed without the fix. A
// test that passes before the fix and after it proves nothing about the
// fix. Both of those questions need a second run, at an older commit, and
// that is what this command exists to make routine.

// --- the census ---------------------------------------------------------------

/** What one test did. A runner's "error" counts as a fail here; a test
 * that never loaded produces no record at all, which is a different thing
 * and is treated as such below. */
export type Outcome = "pass" | "fail" | "skip";

export interface TestRecord {
  /**
   * The file the test lives in, as the runner reported it, or "" when the
   * runner did not say. Node's TAP output names no file for a passing
   * test, so "" is the normal case there and not a parse failure.
   */
  file: string;
  /** The test's name, with any enclosing suite names joined by " > ". */
  name: string;
  outcome: Outcome;
}

export type ResultFormat = "tap" | "junit";

export interface ParsedResults {
  format: ResultFormat;
  tests: TestRecord[];
}

/**
 * The identity of one test: its file and its name. Nothing else is
 * available across two runs of two different commits, and nothing else
 * would survive a line moving. The cost is stated plainly in --help: a
 * renamed test reads as one test disappearing and another appearing,
 * because from outside that is exactly what it looks like.
 */
export function testKey(test: { file: string; name: string }): string {
  // The separator is a newline because neither half can hold one: a TAP
  // result line and an XML attribute both end before a newline can reach
  // either field. Joining the two halves with nothing between them would let
  // ("ab", "c") and ("a", "bc") collide into one key.
  return `${test.file}\n${test.name}`;
}

// --- format detection ---------------------------------------------------------

const TAP_LINE = /^[ \t]*(?:not )?ok\b/m;
const TAP_HEADER = /^TAP version\b/im;
const TAP_PLAN = /^[ \t]*\d+\.\.\d+[ \t]*$/m;
const JUNIT_CASE = /<testcase[\s>/]/;
const JUNIT_SUITE = /<testsuites?[\s>]/;

/**
 * Which format the text is in, or null when it is neither. JUnit wins when
 * both match: an XML document that also holds a line starting with "ok" is
 * still XML, while TAP holds no angle-bracketed testcase tag. Returning
 * null is what makes an unreadable run exit 2 in the CLI instead of
 * reading as a run that found no tests.
 */
export function detectFormat(text: string): ResultFormat | null {
  if (JUNIT_CASE.test(text) || JUNIT_SUITE.test(text)) return "junit";
  if (TAP_HEADER.test(text) || TAP_LINE.test(text) || TAP_PLAN.test(text)) return "tap";
  return null;
}

/**
 * Parses text into a census, in the format given or the one detected.
 * Returns an error string when the text is in no format this tool reads,
 * so the caller can exit 2. An empty census from text that did parse is a
 * real answer ("the runner ran nothing"); an empty census from text that
 * did not parse is not, and the two must never come back the same.
 */
export function parseResults(text: string, forced?: ResultFormat): ParsedResults | { error: string } {
  const detected = detectFormat(text);
  // A forced format chooses between the two parsers; it does not make
  // unreadable text readable. Text carrying no marker of either format
  // would parse to a census of zero tests under any parser, and zero tests
  // is what a suite that lost every test looks like. Forcing a format must
  // not be a way around that, so the check runs whether or not one is
  // forced.
  if (detected === null) {
    return {
      error: "the output is in neither TAP nor JUnit XML, so no test results could be read from it",
    };
  }
  const format = forced ?? detected;
  const tests = format === "tap" ? parseTap(text) : parseJUnit(text);
  // A testcase with no name is not a test this tool can identify, and a
  // record with an empty name would silently take part in the comparison as
  // if it were one. Every writer of this format names its cases, so a
  // nameless one means the scanner read the document wrong. Exit 2 is the
  // honest answer; a census built on it would not be.
  if (format === "junit" && tests.some((test) => test.name === "")) {
    return {
      error:
        "a <testcase> element carried no name, so these results could not be read as a census of tests",
    };
  }
  return { format, tests };
}

// --- TAP ----------------------------------------------------------------------

interface TapEntry {
  indent: number;
  name: string;
  outcome: Outcome;
}

interface PathRecord {
  path: string[];
  outcome: Outcome;
}

const TAP_RESULT = /^([ \t]*)(not )?ok\b[ \t]*(\d+)?[ \t]*(?:-[ \t]*)?(.*)$/;

/**
 * Parses TAP 13, which is what `node --test` prints when its output is not
 * a terminal, and what tape and several other runners print. Handles:
 *   - "ok" and "not ok" lines, with or without a number and a dash;
 *   - the "# SKIP" and "# TODO" directives, both counted as a skip;
 *   - the YAML diagnostic block between "---" and "...", skipped whole,
 *     because a failure message inside one can hold the text "not ok" and
 *     would otherwise be counted as a test of its own;
 *   - nesting by indentation, where a parent's own result line comes after
 *     its children, so a parent with children is a suite and not a test.
 * A "# Subtest:" line and every other "#" comment is ignored: the result
 * line that follows carries the same name.
 */
export function parseTap(text: string): TestRecord[] {
  const entries: TapEntry[] = [];
  const lines = text.split("\n");
  let inYaml = false;
  let yamlIndent = 0;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    const indent = countIndent(line);
    const trimmed = line.trim();
    if (inYaml) {
      if (trimmed === "..." && indent <= yamlIndent) inYaml = false;
      continue;
    }
    if (trimmed === "---") {
      inYaml = true;
      yamlIndent = indent;
      continue;
    }
    if (trimmed.startsWith("#")) continue;
    const match = TAP_RESULT.exec(line);
    if (match === null) continue;
    const failed = match[2] !== undefined;
    const description = match[4] ?? "";
    const { name, directive } = splitDirective(description);
    // Both SKIP and TODO mean the result is not a measurement: a skipped
    // test never ran, and a TODO result is declared in advance not to
    // count either way. Neither is allowed to stand in for a red run.
    const outcome: Outcome = directive !== null ? "skip" : failed ? "fail" : "pass";
    entries.push({ indent, name: name.trim(), outcome });
  }
  return foldNesting(entries).map(toRecord);
}

function countIndent(line: string): number {
  let count = 0;
  for (const ch of line) {
    if (ch === " ") count++;
    else if (ch === "\t") count += 4;
    else break;
  }
  return count;
}

/** Splits "name # SKIP why" into its name and its directive. A "#" that is
 * not a SKIP or TODO directive stays part of the name. */
function splitDirective(description: string): { name: string; directive: "skip" | "todo" | null } {
  const match = /^(.*?)[ \t]*#[ \t]*(skip|todo)\b.*$/i.exec(description);
  if (match === null) return { name: description, directive: null };
  return { name: match[1], directive: match[2].toLowerCase() as "skip" | "todo" };
}

/**
 * Turns a flat list of indented TAP results into a list of leaf tests, each
 * carrying the names of every suite above it. In TAP a subtest's own result
 * line is printed after the lines of its children and at a smaller indent,
 * so a result line that has more-indented results waiting under it is a
 * suite: counting it as a test as well would double-count the whole file.
 */
function foldNesting(entries: TapEntry[]): PathRecord[] {
  const stack: { indent: number; items: PathRecord[] }[] = [];
  for (const entry of entries) {
    const collected: PathRecord[] = [];
    while (stack.length > 0 && stack[stack.length - 1].indent > entry.indent) {
      collected.unshift(...stack.pop()!.items);
    }
    const produced: PathRecord[] =
      collected.length > 0
        ? collected.map((item) => ({ path: [entry.name, ...item.path], outcome: item.outcome }))
        : [{ path: [entry.name], outcome: entry.outcome }];
    if (stack.length === 0 || stack[stack.length - 1].indent !== entry.indent) {
      stack.push({ indent: entry.indent, items: [] });
    }
    stack[stack.length - 1].items.push(...produced);
  }
  const out: PathRecord[] = [];
  for (const frame of stack) out.push(...frame.items);
  return out;
}

/** A path segment that reads like a file path: it has a directory
 * separator, or an extension. Only the outermost segment is ever checked,
 * because that is the only one a runner puts a file name in. */
function looksLikeFile(segment: string): boolean {
  return segment.includes("/") || /\.[A-Za-z0-9]{1,5}$/.test(segment);
}

function toRecord(item: PathRecord): TestRecord {
  if (item.path.length > 1 && looksLikeFile(item.path[0])) {
    return { file: item.path[0], name: item.path.slice(1).join(" > "), outcome: item.outcome };
  }
  return { file: "", name: item.path.join(" > "), outcome: item.outcome };
}

/** A TAP plan line at the outermost level, with the count it promises and
 * the number of results printed beside it. */
export interface TapPlan {
  planned: number;
  printed: number;
}

const TAP_PLAN_LINE = /^(\d+)\.\.(\d+)[ \t]*$/;

/**
 * The outermost TAP plan and the outermost results, or null when the output
 * carries no plan at all. Only unindented lines count: a nested subtest
 * prints its own plan, and that plan counts the subtest's children, not the
 * file's own results.
 *
 * The caller compares the two numbers. A run that printed some TAP and then
 * died mid-stream promises more results than it printed, and the difference
 * is the only trace it leaves. Without this check that truncated census read
 * as a smaller suite, which read as tests appearing at HEAD.
 */
export function tapPlan(text: string): TapPlan | null {
  let planned = 0;
  let printed = 0;
  let seenPlan = false;
  let inYaml = false;
  let yamlIndent = 0;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const indent = countIndent(line);
    const trimmed = line.trim();
    if (inYaml) {
      if (trimmed === "..." && indent <= yamlIndent) inYaml = false;
      continue;
    }
    if (trimmed === "---") {
      inYaml = true;
      yamlIndent = indent;
      continue;
    }
    if (indent > 0 || trimmed.startsWith("#")) continue;
    const plan = TAP_PLAN_LINE.exec(line);
    if (plan !== null) {
      seenPlan = true;
      const from = Number(plan[1]);
      const to = Number(plan[2]);
      if (to >= from) planned += to - from + 1;
      continue;
    }
    if (TAP_RESULT.test(line)) printed++;
  }
  return seenPlan ? { planned, printed } : null;
}

const TAP_SUMMARY = /^[ \t]*#[ \t]*(tests|pass|fail|failed|ok)\b/im;
const JUNIT_CLOSE = /<\/testsuites?>|<testsuites?\b[^<>]*\/>/;

/**
 * Whether the output carries the mark a finished run leaves: a plan or a
 * summary line for TAP, a closing suite element for JUnit. A run that exited
 * non-zero without one of these did not finish printing, so what it did
 * print is part of a census and not a census. The caller treats that as a
 * run it could not compare, never as a suite that lost the rest of its
 * tests.
 */
export function resultsLookComplete(text: string, format: ResultFormat): boolean {
  if (format === "junit") return JUNIT_CLOSE.test(text);
  return tapPlan(text) !== null || TAP_SUMMARY.test(text);
}

// --- JUnit XML ----------------------------------------------------------------

/**
 * Parses the JUnit XML that pytest --junitxml, jest-junit,
 * go-junit-report, and the Maven surefire reports all write. Hand rolled,
 * because this package carries no runtime dependency and never will: it
 * looks for testcase elements, reads their attributes, and reads the one
 * child element that decides the outcome.
 *
 * Comments and CDATA sections are cut out first, so a failure message that
 * quotes XML cannot invent a testcase. Any other text is escaped by the
 * writer, so a bare "<testcase" in a message is not something a conforming
 * writer can produce. That is the limit of what a scanner this small can
 * promise, and it is stated in --help.
 */
export function parseJUnit(text: string): TestRecord[] {
  const cleaned = stripCommentsAndCdata(text);
  const records: TestRecord[] = [];
  let index = 0;
  for (;;) {
    const start = cleaned.indexOf("<testcase", index);
    if (start === -1) break;
    const after = cleaned[start + "<testcase".length];
    if (after !== undefined && !/[\s>/]/.test(after)) {
      index = start + 1;
      continue;
    }
    const tagEnd = findTagEnd(cleaned, start);
    if (tagEnd === -1) break;
    const tag = cleaned.slice(start, tagEnd + 1);
    const selfClosing = cleaned[tagEnd - 1] === "/";
    const attributes = parseAttributes(tag);
    let body = "";
    if (selfClosing) {
      index = tagEnd + 1;
    } else {
      const close = cleaned.indexOf("</testcase", tagEnd);
      body = close === -1 ? cleaned.slice(tagEnd + 1) : cleaned.slice(tagEnd + 1, close);
      index = close === -1 ? cleaned.length : close + 1;
    }
    records.push({
      file: attributes.file ?? attributes.classname ?? "",
      name: attributes.name ?? "",
      outcome: outcomeFromBody(body),
    });
  }
  return records;
}

/**
 * The index of the ">" that ends the tag opened at `start`, with quoted
 * attribute values stepped over. XML allows a bare ">" inside an attribute
 * value, and this tool's own testKey joins suite names with " > ", so a
 * runner writing name="outer > inner" is ordinary input and not a curiosity.
 * Ending the tag at the first ">" cut such a tag in half, lost the name, and
 * swallowed the testcase after it, which invented a disappeared test for
 * every one of them.
 */
function findTagEnd(text: string, start: number): number {
  let quote: string | null = null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ">") return i;
  }
  return -1;
}

/** A skipped case wins over a failure: a writer that records both means the
 * case did not run, and counting it as a failure would credit a red run
 * this tool never saw. */
function outcomeFromBody(body: string): Outcome {
  if (/<skipped[\s>/]/.test(body)) return "skip";
  if (/<(failure|error)[\s>/]/.test(body)) return "fail";
  return "pass";
}

function stripCommentsAndCdata(text: string): string {
  const parts: string[] = [];
  let i = 0;
  let plainFrom = 0;
  while (i < text.length) {
    if (text.startsWith("<!--", i)) {
      parts.push(text.slice(plainFrom, i));
      const end = text.indexOf("-->", i + 4);
      i = end === -1 ? text.length : end + 3;
      plainFrom = i;
      continue;
    }
    if (text.startsWith("<![CDATA[", i)) {
      parts.push(text.slice(plainFrom, i));
      const end = text.indexOf("]]>", i + 9);
      i = end === -1 ? text.length : end + 3;
      plainFrom = i;
      continue;
    }
    i++;
  }
  parts.push(text.slice(plainFrom));
  return parts.join("");
}

const ATTRIBUTE = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  ATTRIBUTE.lastIndex = 0;
  let match: RegExpExecArray | null = ATTRIBUTE.exec(tag);
  while (match !== null) {
    const value = match[2] ?? match[3] ?? "";
    attributes[match[1]] = decodeEntities(value);
    match = ATTRIBUTE.exec(tag);
  }
  return attributes;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// --- comparing two censuses ---------------------------------------------------

export type FindingKind = "disappeared" | "count-dropped" | "not-red-before-green" | "flipped";

/** A part of the run that was not measured. None of these is a pass and
 * none of them is a finding: they are the run admitting it did not get an
 * answer, which is what exit 3 exists to report. */
export type UnmeasuredKind =
  | "errored-at-base"
  | "skipped-at-base"
  | "base-not-comparable"
  | "red-run-not-comparable"
  | "identity-collision"
  | "did-not-settle";

export interface Finding {
  kind: FindingKind;
  file: string;
  name: string;
  detail: string;
}

export interface Unmeasured {
  kind: UnmeasuredKind;
  file: string;
  name: string;
  detail: string;
}

export interface CompareInput {
  /** The census at the base commit, or null when the base run could not be
   * compared. Null is not an empty list, and the difference is the single
   * most dangerous confusion in this command: an empty list would report
   * every test at the base as gone and every test at HEAD as new. */
  base: TestRecord[] | null;
  head: TestRecord[];
  /** The census from running this change's test files against the base
   * source, or null when that run could not be compared. */
  redRun: TestRecord[] | null;
}

export interface CompareResult {
  findings: Finding[];
  unmeasured: Unmeasured[];
  /** Tests at HEAD that the base census did not hold. */
  appeared: TestRecord[];
  /** Tests added by this change that did fail against the base source. */
  redAtBase: TestRecord[];
  baseCount: number | null;
  headCount: number;
}

function byKey(tests: TestRecord[]): Map<string, TestRecord> {
  const map = new Map<string, TestRecord>();
  for (const test of tests) map.set(testKey(test), test);
  return map;
}

function describe(test: { file: string; name: string }): string {
  return test.file === "" ? test.name : `${test.file} :: ${test.name}`;
}

/**
 * The whole comparison. Everything it reports is derived from the three
 * censuses it is given and nothing else, so the CLI can re-run a suite and
 * ask this same function again to check whether a finding holds twice.
 */
export function compareCensus(input: CompareInput): CompareResult {
  const head = input.head;
  const headByKey = byKey(head);

  if (input.base === null) {
    const red = compareRedRun(input.redRun, null);
    return {
      findings: red.findings,
      unmeasured: [
        {
          kind: "base-not-comparable",
          file: "",
          name: "",
          detail:
            "the base run produced no census that could be compared, so nothing is claimed here about a test that disappeared, a dropped count, or a flipped outcome",
        },
        ...red.unmeasured,
      ],
      appeared: [],
      redAtBase: red.redAtBase,
      baseCount: null,
      headCount: head.length,
    };
  }

  const findings: Finding[] = [];
  const base = input.base;
  const baseByKey = byKey(base);

  for (const test of base) {
    if (!headByKey.has(testKey(test))) {
      findings.push({
        kind: "disappeared",
        file: test.file,
        name: test.name,
        detail: `${describe(test)} ran at the base commit and does not run at HEAD`,
      });
    }
  }

  if (head.length < base.length) {
    findings.push({
      kind: "count-dropped",
      file: "",
      name: "",
      detail: `the suite ran ${base.length} tests at the base commit and ${head.length} at HEAD, ${base.length - head.length} fewer`,
    });
  }

  for (const test of head) {
    const before = baseByKey.get(testKey(test));
    if (before === undefined) continue;
    if (before.outcome === "pass" && test.outcome === "fail") {
      findings.push({
        kind: "flipped",
        file: test.file,
        name: test.name,
        detail: `${describe(test)} passed at the base commit and fails at HEAD`,
      });
    } else if (before.outcome === "fail" && test.outcome === "pass") {
      findings.push({
        kind: "flipped",
        file: test.file,
        name: test.name,
        detail: `${describe(test)} failed at the base commit and passes at HEAD`,
      });
    }
  }

  const appeared = head.filter((test) => !baseByKey.has(testKey(test)));
  const unmeasured: Unmeasured[] = [];
  // Identity is the file plus the name, and a runner that names no file
  // gives every test the same empty file half. Two tests that share a name
  // then share a key, so a test added under a name another file already used
  // is not in `appeared` and the red-before-green check never runs on it.
  // The count is the one thing that still shows it: HEAD grew by more tests
  // than there are names the base did not hold. That difference cannot be
  // measured, and saying so is the whole of what this tool can honestly do
  // with it.
  const uncounted = head.length - base.length - appeared.length;
  if (uncounted > 0) {
    unmeasured.push({
      kind: "identity-collision",
      file: "",
      name: "",
      detail:
        `HEAD ran ${head.length} tests to the base commit's ${base.length}, but only ${appeared.length} of them ` +
        `carries a file and name the base census did not already hold. ${uncounted} test(s) share an identity with ` +
        "another test, so the red-before-green check could not be run on every test this change added",
    });
  }
  const red = compareRedRun(input.redRun, appeared);

  return {
    findings: [...findings, ...red.findings],
    unmeasured: [...unmeasured, ...red.unmeasured],
    appeared,
    redAtBase: red.redAtBase,
    baseCount: base.length,
    headCount: head.length,
  };
}

interface RedResult {
  findings: Finding[];
  unmeasured: Unmeasured[];
  redAtBase: TestRecord[];
}

/**
 * The red-before-green half. `appeared` is the tests this change added,
 * measured as the tests at HEAD that the base census did not hold. With no
 * base census there is no such list, so nothing is claimed at all.
 *
 * A test that fails against the base source was red before the fix and is
 * the clean case. A test that passes against the base source demonstrated
 * nothing: it would have passed without the fix. A test missing from the
 * red run did not run at all, usually because it imports something the
 * base source does not have yet, and that is an error, never a red run:
 * scoring it as red would let a broken import pass as proof.
 */
function compareRedRun(redRun: TestRecord[] | null, appeared: TestRecord[] | null): RedResult {
  const findings: Finding[] = [];
  const unmeasured: Unmeasured[] = [];
  const redAtBase: TestRecord[] = [];
  if (appeared === null || appeared.length === 0) return { findings, unmeasured, redAtBase };
  if (redRun === null) {
    unmeasured.push({
      kind: "red-run-not-comparable",
      file: "",
      name: "",
      detail: `${appeared.length} test(s) added by this change were never run against the base source, so none of them is shown to have been red before the change`,
    });
    return { findings, unmeasured, redAtBase };
  }
  const redByKey = byKey(redRun);
  for (const test of appeared) {
    const atBase = redByKey.get(testKey(test));
    if (atBase === undefined) {
      unmeasured.push({
        kind: "errored-at-base",
        file: test.file,
        name: test.name,
        detail: `${describe(test)} did not run at all against the base source, usually because it imports something the base does not have yet; that is an error, not a red run, and it proves nothing`,
      });
      continue;
    }
    if (atBase.outcome === "skip") {
      unmeasured.push({
        kind: "skipped-at-base",
        file: test.file,
        name: test.name,
        detail: `${describe(test)} was skipped against the base source, so it never ran and proves nothing`,
      });
      continue;
    }
    if (atBase.outcome === "pass") {
      findings.push({
        kind: "not-red-before-green",
        file: test.file,
        name: test.name,
        detail: `${describe(test)} passes against the base source, so it would have passed without this change and demonstrates nothing about it`,
      });
      continue;
    }
    redAtBase.push(test);
  }
  return { findings, unmeasured, redAtBase };
}

// --- two runs of the same comparison ------------------------------------------

/**
 * The identity of one finding: what it says, about which test. Two runs of
 * the same suite produce the same id for the same problem, which is what
 * makes them comparable at all.
 */
export function findingId(item: Finding): string {
  return `${item.kind}\n${item.file}\n${item.name}`;
}

/** The finding and unmeasured kinds the red-before-green half produces, and
 * so the ones a second run of that half can disagree about. */
export const RED_FINDING_KINDS: ReadonlySet<string> = new Set(["not-red-before-green"]);
export const RED_UNMEASURED_KINDS: ReadonlySet<string> = new Set(["errored-at-base", "skipped-at-base"]);

/**
 * The rule both merges below follow, and the reason for it.
 *
 * A result the two runs agree about stands as it stands. A result they
 * disagree about, in either direction, did not settle: this run watched the
 * same question answered two ways and has no answer of its own. That is an
 * unmeasured item, never a finding, because the problem was not established,
 * and never dropped, because its absence was not established either.
 *
 * The earlier rule let the second run clear a first-run problem by seeing the
 * test red against the base itself, and dropped the disagreement as flaky.
 * That reads a result nobody could measure as a result that is fine, which is
 * the same mistake as reading a suite that ran no tests as a suite that
 * passed: the example this whole repository opens with.
 */
function didNotSettle(file: string, name: string, detail: string): Unmeasured {
  return { kind: "did-not-settle", file, name, detail };
}

export interface SettledFindings {
  /** The findings both runs reported. */
  findings: Finding[];
  /** One item per finding only one of the two runs reported. */
  unsettled: Unmeasured[];
}

/**
 * The census half over two runs: a test that stopped running, a dropped
 * count, a flipped outcome. A finding both runs report is a finding. A
 * finding one run reports and the other does not did not settle, whichever
 * run reported it: a problem found only on the second run is no better
 * established than one found only on the first.
 */
export function mergeCensusFindings(first: Finding[], second: Finding[]): SettledFindings {
  const secondById = new Map(second.map((finding) => [findingId(finding), finding]));
  const firstIds = new Set(first.map(findingId));
  const findings: Finding[] = [];
  const unsettled: Unmeasured[] = [];
  for (const finding of first) {
    if (secondById.has(findingId(finding))) findings.push(finding);
    else unsettled.push(didNotSettle(finding.file, finding.name, onlyOneRunSaid(finding)));
  }
  for (const finding of second) {
    if (!firstIds.has(findingId(finding))) {
      unsettled.push(didNotSettle(finding.file, finding.name, onlyOneRunSaid(finding)));
    }
  }
  return { findings, unsettled };
}

function onlyOneRunSaid(finding: Finding): string {
  return (
    `one of the two runs reported that ${finding.detail}, and the other did not, so this result did not settle ` +
    "between the two runs and nothing here measures it"
  );
}

interface RedVerdict {
  /** How the two runs are compared: same tag, same result. */
  tag: string;
  /** How the report says it, in English. */
  said: string;
  finding: Finding | null;
  unmeasured: Unmeasured | null;
}

const RED_VERDICT_WORDS: Record<string, string> = {
  "not-red-before-green": "passing against the base source",
  "errored-at-base": "unable to run against the base source at all",
  "skipped-at-base": "skipped against the base source",
  red: "failing against the base source",
};

function redVerdicts(result: CompareResult): Map<string, RedVerdict> {
  const verdicts = new Map<string, RedVerdict>();
  for (const finding of result.findings) {
    if (!RED_FINDING_KINDS.has(finding.kind)) continue;
    verdicts.set(testKey(finding), {
      tag: finding.kind,
      said: RED_VERDICT_WORDS[finding.kind] ?? finding.kind,
      finding,
      unmeasured: null,
    });
  }
  for (const item of result.unmeasured) {
    if (!RED_UNMEASURED_KINDS.has(item.kind)) continue;
    verdicts.set(testKey(item), {
      tag: item.kind,
      said: RED_VERDICT_WORDS[item.kind] ?? item.kind,
      finding: null,
      unmeasured: item,
    });
  }
  for (const test of result.redAtBase) {
    verdicts.set(testKey(test), { tag: "red", said: RED_VERDICT_WORDS.red, finding: null, unmeasured: null });
  }
  return verdicts;
}

export interface MergedRed {
  result: CompareResult;
  /** How many tests the two runs disagreed about. */
  unsettled: number;
}

/**
 * The red-before-green half over two runs, one added test at a time. The two
 * comparisons are given the same base and HEAD censuses and differ only in
 * the run against the base source, so both hold the same list of added tests.
 *
 * A test both runs call red is red. A test both runs call the same problem
 * keeps that problem. A test the two runs call anything else did not settle,
 * in either direction: a run that saw it pass against the base and a run that
 * saw it fail there cannot both be right, and taking the kinder of the two is
 * how a run launders a disagreement into a clean bill.
 */
export function mergeRedHalves(first: CompareResult, second: CompareResult): MergedRed {
  const before = redVerdicts(first);
  const after = redVerdicts(second);
  const keptFindings: Finding[] = [];
  const keptUnmeasured: Unmeasured[] = [];
  const redAtBase: TestRecord[] = [];
  let unsettled = 0;

  const asRed: RedVerdict = { tag: "red", said: RED_VERDICT_WORDS.red, finding: null, unmeasured: null };
  for (const test of first.appeared) {
    const key = testKey(test);
    const firstVerdict = before.get(key) ?? asRed;
    const secondVerdict = after.get(key) ?? asRed;
    if (firstVerdict.tag !== secondVerdict.tag) {
      unsettled++;
      keptUnmeasured.push(
        didNotSettle(
          test.file,
          test.name,
          `${describe(test)} was ${firstVerdict.said} on the first run and ${secondVerdict.said} on the second, ` +
            "so this result did not settle between the two runs and nothing here measures it",
        ),
      );
      continue;
    }
    if (firstVerdict.finding !== null) keptFindings.push(firstVerdict.finding);
    else if (firstVerdict.unmeasured !== null) keptUnmeasured.push(firstVerdict.unmeasured);
    else redAtBase.push(test);
  }

  const otherFindings = first.findings.filter((finding) => !RED_FINDING_KINDS.has(finding.kind));
  const otherUnmeasured = first.unmeasured.filter((item) => !RED_UNMEASURED_KINDS.has(item.kind));
  return {
    result: {
      ...first,
      findings: [...otherFindings, ...keptFindings],
      unmeasured: [...otherUnmeasured, ...keptUnmeasured],
      redAtBase,
    },
    unsettled,
  };
}

/**
 * Exit code for a finished comparison:
 *   0  nothing found and everything was measured
 *   1  at least one finding
 *   3  nothing found, but part of the run was unmeasured
 * A finding wins over an unmeasured part, the same way it does in
 * `adg mutate`. Exit 3 exists so a run that could not measure part of its
 * own work never reads the same as a run that measured all of it and found
 * nothing; folding that into 0 is the failure this whole project is about.
 */
export function exitCodeFor(result: { findings: Finding[]; unmeasured: Unmeasured[] }): 0 | 1 | 3 {
  if (result.findings.length > 0) return 1;
  if (result.unmeasured.length > 0) return 3;
  return 0;
}

// --- reporting ----------------------------------------------------------------

export interface ReportInput {
  command: string;
  baseRef: string;
  baseReason: string;
  headFormat: ResultFormat;
  baseFormat: ResultFormat | null;
  changedTestFiles: string[];
  result: CompareResult;
  /** How many results the two runs disagreed about. Each one is in
   * `result.unmeasured` as a did-not-settle item: nothing is dropped, so
   * there is no count of dropped things to report. */
  unsettled: number;
  /** How many times the whole suite ran, including any re-run. */
  runs: number;
  notes: string[];
}

const FINDING_TITLES: Record<FindingKind, string> = {
  disappeared: "a test stopped running",
  "count-dropped": "the suite runs fewer tests than it did",
  "not-red-before-green": "a test added by this change passes without it",
  flipped: "a test changed outcome",
};

export function formatReportText(input: ReportInput): string {
  const { result } = input;
  const lines: string[] = [];
  lines.push(`Command: ${input.command}`);
  lines.push(`Base: ${input.baseRef} (${input.baseReason})`);
  const formatNote =
    input.baseFormat !== null && input.baseFormat !== input.headFormat
      ? ` at HEAD, ${input.baseFormat} at the base`
      : "";
  lines.push(`Result format: ${input.headFormat}${formatNote}`);
  lines.push(
    `Tests: ${result.baseCount === null ? "base not comparable" : `${result.baseCount} at the base`}, ${result.headCount} at HEAD`,
  );
  lines.push(
    `Test files this change touched: ${input.changedTestFiles.length === 0 ? "(none)" : input.changedTestFiles.join(", ")}`,
  );
  lines.push(`Suite runs: ${input.runs}`);
  lines.push("");
  lines.push(
    `${result.findings.length} finding(s), ${result.unmeasured.length} unmeasured, ${result.appeared.length} test(s) added, ${result.redAtBase.length} of those red against the base source`,
  );

  if (input.unsettled > 0) {
    lines.push("");
    lines.push(
      `${input.unsettled} result(s) did not settle between the two runs and are listed below as unmeasured. A run ` +
        "that answered the same question two ways established neither the problem nor its absence, so none of " +
        "these is reported as a finding and none of them is dropped.",
    );
  }

  if (result.findings.length > 0) {
    lines.push("");
    lines.push(`Findings (${result.findings.length}):`);
    for (const finding of result.findings) {
      lines.push(`  ${finding.kind}: ${FINDING_TITLES[finding.kind]}`);
      lines.push(`    ${finding.detail}`);
    }
  }

  if (result.unmeasured.length > 0) {
    lines.push("");
    lines.push(`Not measured (${result.unmeasured.length}):`);
    for (const item of result.unmeasured) {
      lines.push(`  ${item.kind}`);
      lines.push(`    ${item.detail}`);
    }
  }

  if (result.redAtBase.length > 0) {
    lines.push("");
    lines.push(`Red before green (${result.redAtBase.length}):`);
    for (const test of result.redAtBase) {
      lines.push(`  ${describe(test)} fails against the base source and passes at HEAD`);
    }
  }

  for (const note of input.notes) {
    lines.push("");
    lines.push(note);
  }

  lines.push("");
  if (result.findings.length > 0) {
    lines.push("A finding here means the suite is claiming more than it measured.");
  } else if (result.unmeasured.length > 0) {
    lines.push("Nothing was found, but part of this run was never measured (exit 3), so it is not a clean result.");
  } else if (result.appeared.length === 0) {
    lines.push("No test disappeared and the count held. This change added no test, so none was run against the base source.");
  } else if (result.redAtBase.length === result.appeared.length) {
    lines.push("No test disappeared, the count held, and every test this change added was red against the base source.");
  } else {
    lines.push(
      `No test disappeared and the count held. ${result.redAtBase.length} of the ${result.appeared.length} test(s) this change added ` +
        "were red against the base source; the rest were not shown to have been red before it.",
    );
  }
  return lines.join("\n");
}

export function formatReportJson(input: ReportInput): string {
  return `${JSON.stringify(
    {
      command: input.command,
      base: { ref: input.baseRef, reason: input.baseReason },
      formats: { head: input.headFormat, base: input.baseFormat },
      counts: {
        base: input.result.baseCount,
        head: input.result.headCount,
        appeared: input.result.appeared.length,
        redAtBase: input.result.redAtBase.length,
      },
      changedTestFiles: input.changedTestFiles,
      runs: input.runs,
      unsettled: input.unsettled,
      findings: input.result.findings,
      unmeasured: input.result.unmeasured,
      redAtBase: input.result.redAtBase,
      notes: input.notes,
    },
    null,
    2,
  )}\n`;
}
