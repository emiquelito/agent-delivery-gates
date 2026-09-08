// Tests for the CI workflows. There is no YAML parser here and no runtime
// dependency to add one, so these check the things that make a workflow a
// gate instead of decoration: that it runs the checks, that it fetches enough
// history for them to work, and that every command it names is real.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OWN_WORKFLOW = join(ROOT, ".github", "workflows", "gates.yml");
const TEMPLATE = join(ROOT, "templates", "github-workflow.yml");

function read(path: string): string {
  assert.ok(existsSync(path), `${path} does not exist`);
  return readFileSync(path, "utf8");
}

// Pulls the shell block out of the template's "prose scan" step's `run: |`
// block, dedented, so it can be executed for real against a scratch
// directory instead of only pattern-matched as YAML text.
function extractProseScanShell(yml: string): string {
  const lines = yml.split("\n");
  const stepIndex = lines.findIndex((l) => l.trim() === "- name: prose scan");
  assert.ok(stepIndex >= 0, "template has no 'prose scan' step");
  const runIndex = lines.findIndex((l, i) => i > stepIndex && l.trim() === "run: |");
  assert.ok(runIndex >= 0, "prose scan step has no 'run: |' block");
  const runIndent = lines[runIndex].match(/^(\s*)/)![1].length;
  const body: string[] = [];
  for (let i = runIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      body.push("");
      continue;
    }
    const indent = line.match(/^(\s*)/)![1].length;
    if (indent <= runIndent) break;
    body.push(line);
  }
  // Dedent to the first body line's own indent.
  const bodyIndent = body.find((l) => l.trim() !== "")?.match(/^(\s*)/)?.[1].length ?? 0;
  return body.map((l) => l.slice(bodyIndent)).join("\n");
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

// The template's prose step is meant to be off for anyone who never asked for
// it, on this repo's own finding: the un-guarded version fails CI outright
// with no .adg/prose-rules.txt in the tree, which is the state of any project
// straight out of `adg init` with no --prose-preset. These tests execute the
// guard's real shell, not just its YAML text, against a scratch directory
// standing in for that project, with a stub `npx` on PATH in place of the
// real package so the test observes what the guard chooses to invoke.
function withScratchDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "adg-prose-guard-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A stub `npx` that records its arguments to a file, so the guard's shell can
// run to completion without the real package installed. The exit code is a
// parameter because the guard has to pass a real scan failure back out: a
// guard that ran the scan and swallowed its exit code would report a clean
// build over prose that failed the rules.
function installStubNpx(dir: string, exitCode = 0): { binDir: string; callsFile: string } {
  const binDir = join(dir, "bin");
  const callsFile = join(dir, "npx-calls.txt");
  execFileSync("mkdir", ["-p", binDir]);
  writeFileSync(
    join(binDir, "npx"),
    `#!/usr/bin/env bash\necho "$@" >> "${callsFile}"\nexit ${exitCode}\n`,
    { mode: 0o755 },
  );
  return { binDir, callsFile };
}

function runProseScanShell(dir: string, binDir: string): { status: number; stdout: string } {
  const shell = extractProseScanShell(read(TEMPLATE));
  try {
    const stdout = execFileSync("bash", ["-c", shell], {
      cwd: dir,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
      encoding: "utf8",
    });
    return { status: 0, stdout };
  } catch (err) {
    const e = err as { status: number; stdout: string };
    return { status: e.status, stdout: e.stdout };
  }
}

test("the CI template's prose step does not run the scan when rules are absent", () => {
  withScratchDir((dir) => {
    const { binDir, callsFile } = installStubNpx(dir);
    const result = runProseScanShell(dir, binDir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /skipped/);
    assert.ok(!existsSync(callsFile), "the guard invoked npx with no rules file present");
  });
});

test("the CI template's prose step still passes --require-rules when it does run", () => {
  withScratchDir((dir) => {
    execFileSync("mkdir", ["-p", join(dir, ".adg")]);
    writeFileSync(join(dir, ".adg", "prose-rules.txt"), "\\bexample\\b\n");
    const { binDir, callsFile } = installStubNpx(dir);
    const result = runProseScanShell(dir, binDir);
    assert.equal(result.status, 0);
    const calls = readFileSync(callsFile, "utf8");
    assert.match(calls, /scan-prose/);
    assert.match(calls, /--require-rules/);
  });
});

test("the CI template's prose step uses the baseline only when it exists", () => {
  withScratchDir((dir) => {
    execFileSync("mkdir", ["-p", join(dir, ".adg")]);
    writeFileSync(join(dir, ".adg", "prose-rules.txt"), "\\bexample\\b\n");
    const { binDir: binDirNoBaseline, callsFile: callsNoBaseline } = installStubNpx(dir);
    const withoutBaseline = runProseScanShell(dir, binDirNoBaseline);
    assert.equal(withoutBaseline.status, 0);
    assert.doesNotMatch(readFileSync(callsNoBaseline, "utf8"), /--baseline/);

    writeFileSync(join(dir, ".adg", "prose-baseline.txt"), "");
    rmSync(callsNoBaseline);
    const withBaseline = runProseScanShell(dir, binDirNoBaseline);
    assert.equal(withBaseline.status, 0);
    assert.match(readFileSync(callsNoBaseline, "utf8"), /--baseline \.adg\/prose-baseline\.txt/);
  });
});

test("the CI template's prose step fails the build when the scan it runs fails", () => {
  for (const baseline of [false, true]) {
    withScratchDir((dir) => {
      execFileSync("mkdir", ["-p", join(dir, ".adg")]);
      writeFileSync(join(dir, ".adg", "prose-rules.txt"), "\\bexample\\b\n");
      if (baseline) writeFileSync(join(dir, ".adg", "prose-baseline.txt"), "");
      const { binDir, callsFile } = installStubNpx(dir, 1);
      const result = runProseScanShell(dir, binDir);
      assert.match(readFileSync(callsFile, "utf8"), /scan-prose/, "the scan never ran");
      assert.equal(
        result.status,
        1,
        `the guard swallowed the scan's failure (baseline present: ${baseline})`,
      );
    });
  }
});

test("this repository's own workflow runs the prose scan unconditionally with --require-rules", () => {
  const yml = read(OWN_WORKFLOW);
  const lines = yml.split("\n");
  const stepIndex = lines.findIndex((l) => l.trim() === "- name: prose scan");
  assert.ok(stepIndex >= 0, "gates.yml has no 'prose scan' step");
  const runLine = lines.slice(stepIndex).find((l) => l.trim().startsWith("run:"));
  assert.ok(runLine, "the prose scan step has no run line");
  // Unconditional: the run line names the command directly, with no shell
  // `if` guarding whether it executes, unlike the template's guarded form.
  assert.doesNotMatch(runLine!, /run:\s*\|/, "this repo's own prose step should not need a multi-line guard");
  assert.match(runLine!, /scan-prose\.sh --require-rules/);
});

test(".adg/prose-rules.txt still exists in this repository", () => {
  assert.ok(existsSync(join(ROOT, ".adg", "prose-rules.txt")), ".adg/prose-rules.txt is missing");
});
