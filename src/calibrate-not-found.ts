// Calibrates what THIS machine's own shell actually prints for a command
// that does not exist, instead of trusting a hardcoded English literal.
//
// induce's could-not-run detection (src/induce.ts, isNotRunnable) needs a
// text match on win32, because cmd.exe reports a missing command with
// plain exit 1 -- the same code an ordinary failure uses -- so exit code
// alone cannot tell the two apart there. WINDOWS_COMMAND_NOT_FOUND_MESSAGE
// in src/induce.ts is that text, but it is English only: a non-English
// Windows prints the same banner in its own language, and the hardcoded
// pattern does not match it. A neutralize step for a command that does
// not exist would then read as a control that ran, on a majority of the
// world's Windows installations, which is exactly the false robustness
// claim this whole tool exists to catch.
//
// There is no structured signal to fall back on instead: the command runs
// through a shell (see src/spawn-command.ts), so Node's own not-found
// error never fires for the inner command, and cmd.exe offers nothing
// like POSIX's exit code 127. What there is, is the shell itself: it will
// say the same thing about a command that does not exist on this run that
// it said about one that did not exist earlier, in whatever language this
// machine's Windows is set to. So this module spawns a command guaranteed
// not to exist, through the same shell mechanism every step already runs
// through, and reads back what this machine actually said. No PATH
// reimplementation, no locale list, and it works in any language, because
// it is never told what language to expect -- it is shown.
//
// This is I/O -- one subprocess spawn -- so it lives here, next to
// spawn-command.ts, and not in src/induce.ts, which stays pure and can be
// tested without running anything.

import process from "node:process";
import { randomBytes } from "node:crypto";
import { spawnCommand } from "./spawn-command.ts";
import type { StepResult } from "./induce.ts";

/**
 * The invariant part of a "command not found" banner: the text a shell
 * printed right after the missing command's own name, which does not
 * depend on which command was missing. `output` is a calibration run's
 * combined stdout+stderr; `commandName` is the literal text that was
 * spawned. Undefined when the command's own name does not appear in the
 * output at all -- the shell did not echo it back the way cmd.exe's own
 * banner does, so nothing reliable can be extracted -- or when nothing
 * follows it on the same line.
 *
 * Only the rest of that one line is kept, not the whole output: matching
 * this text back against a later failure (isNotRunnable, src/induce.ts) is
 * itself anchored to the failure's first line, so the template and what it
 * is compared against are cut the same way.
 */
export function extractNotFoundTemplate(output: string, commandName: string): string | undefined {
  const idx = output.indexOf(commandName);
  if (idx === -1) return undefined;
  const firstLine = output.slice(idx + commandName.length).split("\n", 1)[0]?.trim() ?? "";
  return firstLine.length > 0 ? firstLine : undefined;
}

/**
 * Whether this spec's steps make it worth calibrating what this machine's
 * shell actually says for a missing command. Calibration only ever matters
 * on win32: POSIX's 126/127 exit codes (see NOT_RUNNABLE_EXIT_CODES,
 * src/induce.ts) already tell a never-ran command apart from an ordinary
 * failure without reading any text, so nothing there needs it. Windows
 * only needs it once a step has already failed with plain exit 1, the one
 * code it shares with an ordinary failure -- that is the one case a text
 * match alone can resolve, and the one case that stays ambiguous without
 * one.
 *
 * Calibrating on every invocation would cost a spawn nobody needs, since
 * the ordinary case is every step passing or failing with a code that
 * already has an answer. Calibrating lazily, only when this is true, costs
 * nothing in that ordinary case and pays for one extra spawn only on the
 * runs where the answer actually depends on it.
 *
 * `platform` is injectable for the same reason it is in src/induce.ts:
 * this decision is exercised without a Windows host.
 */
export function needsCalibration(steps: StepResult[], platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" && steps.some((step) => step.outcome === "failed" && step.exitCode === 1);
}

/** Memoizes calibrateNotFoundTemplate's result for the life of this
 * process. The shell's own text does not change between specs within one
 * run of this CLI, so the first spec that needs it pays for the spawn and
 * every later spec in the same run reuses the answer; a fresh invocation
 * of the CLI is a fresh process and calibrates again, which only matters
 * if this machine's own locale changes between runs. */
let calibration: Promise<string | undefined> | undefined;

/** Test-only: forces the next calibrateNotFoundTemplate call to calibrate
 * again instead of reusing a cached answer, so one test file's calibration
 * runs do not leak into the next. Production never calls this. */
export function resetCalibrationForTests(): void {
  calibration = undefined;
}

/**
 * Spawns a command guaranteed not to exist, through the very shell
 * mechanism every spec step already runs through (spawnCommand, see
 * spawn-command.ts), and returns the invariant part of what this
 * machine's own shell printed for it -- see extractNotFoundTemplate. That
 * text is what lets isNotRunnable (src/induce.ts) recognize a real
 * Windows "not found" banner whatever language this machine's Windows
 * reports it in, instead of only the English literal in
 * WINDOWS_COMMAND_NOT_FOUND_MESSAGE.
 *
 * Calibration can fail in several ways: the spawn itself could not start,
 * a command that happens to share this exact random name actually exists
 * and ran, or the shell's output does not echo the command's own name back
 * the way cmd.exe's banner does. None of those throw; every one of them
 * returns undefined instead, and every caller treats undefined the same
 * way: fall back to WINDOWS_COMMAND_NOT_FOUND_MESSAGE, the same fixed
 * English text this tool matched before calibration existed. A failed
 * calibration degrades to the previous, narrower behaviour; it never
 * breaks a run.
 */
export function calibrateNotFoundTemplate(cwd: string): Promise<string | undefined> {
  if (calibration === undefined) {
    calibration = (async (): Promise<string | undefined> => {
      const marker = `adg-induce-calibration-${randomBytes(8).toString("hex")}`;
      try {
        const result = await spawnCommand(marker, { cwd, timeoutMs: 10_000 });
        if (result.status === 0) return undefined;
        const output = [result.stdout, result.stderr].filter((text) => text.trim() !== "").join("\n");
        return extractNotFoundTemplate(output, marker);
      } catch {
        return undefined;
      }
    })();
  }
  return calibration;
}
