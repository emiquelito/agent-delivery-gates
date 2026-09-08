// Tests for src/report-validator.ts, the pure core. Every test asserts an
// observable outcome from validateReport: which rule fired (or did not),
// and at which line. Never an internal value.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePriorFindingIds, validateReport, type Finding } from "../src/report-validator.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PASSING_FIXTURE_PATH = join(HERE, "fixtures", "passing-report.md");

function readFixture(): string {
  return readFileSync(PASSING_FIXTURE_PATH, "utf8");
}

function rulesFired(findings: Finding[]): string[] {
  return findings.map((f) => f.rule);
}

// --- The realistic fixture, whole and mutated -------------------------------

test("a full realistic report with every check satisfied passes with no findings", () => {
  const findings = validateReport(readFixture());
  assert.deepEqual(findings, []);
});

test("fixture mutation: both robustness claims lose their evidence, R1 fires for each", () => {
  const lines = readFixture().split("\n");
  lines[5] = ""; // line 6: the first Evidence: line
  lines[8] = ""; // line 9: the second Evidence: line
  const findings = validateReport(lines.join("\n"));
  assert.deepEqual(rulesFired(findings), ["unproven-robustness-claim", "unproven-robustness-claim"]);
  assert.deepEqual(
    findings.map((f) => f.line),
    [5, 8],
  );
});

test("fixture mutation: the evidence line becomes a context reference, R2 fires", () => {
  const lines = readFixture().split("\n");
  lines[5] = "Evidence: as shown above the retry succeeded.";
  const findings = validateReport(lines.join("\n"));
  assert.deepEqual(rulesFired(findings), ["evidence-not-durable"]);
  assert.equal(findings[0].line, 6);
});

test("fixture mutation: the Low and Info entries are dropped with no statement, R3 fires", () => {
  const lines = readFixture().split("\n");
  lines[14] = ""; // the Low entry
  lines[15] = ""; // the Info entry
  const findings = validateReport(lines.join("\n"));
  assert.deepEqual(rulesFired(findings), ["finding-list-incomplete"]);
  assert.equal(findings[0].line, 11); // the "## Findings" heading line
});

test("fixture mutation: the commit line loses its clean-tree wording, R4 fires", () => {
  const lines = readFixture().split("\n");
  lines[19] = "Committed at a1b2c3d9.";
  const findings = validateReport(lines.join("\n"));
  assert.deepEqual(rulesFired(findings), ["missing-commit-line"]);
});

test("fixture mutation: a prior finding id is dropped, R5 fires", () => {
  const findings = validateReport(readFixture(), { priorFindingIds: ["F1", "F99"] });
  assert.deepEqual(rulesFired(findings), ["open-finding-not-carried"]);
  assert.match(findings[0].message, /F99/);
});

test("fixture with a prior finding id that is carried forward: R5 does not fire", () => {
  const findings = validateReport(readFixture(), { priorFindingIds: ["F1", "F2"] });
  assert.deepEqual(findings, []);
});

test("no --prior means R5 never fires, even with dropped-looking text", () => {
  const findings = validateReport(readFixture());
  assert.deepEqual(
    findings.filter((f) => f.rule === "open-finding-not-carried"),
    [],
  );
});

// --- R1: unproven-robustness-claim ------------------------------------------

test("R1 fires: a robustness verb with no evidence reference anywhere nearby", () => {
  const text = "# R\n\nThe retry was validated.\n\n## Findings\n- Low: x\n\nCommitted a1b2c3d, tree is clean.\n";
  const findings = validateReport(text);
  assert.ok(findings.some((f) => f.rule === "unproven-robustness-claim" && f.line === 3));
});

test("R1 satisfied: evidence on the same line as the claim", () => {
  const text =
    "# R\n\nEvidence: commit a1b2c3d shows the retry was validated.\n\n## Findings\n- Low: x\n\nCommitted a1b2c3d, tree is clean.\n";
  const findings = validateReport(text);
  assert.deepEqual(
    findings.filter((f) => f.rule === "unproven-robustness-claim"),
    [],
  );
});

test("R1 satisfied: evidence within the following three non-blank lines", () => {
  const text = [
    "# R",
    "",
    "The retry was validated.",
    "This line is filler.",
    "This one too.",
    "Evidence: commit a1b2c3d.",
    "",
    "## Findings",
    "- Low: x",
    "",
    "Committed a1b2c3d, tree is clean.",
  ].join("\n");
  const findings = validateReport(text);
  assert.deepEqual(
    findings.filter((f) => f.rule === "unproven-robustness-claim"),
    [],
  );
});

test("R1 does not fire for the same claim if the evidence falls outside the three-line window", () => {
  const text = [
    "# R",
    "",
    "The retry was validated.",
    "filler one",
    "filler two",
    "filler three",
    "Evidence: commit a1b2c3d.",
    "",
    "## Findings",
    "- Low: x",
    "",
    "Committed a1b2c3d, tree is clean.",
  ].join("\n");
  const findings = validateReport(text);
  assert.ok(findings.some((f) => f.rule === "unproven-robustness-claim" && f.line === 3));
});

test("R1 does not fire for a robustness verb inside a fenced code block", () => {
  const text = [
    "# R",
    "```",
    "this sample code handled the error internally",
    "```",
    "",
    "## Findings",
    "- Low: x",
    "",
    "Committed a1b2c3d, tree is clean.",
  ].join("\n");
  const findings = validateReport(text);
  assert.deepEqual(
    findings.filter((f) => f.rule === "unproven-robustness-claim"),
    [],
  );
});

test("an unclosed fence swallows the rest of the document, verbs inside never fire R1", () => {
  const text = [
    "# R",
    "```",
    "handled inside an unclosed fence",
    "The retry was validated with no evidence nearby.",
    "## Findings",
    "- Low: x",
    "Committed a1b2c3d, tree is clean.",
  ].join("\n");
  const findings = validateReport(text);
  assert.deepEqual(
    findings.filter((f) => f.rule === "unproven-robustness-claim"),
    [],
  );
  // Everything after the unclosed fence is gone, including the findings
  // section and the commit line, so both of those rules fire instead.
  assert.ok(findings.some((f) => f.rule === "finding-list-incomplete"));
  assert.ok(findings.some((f) => f.rule === "missing-commit-line"));
});

test("line numbers stay correct for a claim that appears after a fenced block", () => {
  const text = [
    "# R", // 1
    "```", // 2
    "ignored code handled", // 3
    "```", // 4
    "The retry was validated with no evidence nearby.", // 5
    "", // 6
    "", // 7
    "", // 8
    "## Findings", // 9
    "- Low: x", // 10
    "", // 11
    "Committed a1b2c3d, tree is clean.", // 12
  ].join("\n");
  const findings = validateReport(text);
  const r1 = findings.filter((f) => f.rule === "unproven-robustness-claim");
  assert.equal(r1.length, 1);
  assert.equal(r1[0].line, 5);
});

test("a robustness verb inside an HTML comment does not fire R1", () => {
  const text = [
    "# R",
    "<!-- The retry was validated with no evidence. -->",
    "",
    "## Findings",
    "- Low: x",
    "",
    "Committed a1b2c3d, tree is clean.",
  ].join("\n");
  const findings = validateReport(text);
  assert.deepEqual(
    findings.filter((f) => f.rule === "unproven-robustness-claim"),
    [],
  );
});

test("a robustness verb inside a multi-line HTML comment does not fire R1", () => {
  const text = [
    "# R",
    "<!--",
    "The retry was validated with no evidence.",
    "-->",
    "",
    "## Findings",
    "- Low: x",
    "",
    "Committed a1b2c3d, tree is clean.",
  ].join("\n");
  const findings = validateReport(text);
  assert.deepEqual(
    findings.filter((f) => f.rule === "unproven-robustness-claim"),
    [],
  );
});

// --- R2: evidence-not-durable ------------------------------------------------

const NON_DURABLE_PHRASES = [
  "as shown earlier",
  "as shown above",
  "see above",
  "as noted earlier",
  "per my previous message",
  "discussed earlier",
  "as described above",
  "from the run above",
];

for (const phrase of NON_DURABLE_PHRASES) {
  test(`R2 fires: evidence pointing only at "${phrase}"`, () => {
    const text = `# R\n\nThe retry was validated.\nEvidence: ${phrase}.\n\n## Findings\n- Low: x\n\nCommitted a1b2c3d, tree is clean.\n`;
    const findings = validateReport(text);
    assert.ok(findings.some((f) => f.rule === "evidence-not-durable" && f.line === 4));
  });
}

test("R2 satisfied: evidence naming a git hash", () => {
  const text = "# R\n\nThe retry was validated.\nEvidence: see commit a1b2c3d for the fix.\n\n## Findings\n- Low: x\n\nCommitted a1b2c3d, tree is clean.\n";
  const findings = validateReport(text);
  assert.deepEqual(
    findings.filter((f) => f.rule === "evidence-not-durable"),
    [],
  );
});

test("R2 satisfied: evidence naming a repo file path", () => {
  const text =
    "# R\n\nThe retry was validated.\nEvidence: see src/report-validator.ts for the fix.\n\n## Findings\n- Low: x\n\nCommitted a1b2c3d, tree is clean.\n";
  const findings = validateReport(text);
  assert.deepEqual(
    findings.filter((f) => f.rule === "evidence-not-durable"),
    [],
  );
});

test("R2 satisfied: evidence naming a test command in backticks", () => {
  const text =
    "# R\n\nThe retry was validated.\nEvidence: ran `npm test` and it passed.\n\n## Findings\n- Low: x\n\nCommitted a1b2c3d, tree is clean.\n";
  const findings = validateReport(text);
  assert.deepEqual(
    findings.filter((f) => f.rule === "evidence-not-durable"),
    [],
  );
});

test("R2 does not scan an evidence-labeled line inside a fenced code block", () => {
  const text = [
    "# R",
    "```",
    "Evidence: as shown above",
    "```",
    "",
    "## Findings",
    "- Low: x",
    "",
    "Committed a1b2c3d, tree is clean.",
  ].join("\n");
  const findings = validateReport(text);
  assert.deepEqual(
    findings.filter((f) => f.rule === "evidence-not-durable"),
    [],
  );
});

// --- R3: finding-list-incomplete --------------------------------------------

test("R3 fires: a findings section with only High and Critical entries", () => {
  const text = [
    "# R",
    "",
    "## Findings",
    "- F1 (Critical): a real bug",
    "- F2 (High): another real bug",
    "",
    "Committed a1b2c3d, tree is clean.",
  ].join("\n");
  const findings = validateReport(text);
  assert.ok(findings.some((f) => f.rule === "finding-list-incomplete"));
});

test("R3 fires: no findings section at all", () => {
  const text = "# R\n\nEverything looks fine.\n\nCommitted a1b2c3d, tree is clean.\n";
  const findings = validateReport(text);
  assert.ok(findings.some((f) => f.rule === "finding-list-incomplete" && f.line === 1));
});

test("R3 satisfied: at least one Low or Info entry is present", () => {
  const text = [
    "# R",
    "",
    "## Findings",
    "- F1 (Critical): a real bug",
    "- F2 (Low): a cosmetic issue",
    "",
    "Committed a1b2c3d, tree is clean.",
  ].join("\n");
  const findings = validateReport(text);
  assert.deepEqual(
    findings.filter((f) => f.rule === "finding-list-incomplete"),
    [],
  );
});

test("R3 satisfied: an explicit statement that there were no Low or Info findings", () => {
  const text = [
    "# R",
    "",
    "## Findings",
    "- F1 (Critical): a real bug",
    "",
    "There were no Low or Info findings.",
    "",
    "Committed a1b2c3d, tree is clean.",
  ].join("\n");
  const findings = validateReport(text);
  assert.deepEqual(
    findings.filter((f) => f.rule === "finding-list-incomplete"),
    [],
  );
});

test("R3 satisfied: the no-Low-and-no-Info phrasing variant", () => {
  const text = [
    "# R",
    "",
    "## Findings",
    "- F1 (Critical): a real bug",
    "",
    "No Low findings and no Info findings.",
    "",
    "Committed a1b2c3d, tree is clean.",
  ].join("\n");
  const findings = validateReport(text);
  assert.deepEqual(
    findings.filter((f) => f.rule === "finding-list-incomplete"),
    [],
  );
});

// --- R4: missing-commit-line -------------------------------------------------

test("R4 fires: no line anywhere carries both a hash and clean-tree wording", () => {
  const text = "# R\n\n## Findings\n- Low: x\n\nDone.\n";
  const findings = validateReport(text);
  assert.ok(findings.some((f) => f.rule === "missing-commit-line"));
});

test("R4 satisfied: the hash and the clean-tree wording share one line", () => {
  const text = "# R\n\n## Findings\n- Low: x\n\nCommitted at a1b2c3d, the working tree is clean.\n";
  const findings = validateReport(text);
  assert.deepEqual(
    findings.filter((f) => f.rule === "missing-commit-line"),
    [],
  );
});

test("R4 satisfied: the hash and the clean-tree wording sit on consecutive lines", () => {
  const text = "# R\n\n## Findings\n- Low: x\n\nCommit: a1b2c3d\nThe working tree is clean.\n";
  const findings = validateReport(text);
  assert.deepEqual(
    findings.filter((f) => f.rule === "missing-commit-line"),
    [],
  );
});

// --- R5: open-finding-not-carried --------------------------------------------

test("R5 fires only for the ids missing from the report text", () => {
  const text = "# R\n\nDiscusses F1 and F2.\n\n## Findings\n- Low: x\n\nCommitted a1b2c3d, tree is clean.\n";
  const findings = validateReport(text, { priorFindingIds: ["F1", "F2", "F3"] });
  const r5 = findings.filter((f) => f.rule === "open-finding-not-carried");
  assert.equal(r5.length, 1);
  assert.match(r5[0].message, /F3/);
});

// --- parsePriorFindingIds ------------------------------------------------------

test("parsePriorFindingIds ignores blank lines and comment lines", () => {
  const ids = parsePriorFindingIds("F1\n\n# a comment\nF2\n   \n#F3\n");
  assert.deepEqual(ids, ["F1", "F2"]);
});

// An evidence reference is written mid-sentence at least as often as it opens
// a line. Requiring it at the start rejected the most ordinary phrasing.
test("R1 is satisfied by an evidence reference later in the claim line", () => {
  const report = [
    "# Report",
    "",
    "Retry handled. Evidence: commit a1b2c3d4 and tests/retry.test.ts.",
    "",
    "## Findings",
    "",
    "No Low or Info findings.",
    "",
    "Committed as a1b2c3d4; tree clean.",
  ].join("\n");
  assert.deepEqual(rulesFired(validateReport(report)), []);
});

// A claim line with no evidence anywhere on it still fires, so the widened
// match did not turn R1 off.
test("R1 still fires when the claim line carries no evidence at all", () => {
  const report = [
    "# Report",
    "",
    "Retry handled and the queue recovered.",
    "",
    "## Findings",
    "",
    "No Low or Info findings.",
    "",
    "Committed as a1b2c3d4; tree clean.",
  ].join("\n");
  assert.deepEqual(rulesFired(validateReport(report)), ["unproven-robustness-claim"]);
});

// Finding lists in this project are markdown tables, so a severity sits in a
// table cell. Reading only "Low:" or "(Low)" rejected every real report.
test("R3 reads a severity from a markdown table cell", () => {
  const report = [
    "# Report",
    "",
    "## Findings",
    "",
    "| ID | Severity | Finding |",
    "|---|---|---|",
    "| F1 | Critical | fails open |",
    "| F2 | Low | wording |",
    "| F3 | Info | verified correct |",
    "",
    "Committed as a1b2c3d4; tree clean.",
  ].join("\n");
  assert.deepEqual(rulesFired(validateReport(report)), []);
});

// The same table with the Low and Info rows removed must still fail, so the
// table match did not turn R3 into an unconditional pass.
test("R3 still fires on a table carrying only high severities", () => {
  const report = [
    "# Report",
    "",
    "## Findings",
    "",
    "| ID | Severity | Finding |",
    "|---|---|---|",
    "| F1 | Critical | fails open |",
    "| F2 | High | wrong exit code |",
    "",
    "Committed as a1b2c3d4; tree clean.",
  ].join("\n");
  assert.deepEqual(rulesFired(validateReport(report)), ["finding-list-incomplete"]);
});
