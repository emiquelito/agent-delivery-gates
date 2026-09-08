// Pure core for the gate tally: parses docs/gate-tally.md's table into
// entries and produces a summary and a list of problems. No file reading, no
// process exit, no I/O. Anything this needs from the filesystem, such as
// which rule ids exist or whether a referenced path exists, is passed in by
// the caller.

export interface TallyEntry {
  /** 1-based row number as written in the "#" column. */
  number: number;
  /** The date column, as written, unparsed. */
  date: string;
  /** The rule id column, as written. */
  rule: string;
  /** The "where to see it" column, as written. */
  where: string;
  /** The "what it caught" column, as written. */
  caught: string;
  /** 1-based line number in the source text this row came from. */
  line: number;
}

export interface TallyProblem {
  /** 1-based line number in the source text the problem was found at. */
  line: number;
  message: string;
}

export interface TallySummary {
  total: number;
  /** Per-rule counts, every known rule included, zero counts and all,
   * sorted highest count first, then by rule id. */
  perRule: { rule: string; count: number }[];
  /** Earliest date column value, by plain string comparison. Undefined when
   * there are no entries. */
  earliestDate: string | undefined;
  /** Latest date column value, by plain string comparison. Undefined when
   * there are no entries. */
  latestDate: string | undefined;
  /** Count of entries whose "where to see it" column says there is no test
   * to point at. */
  noTestCount: number;
}

export interface TallyResult {
  entries: TallyEntry[];
  summary: TallySummary;
  problems: TallyProblem[];
}

export interface ParseOptions {
  /** The full set of valid rule ids. A rule column value outside this set is
   * reported as a problem. */
  ruleIds: Set<string>;
  /**
   * True when the given path, resolved however the caller resolves it,
   * exists. Used to check a "where to see it" column that names a path.
   * Injected so this core stays free of filesystem access.
   */
  pathExists: (path: string) => boolean;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// A "where to see it" cell that explicitly says there is no test, rather
// than naming one. "no test" and "no single test" both appear in the real
// file, so this matches either phrasing without over-matching a cell that
// merely mentions "test" in passing.
const NO_TEST_RE = /\bno\b[^`]*\btest\b/i;

/** True when the cell reads as prose pointing at "this file" instead of
 * naming a path or a command. Nothing to check for existence in that case. */
function isNonPathReference(cell: string): boolean {
  const trimmed = cell.trim();
  return (
    NO_TEST_RE.test(trimmed) ||
    /^this file$/i.test(trimmed) ||
    /^the rule itself is/i.test(trimmed)
  );
}

/**
 * Pulls a path out of a "where to see it" cell, when the cell names one.
 * Paths in this file are written inside backticks, for example
 * `` `tests/scan-prose.test.ts` `` or `` `rules/cross-cutting-audit.json` ``.
 * Returns undefined when the cell carries no backticked path, which is not
 * itself a problem: prose such as "no test; recorded here only" is valid
 * and names nothing to check.
 */
function extractPath(cell: string): string | undefined {
  const match = /`([^`]+)`/.exec(cell);
  if (!match) return undefined;
  const candidate = match[1].trim();
  // A bare word or phrase in backticks that does not look like a path, such
  // as a command name, is left alone: only something with a path separator
  // or a file extension reads as a path reference.
  if (!/[./]/.test(candidate)) return undefined;
  return candidate;
}

/** Splits one markdown table row into its cell texts, trimmed. Leading and
 * trailing pipes are optional and ignored. */
function splitRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|")) body = body.slice(0, -1);
  return body.split("|").map((cell) => cell.trim());
}

/** True when the row is a markdown table separator row, for example
 * `|---|------|------|------|----------------|`. */
function isSeparatorRow(line: string): boolean {
  return /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line);
}

const HEADING_CELL_RE = /^#\s*$/;

/** Finds the header row: the first row whose first cell is exactly "#",
 * followed immediately by a separator row. Returns its line index (0-based
 * into `lines`), or -1 when no such row exists. */
function findHeaderIndex(lines: string[]): number {
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    if (!line.includes("|")) continue;
    const cells = splitRow(line);
    if (cells.length > 0 && HEADING_CELL_RE.test(cells[0]) && isSeparatorRow(lines[i + 1])) {
      return i;
    }
  }
  return -1;
}

/** Splits text into lines, 1-based numbering preserved by array index + 1.
 * Handles CRLF and a file with no trailing newline. */
function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

const EXPECTED_COLUMNS = 5;

/**
 * Parses the gate tally's markdown table and returns its entries, a summary,
 * and any problems found. Prose above or below the table is ignored; only
 * the table itself, found by its header and separator row, is read.
 */
export function parseTally(text: string, options: ParseOptions): TallyResult {
  const lines = splitLines(text);
  const problems: TallyProblem[] = [];
  const headerIndex = findHeaderIndex(lines);

  if (headerIndex === -1) {
    return {
      entries: [],
      summary: {
        total: 0,
        perRule: [],
        earliestDate: undefined,
        latestDate: undefined,
        noTestCount: 0,
      },
      problems: [{ line: 1, message: "no table found: no header row followed by a separator row" }],
    };
  }

  const entries: TallyEntry[] = [];
  const seenNumbers = new Set<number>();

  for (let i = headerIndex + 2; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    if (line.trim() === "") continue;
    if (!line.trim().startsWith("|")) continue; // prose after the table

    const cells = splitRow(line);
    if (cells.length !== EXPECTED_COLUMNS) {
      problems.push({
        line: lineNo,
        message: `row has ${cells.length} column(s), expected ${EXPECTED_COLUMNS}`,
      });
      continue;
    }

    const [numberCell, date, rule, where, caught] = cells;
    const number = Number(numberCell);
    if (!/^\d+$/.test(numberCell) || !Number.isFinite(number)) {
      problems.push({ line: lineNo, message: `entry number '${numberCell}' is not a whole number` });
    } else {
      if (seenNumbers.has(number)) {
        problems.push({ line: lineNo, message: `entry number ${number} is a duplicate` });
      }
      seenNumbers.add(number);
    }

    if (!DATE_RE.test(date)) {
      problems.push({ line: lineNo, message: `date '${date}' is not in year-month-day form` });
    }

    if (!options.ruleIds.has(rule)) {
      problems.push({ line: lineNo, message: `rule id '${rule}' is not a known rule` });
    }

    const referencedPath = extractPath(where);
    if (!isNonPathReference(where) && referencedPath !== undefined) {
      if (!options.pathExists(referencedPath)) {
        problems.push({ line: lineNo, message: `referenced path '${referencedPath}' does not exist` });
      }
    }

    if (caught === "") {
      problems.push({ line: lineNo, message: `"what it caught" cell is empty` });
    }

    entries.push({
      number: Number.isFinite(number) ? number : NaN,
      date,
      rule,
      where,
      caught,
      line: lineNo,
    });
  }

  if (entries.length === 0) {
  // An empty table is a valid starting state: a project that has adopted the
  // gates and has not had one reject anything yet. Only a file with no table
  // at all is an error, and that is handled where the table is located.
  } else {
    // Gap-free sequence starting at one, checked over well-formed numbers
    // only: a malformed number already produced its own problem above.
    const numbers = entries.map((e) => e.number).filter((n) => Number.isFinite(n));
    const sorted = [...new Set(numbers)].sort((a, b) => a - b);
    if (sorted.length > 0 && (sorted[0] !== 1 || sorted[sorted.length - 1] !== sorted.length)) {
      problems.push({
        line: entries[entries.length - 1].line,
        message: `entry numbers are not a gap-free sequence starting at 1 (got ${sorted.join(", ")})`,
      });
    }
  }

  const summary = summarize(entries, options.ruleIds);
  return { entries, summary, problems };
}

function summarize(entries: TallyEntry[], knownRuleIds: Set<string>): TallySummary {
  const counts = new Map<string, number>();
  let noTestCount = 0;
  let earliestDate: string | undefined;
  let latestDate: string | undefined;

  for (const entry of entries) {
    counts.set(entry.rule, (counts.get(entry.rule) ?? 0) + 1);
    if (isNonPathReference(entry.where) && NO_TEST_RE.test(entry.where)) {
      noTestCount++;
    }
    if (DATE_RE.test(entry.date)) {
      if (earliestDate === undefined || entry.date < earliestDate) earliestDate = entry.date;
      if (latestDate === undefined || entry.date > latestDate) latestDate = entry.date;
    }
  }

  // Every known rule appears, including the ones with no entries. A rule that
  // has never caught anything is the more useful number here: it says the gate
  // has not fired, which is either good news or a sign nothing is checking it.
  for (const rule of knownRuleIds) {
    if (!counts.has(rule)) counts.set(rule, 0);
  }

  const perRule = [...counts.entries()]
    .map(([rule, count]) => ({ rule, count }))
    .sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule));

  return {
    total: entries.length,
    perRule,
    earliestDate,
    latestDate,
    noTestCount,
  };
}
