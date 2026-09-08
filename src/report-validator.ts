// Pure core for the delivery-report-validator. Takes a delivery report's
// text and returns findings. No file reading, no process exit, no stdin, no
// knowledge of Claude Code, hooks, or any vendor. Every place in this repo
// that needs report checking, a CLI, a Stop hook, a future CI step, calls
// this same function so the rules live in exactly one place.
//
// A delivery report is a markdown document an AI coding agent writes to
// describe what it did. The checks here catch a report claiming more than
// it proved: a robustness claim with no evidence, evidence that will not
// survive the context window that produced it, a findings section that
// quietly dropped its Low and Info entries, a missing commit line, or an
// open finding that went uncarried across a compaction.

export type RuleId =
  | "unproven-robustness-claim"
  | "evidence-not-durable"
  | "finding-list-incomplete"
  | "missing-commit-line"
  | "open-finding-not-carried";

export type Severity = "critical" | "high" | "medium";

export interface Finding {
  rule: RuleId;
  severity: Severity;
  /** 1-based line number the finding anchors to. */
  line: number;
  message: string;
}

export interface ValidateOptions {
  /**
   * Prior open finding ids, one per entry, from a previous report's
   * findings section. When given, R5 fires for every id that does not
   * appear anywhere in the current report text.
   */
  priorFindingIds?: string[];
}

/** Renders one finding as the CLI's text-format line: `RULE severity line: message`. */
export function formatFindingText(finding: Finding): string {
  return `${finding.rule} ${finding.severity} ${finding.line}: ${finding.message}`;
}

// --- Line splitting -------------------------------------------------------

/**
 * Splits report text into lines, 1-based numbering preserved by array index
 * + 1. Handles CRLF, a lone CR, and a file with no trailing newline. A
 * trailing newline produces one trailing empty-string line, same as any
 * other empty line, and carries no finding on its own since nothing matches
 * against an empty string.
 */
function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

// --- HTML comment stripping ------------------------------------------------

/**
 * Removes the parts of a line that fall inside an HTML comment, carrying
 * comment state across lines. Returns the visible text for this line and
 * whether the line ends still inside an open comment.
 */
function stripComment(line: string, inComment: boolean): { text: string; inComment: boolean } {
  let out = "";
  let i = 0;
  let open = inComment;
  while (i < line.length) {
    if (open) {
      const end = line.indexOf("-->", i);
      if (end === -1) {
        i = line.length;
      } else {
        open = false;
        i = end + 3;
      }
    } else {
      const start = line.indexOf("<!--", i);
      if (start === -1) {
        out += line.slice(i);
        i = line.length;
      } else {
        out += line.slice(i, start);
        i = start + 4;
        open = true;
      }
    }
  }
  return { text: out, inComment: open };
}

// --- Fence tracking ---------------------------------------------------------

const FENCE_RE = /^\s*(`{3,}|~{3,})/;

/**
 * Builds two parallel arrays over the input lines: `visible`, the line text
 * with HTML comments stripped and fenced-block content blanked out, and
 * `insideFence`, whether the original line fell inside (or was) a fence
 * marker. R1 and R2 skip fenced content entirely, including a fence opened
 * and never closed, by scanning `visible` where fenced lines read as empty.
 */
function buildVisibleLines(rawLines: string[]): { visible: string[]; insideFence: boolean[] } {
  const visible: string[] = [];
  const insideFence: boolean[] = [];
  let inComment = false;
  let fenceChar: string | null = null;
  for (const raw of rawLines) {
    const stripped = stripComment(raw, inComment);
    inComment = stripped.inComment;
    const text = stripped.text;

    const fenceMatch = FENCE_RE.exec(text);
    if (fenceMatch) {
      const ch = fenceMatch[1][0];
      if (fenceChar === null) {
        fenceChar = ch;
      } else if (ch === fenceChar) {
        fenceChar = null;
      }
      // A fence marker line itself carries no claim or evidence text.
      visible.push("");
      insideFence.push(true);
      continue;
    }

    if (fenceChar !== null) {
      visible.push("");
      insideFence.push(true);
    } else {
      visible.push(text);
      insideFence.push(false);
    }
  }
  return { visible, insideFence };
}

// --- R1: unproven-robustness-claim -----------------------------------------

// Base verbs plus their common conjugations. Word boundaries keep this from
// matching inside a longer word, so "handles" fires but "handlebars" does
// not, and matching is case-insensitive throughout.
const CLAIM_VERB_RE =
  /\b(handles?|handled|handling|isolates?|isolated|isolating|recovers?|recovered|recovering|prevents?|prevented|preventing|rejects?|rejected|rejecting|validates?|validated|validating)\b/i;

// A line starting with "Evidence:", allowing an optional leading list
// marker (-, *, +, or a numbered marker) and optional bold markup around
// the word.
const EVIDENCE_LINE_RE = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:\*\*|__)?\s*evidence\s*:/i;
// On the claim's own line the reference can sit anywhere in the line, because
// "Retry handled. Evidence: commit abc1234" is how people write it.
const EVIDENCE_INLINE_RE = /(?:\*\*|__)?\s*\bevidence\s*:/i;

function findUnprovenRobustnessClaims(visible: string[]): Finding[] {
  const findings: Finding[] = [];
  for (let i = 0; i < visible.length; i++) {
    const text = visible[i];
    if (text.trim() === "" || !CLAIM_VERB_RE.test(text)) continue;

    // Same line: the claim's own line carries an evidence reference, whether
    // it opens the line or follows the claim in the same sentence.
    if (EVIDENCE_INLINE_RE.test(text)) continue;

    // Within the following three non-blank lines.
    let satisfied = false;
    let seen = 0;
    for (let j = i + 1; j < visible.length && seen < 3; j++) {
      const candidate = visible[j];
      if (candidate.trim() === "") continue;
      seen++;
      if (EVIDENCE_LINE_RE.test(candidate)) {
        satisfied = true;
        break;
      }
    }
    if (!satisfied) {
      findings.push({
        rule: "unproven-robustness-claim",
        severity: "critical",
        line: i + 1,
        message:
          "a robustness claim has no evidence reference on this line or within the next three non-blank lines; add an 'Evidence:' reference on this line or just below it, naming what proves it",
      });
    }
  }
  return findings;
}

// --- R2: evidence-not-durable ------------------------------------------------

const HASH_RE = /\b[0-9a-f]{7,40}\b/i;
// A relative path with at least one directory segment and a file
// extension, which is how a path into the repo is written. This is a text
// heuristic, not a filesystem check: the core has no I/O.
const FILE_PATH_RE = /(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z]{1,10}\b/;
const BACKTICK_COMMAND_RE = /`[^`]+`/;

function isDurableEvidence(line: string): boolean {
  return HASH_RE.test(line) || FILE_PATH_RE.test(line) || BACKTICK_COMMAND_RE.test(line);
}

function findNonDurableEvidence(visible: string[]): Finding[] {
  const findings: Finding[] = [];
  for (let i = 0; i < visible.length; i++) {
    const text = visible[i];
    if (!EVIDENCE_LINE_RE.test(text)) continue;
    if (isDurableEvidence(text)) continue;
    findings.push({
      rule: "evidence-not-durable",
      severity: "high",
      line: i + 1,
      message:
        "this evidence reference points only at context, not at anything that outlives it; point at a git hash (7-40 hex characters), a repo file path, or a test command in backticks",
    });
  }
  return findings;
}

// --- R3: finding-list-incomplete --------------------------------------------

const FINDINGS_HEADING_RE = /^(#{1,6})\s.*\bfinding/i;
// A severity token formatted the way a finding entry usually carries it:
// "Low:", "(Low)", "[Info]", "Severity: Low", or a table cell such as
// "| Low |". This avoids matching an
// unrelated sentence such as "see below for more info".
const SEVERITY_ENTRY_RE =
  /\b(low|info)\b\s*[:)\]]|[[(]\s*(low|info)\b|severity\s*:?\s*(low|info)\b|\|\s*(low|info)\b[^|]*\|/i;
// The declaration that no Low or Info findings exist, in either word order,
// within one sentence (not crossing a period).
const NO_LOW_INFO_RE =
  /\bno\b(?:(?!\.).){0,80}\blow\b(?:(?!\.).){0,80}\binfo\b|\bno\b(?:(?!\.).){0,80}\binfo\b(?:(?!\.).){0,80}\blow\b/i;

function findIncompleteFindingList(visible: string[]): Finding[] {
  let headingIndex = -1;
  let headingLevel = 0;
  for (let i = 0; i < visible.length; i++) {
    const match = FINDINGS_HEADING_RE.exec(visible[i]);
    if (match) {
      headingIndex = i;
      headingLevel = match[1].length;
      break;
    }
  }

  if (headingIndex === -1) {
    return [
      {
        rule: "finding-list-incomplete",
        severity: "high",
        line: 1,
        message:
          "no findings section was found; add a heading containing the word 'finding' and list the reviewer's full finding list under it",
      },
    ];
  }

  let sectionEnd = visible.length;
  const nextHeadingRe = /^(#{1,6})\s/;
  for (let i = headingIndex + 1; i < visible.length; i++) {
    const m = nextHeadingRe.exec(visible[i]);
    if (m && m[1].length <= headingLevel) {
      sectionEnd = i;
      break;
    }
  }

  const section = visible.slice(headingIndex + 1, sectionEnd).join("\n");
  if (SEVERITY_ENTRY_RE.test(section) || NO_LOW_INFO_RE.test(section)) {
    return [];
  }

  return [
    {
      rule: "finding-list-incomplete",
      severity: "high",
      line: headingIndex + 1,
      message:
        "the findings section lists no Low or Info entry and never states that there were none; add the missing entries or an explicit statement such as 'no Low or Info findings'",
    },
  ];
}

// --- R4: missing-commit-line -------------------------------------------------

const CLEAN_TREE_RE = /\bclean\b(?:(?!\.).){0,40}\btree\b|\btree\b(?:(?!\.).){0,40}\bclean\b/i;

function findMissingCommitLine(visible: string[]): Finding[] {
  for (let i = 0; i < visible.length; i++) {
    if (!HASH_RE.test(visible[i])) continue;
    if (CLEAN_TREE_RE.test(visible[i])) return [];
    const next = visible[i + 1];
    if (next !== undefined && CLEAN_TREE_RE.test(next)) return [];
  }
  return [
    {
      rule: "missing-commit-line",
      severity: "high",
      line: 1,
      message:
        "no line states a commit hash together with a clean tree; add a line with a 7-40 character hex hash and wording that the tree is clean, on that line or the next",
    },
  ];
}

// --- R5: open-finding-not-carried --------------------------------------------

function findDroppedPriorFindings(reportText: string, priorFindingIds: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const id of priorFindingIds) {
    if (!reportText.includes(id)) {
      findings.push({
        rule: "open-finding-not-carried",
        severity: "medium",
        line: 1,
        message: `prior open finding '${id}' does not appear anywhere in this report; carry it forward or state why it no longer applies`,
      });
    }
  }
  return findings;
}

/** Parses a prior-findings file's text into a list of ids, one per line. */
export function parsePriorFindingIds(text: string): string[] {
  return splitLines(text)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

// --- Entry point --------------------------------------------------------------

/**
 * Validates a delivery report and returns every finding, sorted by line
 * then rule id. An empty or whitespace-only report is the caller's
 * concern, not this function's: this always runs the checks against
 * whatever text it is given and returns what it finds.
 */
export function validateReport(reportText: string, options: ValidateOptions = {}): Finding[] {
  const rawLines = splitLines(reportText);
  const { visible } = buildVisibleLines(rawLines);

  const findings: Finding[] = [
    ...findUnprovenRobustnessClaims(visible),
    ...findNonDurableEvidence(visible),
    ...findIncompleteFindingList(visible),
    ...findMissingCommitLine(visible),
    ...findDroppedPriorFindings(reportText, options.priorFindingIds ?? []),
  ];

  findings.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
  return findings;
}
