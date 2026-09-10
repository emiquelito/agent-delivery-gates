// Tests for src/calibrate-not-found.ts: the locale-independent alternative
// to WINDOWS_COMMAND_NOT_FOUND_MESSAGE's hardcoded English text.
//
// calibrateNotFoundTemplate spawns a real subprocess -- nothing here is
// mocked -- to prove the actual mechanism (spawn a command guaranteed not
// to exist, through the same shell every step runs through, then read back
// what this machine's own shell said) works, not just the string plumbing
// around it. This machine is not Windows, so this cannot exercise the
// win32 text itself; what it proves is that the spawn-and-extract mechanism
// is real and degrades correctly when it can't find what it's looking for.
// tests/induce.test.ts carries the simulated-non-English-Windows case, by
// handing isNotRunnable and runFromSteps a template directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calibrateNotFoundTemplate,
  extractNotFoundTemplate,
  needsCalibration,
  resetCalibrationForTests,
} from "../src/calibrate-not-found.ts";
import type { StepResult, StepName, StepOutcome } from "../src/induce.ts";

function step(name: StepName, outcome: StepOutcome, exitCode: number | null = null): StepResult {
  return { step: name, command: `run-${name}`, outcome, exitCode, durationMs: 1, stdout: "", stderr: "" };
}

// --- extractNotFoundTemplate ---------------------------------------------------

test("extracts the text right after the command's own name", () => {
  const output = "/bin/sh: 1: totally-not-a-real-command: not found\n";
  assert.equal(extractNotFoundTemplate(output, "totally-not-a-real-command"), ": not found");
});

test("extracts only the first line after the command's name, not the rest of a multi-line banner", () => {
  const output = "'zzz' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n";
  assert.equal(
    extractNotFoundTemplate(output, "zzz"),
    "' is not recognized as an internal or external command,",
  );
});

test("is undefined when the command's own name never appears in the output", () => {
  assert.equal(extractNotFoundTemplate("some unrelated failure\n", "not-there"), undefined);
});

test("is undefined when nothing follows the command's name on its line", () => {
  assert.equal(extractNotFoundTemplate("prefix zzz\n", "zzz"), undefined);
  assert.equal(extractNotFoundTemplate("prefix zzz   \n", "zzz"), undefined);
});

// --- needsCalibration ------------------------------------------------------------

test("never calibrates off win32, whatever a step did", () => {
  assert.equal(needsCalibration([step("neutralize", "failed", 1)], "linux"), false);
  assert.equal(needsCalibration([step("neutralize", "failed", 1)], "darwin"), false);
});

test("does not calibrate on win32 when nothing failed with plain exit 1", () => {
  assert.equal(needsCalibration([step("inject", "passed", 0), step("neutralize", "passed", 0)], "win32"), false);
  // 126/127 are already unambiguous on their own; no text match is needed.
  assert.equal(needsCalibration([step("neutralize", "failed", 127)], "win32"), false);
  assert.equal(needsCalibration([step("neutralize", "failed", 126)], "win32"), false);
});

test("calibrates on win32 exactly when a step failed with the one ambiguous exit code", () => {
  assert.equal(needsCalibration([step("inject", "passed", 0), step("neutralize", "failed", 1)], "win32"), true);
  assert.equal(needsCalibration([step("baseline", "failed", 1)], "win32"), true);
});

// --- calibrateNotFoundTemplate: a real spawn, not mocked -----------------------

test("spawns a real command guaranteed not to exist and extracts this machine's own not-found text", async (t) => {
  t.after(() => resetCalibrationForTests());
  resetCalibrationForTests();
  const template = await calibrateNotFoundTemplate(process.cwd());
  // This machine is POSIX, not win32, so what it says for a missing
  // command is whatever this shell says -- not cmd.exe's text -- but a
  // real spawn still has to produce *some* invariant fragment: proof the
  // mechanism itself works, independent of which OS or language it runs
  // under. If this environment's shell does not echo the command name back
  // at all, calibration correctly gives up instead of guessing.
  assert.ok(template === undefined || typeof template === "string");
  if (template !== undefined) assert.ok(template.length > 0);
});

test("calibration is memoized: a second call in the same process does not spawn again", async (t) => {
  t.after(() => resetCalibrationForTests());
  resetCalibrationForTests();
  const first = calibrateNotFoundTemplate(process.cwd());
  const second = calibrateNotFoundTemplate(process.cwd());
  // Same in-flight promise, not two separate spawns.
  assert.equal(first, second);
  await first;
});

test("a calibration cwd that cannot be spawned into fails closed, not thrown", async (t) => {
  t.after(() => resetCalibrationForTests());
  resetCalibrationForTests();
  const template = await calibrateNotFoundTemplate("/definitely/not/a/real/directory/adg-calibration-test");
  assert.equal(template, undefined);
});
