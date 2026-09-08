// Tests for hooks/delivery-report-stop-hook.ts. The wrapper is thin, but it
// decides whether a failing report stops the agent, so it needs the same
// treatment as the gate it wraps. Every test spawns it as a subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "..", "hooks", "delivery-report-stop-hook.ts");

const PASSING_REPORT = [
  "# Report",
  "",
  "The dirty tree case is handled.",
  "Evidence: commit a1b2c3d4 and tests/report-validator.test.ts.",
  "",
  "## Findings",
  "",
  "- Low: wording",
  "",
  "Committed as a1b2c3d4; tree clean.",
  "",
].join("\n");

const FAILING_REPORT = ["# Report", "", "The dirty tree case is handled.", ""].join("\n");

function runHook(input: string, env: Record<string, string | undefined>) {
  const merged: Record<string, string | undefined> = { ...process.env };
  delete merged.ADG_REPORT;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  const r = spawnSync("node", [HOOK], { input, encoding: "utf8", env: merged });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "adg-stop-hook-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("no report named: exits 0, there is nothing to check", () => {
  const r = runHook(JSON.stringify({ hook_event_name: "Stop" }), {});
  assert.equal(r.status, 0);
});

test("a passing report named by ADG_REPORT: exits 0", () => {
  withTempDir((dir) => {
    const p = join(dir, "report.md");
    writeFileSync(p, PASSING_REPORT);
    const r = runHook(JSON.stringify({ hook_event_name: "Stop" }), { ADG_REPORT: p });
    assert.equal(r.status, 0);
  });
});

test("a failing report: exits 2 with the findings on stderr", () => {
  withTempDir((dir) => {
    const p = join(dir, "report.md");
    writeFileSync(p, FAILING_REPORT);
    const r = runHook(JSON.stringify({ hook_event_name: "Stop" }), { ADG_REPORT: p });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unproven-robustness-claim/);
  });
});

test("ADG_REPORT naming a missing file: exits 2, never 0", () => {
  withTempDir((dir) => {
    const r = runHook(JSON.stringify({ hook_event_name: "Stop" }), {
      ADG_REPORT: join(dir, "absent.md"),
    });
    assert.equal(r.status, 2);
  });
});

test("ADG_REPORT naming a directory: exits 2", () => {
  withTempDir((dir) => {
    const sub = join(dir, "sub");
    mkdirSync(sub);
    const r = runHook(JSON.stringify({ hook_event_name: "Stop" }), { ADG_REPORT: sub });
    assert.equal(r.status, 2);
  });
});

test("ADG_REPORT naming an unreadable file: exits 2", () => {
  withTempDir((dir) => {
    const p = join(dir, "report.md");
    writeFileSync(p, PASSING_REPORT);
    chmodSync(p, 0o000);
    try {
      const r = runHook(JSON.stringify({ hook_event_name: "Stop" }), { ADG_REPORT: p });
      assert.equal(r.status, 2);
    } finally {
      chmodSync(p, 0o644);
    }
  });
});

test("a malformed payload with a failing report still blocks", () => {
  withTempDir((dir) => {
    const p = join(dir, "report.md");
    writeFileSync(p, FAILING_REPORT);
    const r = runHook("{not json", { ADG_REPORT: p });
    assert.equal(r.status, 2);
  });
});

test("report_path in the payload is used when ADG_REPORT is unset", () => {
  withTempDir((dir) => {
    const p = join(dir, "report.md");
    writeFileSync(p, FAILING_REPORT);
    const r = runHook(JSON.stringify({ hook_event_name: "Stop", report_path: p }), {});
    assert.equal(r.status, 2);
  });
});
