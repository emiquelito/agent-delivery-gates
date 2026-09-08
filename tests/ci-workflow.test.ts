// Tests for the CI workflows. There is no YAML parser here and no runtime
// dependency to add one, so these check the things that make a workflow a
// gate instead of decoration: that it runs the checks, that it fetches enough
// history for them to work, and that every command it names is real.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OWN_WORKFLOW = join(ROOT, ".github", "workflows", "gates.yml");
const TEMPLATE = join(ROOT, "templates", "github-workflow.yml");

function read(path: string): string {
  assert.ok(existsSync(path), `${path} does not exist`);
  return readFileSync(path, "utf8");
}

test("this repository runs its own gates in CI", () => {
  const yml = read(OWN_WORKFLOW);
  for (const step of ["tsc --noEmit", "npm test", "scan-prose", "tally-report.ts --check"]) {
    assert.ok(yml.includes(step), `the workflow does not run ${step}`);
  }
});

// A shallow clone has no history, so the test diff check sees nothing and the
// prose scan sees a partial file list. Both would report success having
// checked far less than they appear to.
test("both workflows fetch the whole history", () => {
  for (const path of [OWN_WORKFLOW, TEMPLATE]) {
    const yml = read(path);
    const jobs = yml.split(/^  \w[\w-]*:$/m).filter((part) => part.includes("actions/checkout"));
    assert.ok(jobs.length > 0, `${path} checks out nothing`);
    for (const job of jobs) {
      assert.match(job, /fetch-depth:\s*0/, `${path} has a checkout without fetch-depth: 0`);
    }
  }
});

test("the template names only real subcommands", () => {
  const yml = read(TEMPLATE);
  const known = new Set(
    readFileSync(join(ROOT, "bin", "adg.ts"), "utf8")
      .split("\n")
      .flatMap((line) => [...line.matchAll(/case "([\w-]+)":/g)].map((m) => m[1])),
  );
  const used = [...yml.matchAll(/agent-delivery-gates ([\w-]+)/g)].map((m) => m[1]);
  assert.ok(used.length > 0, "the template runs no subcommand at all");
  for (const sub of used) {
    assert.ok(known.has(sub), `the template runs '${sub}', which is not a subcommand`);
  }
});

// The prose scan says nothing was checked when no rules are configured. In CI
// that would pass quietly, so the flag that turns it into a failure has to be
// there.
test("the template's prose scan cannot pass without rules", () => {
  const yml = read(TEMPLATE);
  const line = yml.split("\n").find((l) => l.includes("scan-prose"));
  assert.ok(line, "the template does not run the prose scan");
  assert.match(line, /--require-rules/);
});

test("the template ships in the package and init writes it", () => {
  const files = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).files as string[];
  assert.ok(files.includes("templates"), "templates are not in the published package");
  const initSource = readFileSync(join(ROOT, "src", "init.ts"), "utf8");
  assert.ok(initSource.includes("github-workflow.yml"), "init does not write the workflow");
});

test("every template named by init exists on disk", () => {
  const initSource = readFileSync(join(ROOT, "src", "init.ts"), "utf8");
  const present = new Set(readdirSync(join(ROOT, "templates")));
  for (const m of initSource.matchAll(/templateName: "([\w.-]+)"/g)) {
    assert.ok(present.has(m[1]), `init names a template that is not there: ${m[1]}`);
  }
});
