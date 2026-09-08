// Tests for the seam between the rule catalog and the code that enforces it.
// An audit found the two sides had no shared vocabulary at all: a record is
// named by its file, a hook emits its own check ids, and nothing connected
// them, so a finding could not be traced back to the rule it came from and a
// record could claim enforcement nothing provided.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const RULES_DIR = join(ROOT, "rules");

interface Record_ {
  id: string;
  enforcement: string;
  emits?: string[];
}

function readRecords(): Record_[] {
  return readdirSync(RULES_DIR)
    .filter((f) => f.endsWith(".json") && f !== "schema.json")
    .map((f) => JSON.parse(readFileSync(join(RULES_DIR, f), "utf8")) as Record_);
}

function idsFromUnion(source: string, typeName: string): string[] {
  const text = readFileSync(join(ROOT, "src", source), "utf8");
  const start = text.indexOf(`export type ${typeName} =`);
  assert.notEqual(start, -1, `${typeName} not found in ${source}`);
  const body = text.slice(start, text.indexOf(";", start));
  return [...body.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
}

function emittedIds(): string[] {
  return [
    ...idsFromUnion("report-validator.ts", "RuleId"),
    ...idsFromUnion("test-diff-separator.ts", "SignalId"),
    ...idsFromUnion("path-allowlist.ts", "CheckId"),
  ];
}

test("every check a hook can emit belongs to exactly one rule record", () => {
  const records = readRecords();
  for (const id of emittedIds()) {
    const owners = records.filter((r) => (r.emits ?? []).includes(id));
    assert.equal(owners.length, 1, `${id} is claimed by ${owners.length} records, expected 1`);
  }
});

test("no record claims a check that no hook can emit", () => {
  const emitted = new Set(emittedIds());
  for (const record of readRecords()) {
    for (const id of record.emits ?? []) {
      assert.ok(emitted.has(id), `${record.id} claims '${id}', which no hook emits`);
    }
  }
});

// A record saying it is enforced by a hook is a claim about this repo. If no
// check carries it, the claim is the kind this catalog exists to reject.
test("a record enforced by a hook names the checks that carry it", () => {
  for (const record of readRecords()) {
    if (record.enforcement !== "hook") continue;
    assert.ok(
      (record.emits ?? []).length > 0,
      `${record.id} declares enforcement by hook but names no check`,
    );
  }
});

// Every entry in the tally has to name a rule that exists, or the measurement
// cannot be read back against the catalog it measures.
test("every rule named in the tally is a real record", () => {
  const ids = new Set(readRecords().map((r) => r.id));
  const tally = readFileSync(join(ROOT, "docs", "gate-tally.md"), "utf8");
  const named = [...tally.matchAll(/^\|\s*\d+\s*\|\s*[\d-]+\s*\|\s*([a-z-]+)\s*\|/gm)].map(
    (m) => m[1],
  );
  assert.ok(named.length > 0, "no tally entries parsed");
  for (const name of named) {
    assert.ok(ids.has(name), `the tally names '${name}', which is not a rule record`);
  }
});

// AGENTS.md is the cross-vendor rendering of the same rules. It drifted
// from the records the first time it was written, describing one rule as
// having no mechanical check while its own record named seven. A document
// describing behavior the code does not have is the defect this project
// exists to catch, and it would be worst in the file that explains it.
function agentsFile(): string {
  return readFileSync(join(ROOT, "AGENTS.md"), "utf8");
}

test("AGENTS.md carries every rule id and invents none", () => {
  const ids = new Set(readRecords().map((r) => r.id));
  const text = agentsFile();
  const headings = [...text.matchAll(/^#+\s+`?([a-z][a-z-]+)`?\s*$/gm)].map((m) => m[1]);
  for (const id of ids) {
    assert.ok(headings.includes(id), `AGENTS.md never covers the rule '${id}'`);
  }
  // A heading can also name one of the tools, so those are read off disk
  // instead of being listed here, where the list would go stale.
  const toolNames = new Set(
    [...readdirSync(join(ROOT, "hooks")), ...readdirSync(join(ROOT, "scripts"))].map((f) =>
      f.replace(/\.(ts|sh)$/, ""),
    ),
  );
  for (const heading of headings) {
    if (!/^[a-z]+-[a-z-]+$/.test(heading)) continue;
    if (ids.has(heading) || toolNames.has(heading)) continue;
    assert.fail(`AGENTS.md has a rule-looking heading '${heading}' with no record and no tool`);
  }
});

test("AGENTS.md never states an enforcement a record contradicts", () => {
  const text = agentsFile();
  for (const record of readRecords()) {
    const section = new RegExp(
      `^#+\\s+\`?${record.id}\`?\\s*$([\\s\\S]*?)(?=^#+\\s|$)`,
      "m",
    ).exec(text);
    if (section === null) continue;
    for (const other of ["hook", "prompt", "human_gate"].filter((e) => e !== record.enforcement)) {
      assert.doesNotMatch(
        section[1],
        new RegExp(`enforcement[:\`\\s]+${other}\\b`),
        `AGENTS.md calls ${record.id} ${other}; its record says ${record.enforcement}`,
      );
    }
  }
});
