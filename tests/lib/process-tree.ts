// Shared by the tests in mutate-cli.test.ts, census-cli.test.ts, and
// induce-cli.test.ts that interrupt a running tool with a real SIGINT
// (Ctrl-C) and check what survived it.
//
// Two concerns live here on purpose, kept apart, because conflating them
// is exactly the defect this file exists to fix:
//
// 1. Whether a process is actually gone -- checked directly with
//    process.kill(pid, 0) against pids the process tree itself reported
//    (see recordedPids), never inferred from whether a temporary
//    directory could later be removed.
//
// 2. Whether a temporary directory could be removed afterward -- a
//    cleanup concern, unrelated to (1). A worker just killed can still
//    hold a Windows directory handle open for a while after the OS
//    reports the process gone; failing to remove the directory in that
//    window says nothing about whether the kill worked. cleanupTempDir
//    reports that failure as a note, not a test failure, and
//    sweepStaleTempDirs gives a later run a chance to finish the job so
//    nothing accumulates.

import { readFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Every pid a leak script (the *_RUN_MJS templates in the test files
 * above) dropped into `pidDir`. Each process in the tree these tests
 * build -- the script the shell runs directly, the shell itself (read
 * from its own process.ppid), and the worker it spawns to hang -- writes
 * its own pid to its own `*.pid` file the moment it starts, which is how
 * this reads back a whole process tree without this test needing any
 * platform-specific process-enumeration tool (`ps`, `wmic`, ...): each
 * process just reports its own id and its parent's. */
export function recordedPids(pidDir: string): number[] {
  return readdirSync(pidDir)
    .filter((name) => name.endsWith(".pid"))
    .map((name) => Number(readFileSync(join(pidDir, name), "utf8")));
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** What `pid` actually is (its executable name), for a failure message.
 * A bare process id says nothing about which link in the tree survived --
 * the shell, the script, or the leaf worker -- and telling those apart is
 * exactly what a real Windows failure needed and did not have: without
 * it, an actual partial-tree-kill looked identical to any other flaky
 * process-cleanup failure. `ps -o comm=` covers POSIX (Linux and macOS
 * alike); `tasklist /fi` covers Windows.
 *
 * Two distinct "nothing to report" outcomes are kept apart on purpose,
 * because collapsing them into one "unknown" is exactly what made a real
 * Windows run useless for this: `describePid(55116)` returning "unknown"
 * could mean either "55116 is not running any more" (uninteresting) or
 * "the lookup itself broke" (which hides real information -- a
 * process-tree bug describing itself as merely absent). "gone" covers the
 * first: the lookup ran, and reported, in its own terms, that nothing
 * matches `pid` (tasklist's "INFO: No tasks..." line; `ps` exiting
 * non-zero with empty output). "lookup failed: <reason>" covers
 * everything else -- the tool could not be run, it exited in an
 * unexpected way, or its output did not parse -- so that failure is
 * reported on its own, instead of silently reading as "the process was
 * already gone". */
export function describePid(pid: number): string {
  if (process.platform === "win32") {
    const result = spawnSync("tasklist", ["/fi", `PID eq ${pid}`, "/fo", "csv", "/nh"], {
      encoding: "utf8",
      timeout: 2000,
    });
    if (result.error) return `lookup failed: ${result.error.message}`;
    if (result.status !== 0) {
      return `lookup failed: tasklist exited ${result.status}${result.stderr ? `: ${result.stderr.trim()}` : ""}`;
    }
    const stdout = result.stdout ?? "";
    const match = stdout.trim().match(/^"([^"]+)"/);
    if (match) return match[1];
    if (/^INFO:/im.test(stdout)) return "gone";
    return `lookup failed: unexpected tasklist output: ${JSON.stringify(stdout.trim().slice(0, 200))}`;
  }
  const result = spawnSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 });
  if (result.error) return `lookup failed: ${result.error.message}`;
  const name = (result.stdout ?? "").trim();
  if (name) return name;
  if (result.status !== 0) return "gone";
  return "lookup failed: empty ps output";
}

/** A survivor of `waitForNoneAlive`'s budget, together with what it was
 * at the moment it was found still alive. See the comment on
 * waitForNoneAlive below for why the name has to be captured there,
 * before that function's own force-kill runs, instead of being looked up
 * later from the bare pid. */
export interface Survivor {
  pid: number;
  name: string;
}

/** Renders a list of survivors as `pid (name)` pairs for a failure
 * message. Empty input renders as an empty string, cheaply (no process
 * enumeration happens), so call sites can build this unconditionally
 * without an extra branch for the passing case. */
export function describeSurvivors(survivors: Survivor[]): string {
  return survivors.map(({ pid, name }) => `${pid} (${name})`).join(", ");
}

/** Polls for up to `budgetMs` for every pid to be gone, then force-kills
 * anything still alive so a test never leaves a process behind, red run
 * or green. Returns the survivors as of when the budget ran out (each
 * with the name it had at that moment), which is empty exactly when the
 * fix works.
 *
 * Descriptions are captured here, before the force-kill loop below, not
 * later by whatever builds the failure message. A real Windows run
 * showed why that order matters: describePid on a survivor asked about
 * *after* this function had already SIGKILLed it can only ever answer
 * "gone" -- correctly, since by then it is -- which is indistinguishable
 * from a lookup that never worked and useless for telling which link in
 * the tree (shell, script, worker) actually survived. Naming each
 * survivor while it is still the thing that outlived the interrupt, and
 * carrying that name forward instead of the bare pid, is what makes the
 * diagnostic describe the failure instead of describing its own
 * cleanup. */
export function waitForNoneAlive(pids: number[], budgetMs: number): Survivor[] {
  const deadline = Date.now() + budgetMs;
  let stillAlive = pids.filter(isAlive);
  while (stillAlive.length > 0 && Date.now() < deadline) {
    spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 50)"], { timeout: 200 });
    stillAlive = pids.filter(isAlive);
  }
  const survivors = stillAlive.map((pid) => ({ pid, name: describePid(pid) }));
  for (const pid of stillAlive) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  return survivors;
}

/** Removes `path`, the same way these tests always have (retried, since a
 * worker just killed can still hold a Windows handle on it briefly), but
 * never throws. A directory that still cannot be removed after that
 * budget is a cleanup problem, not proof that a process survived --
 * *that* claim is settled by waitForNoneAlive above, before this ever
 * runs -- so this reports it to the console as a plain note and lets the
 * test's actual result stand. sweepStaleTempDirs (below) gives a later
 * run a chance to finish removing it, so nothing left behind here
 * accumulates. */
export function cleanupTempDir(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[cleanup note] could not remove ${path}, leaving it for a later sweep: ${message}`);
  }
}

/** Best-effort removal of every leftover entry under `root` (the system
 * temp directory by default) whose name starts with `prefix`. Meant to be
 * called once, at module load, by each test file that uses
 * cleanupTempDir above, so a directory a previous run could not remove
 * (logged as a cleanup note, not a failure) gets another chance here
 * instead of sitting there forever. A single pass, no retries: this is
 * not the assertion that a directory came down, only routine upkeep, and
 * one more failed attempt just waits for the next run. */
export function sweepStaleTempDirs(prefix: string, root: string = tmpdir()): void {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    try {
      rmSync(join(root, name), { recursive: true, force: true });
    } catch {
      // Still locked; left for the next sweep.
    }
  }
}
