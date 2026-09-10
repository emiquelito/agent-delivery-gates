// Tests for src/spawn-command.ts directly, at the seam: no CLI subprocess
// is spawned here, spawnCommand is called in-process, the same way mutate,
// induce, and census each call it once per command they run.
//
// Two things are covered that the CLI-level tests (which each spawn a real
// mutate/induce/census subprocess and watch what it leaves behind) cannot
// cover as cheaply or as directly:
//
//   - finding 5: the module's own comment claims "listeners never
//     accumulate" but that claim was untested. A reviewer disabled
//     removeSignalListeners() in finish() and all 104 tests still passed,
//     while a 100-mutation run produced a real
//     MaxListenersExceededWarning. Asserting on process.listenerCount
//     across many repeated calls, in-process, catches that regression
//     directly and far faster than spawning 100 real subprocesses would.
//   - design correction A: SIGHUP is forwarded the same way SIGINT and
//     SIGTERM are, so a closed terminal cannot leak a command's tree by
//     that route the way it used to leak it through Ctrl-C.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { spawnCommand } from "../src/spawn-command.ts";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Polls for up to `budgetMs` for every pid to be gone, then force-kills
 * anything still alive so this test never leaves a process behind, red run
 * or green. Returns the pids still alive when the budget ran out, which is
 * empty exactly when the fix works. */
async function waitForNoneAlive(pids: number[], budgetMs: number): Promise<number[]> {
  const deadline = Date.now() + budgetMs;
  let stillAlive = pids.filter(isAlive);
  while (stillAlive.length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    stillAlive = pids.filter(isAlive);
  }
  for (const pid of stillAlive) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  return stillAlive;
}

// --- finding 5: signal listeners must not accumulate across many runs -------

test("spawnCommand leaves process's own SIGINT/SIGTERM/SIGHUP listener counts unchanged once a run settles", async () => {
  const baseline = {
    SIGINT: process.listenerCount("SIGINT"),
    SIGTERM: process.listenerCount("SIGTERM"),
    SIGHUP: process.listenerCount("SIGHUP"),
  } as const;

  // A reviewer found that disabling removeSignalListeners() in finish()
  // left all 104 tests at the time green, because nothing asserted on the
  // listener count itself; a 100-mutation run was what actually produced
  // MaxListenersExceededWarning in production. 25 sequential calls here is
  // enough to turn "the count grew" into a clear, repeated signal instead
  // of noise from a single run.
  for (let i = 0; i < 25; i++) {
    await spawnCommand("node -e \"\"", { cwd: process.cwd() });
    assert.equal(process.listenerCount("SIGINT"), baseline.SIGINT, `SIGINT after run ${i}`);
    assert.equal(process.listenerCount("SIGTERM"), baseline.SIGTERM, `SIGTERM after run ${i}`);
    assert.equal(process.listenerCount("SIGHUP"), baseline.SIGHUP, `SIGHUP after run ${i}`);
  }
});

test("spawnCommand's own listeners are gone while no command is in flight, and present only while one is", async () => {
  const baselineInt = process.listenerCount("SIGINT");
  const promise = spawnCommand("node -e \"setTimeout(() => {}, 300)\"", { cwd: process.cwd() });
  // Give the listener a moment to attach; spawnCommand adds it
  // synchronously when the child is created, but this test does not
  // depend on that timing beyond "eventually, while the command runs".
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(
    process.listenerCount("SIGINT") > baselineInt,
    "expected a listener to be attached while a command is in flight",
  );
  await promise;
  assert.equal(
    process.listenerCount("SIGINT"),
    baselineInt,
    "expected the listener to be removed once the command settled",
  );
});

// --- finding 1 (follow-up review): a kill in flight must not stack another ---

// killForOverflow used to set outputOverflowed and call killTree without
// touching the pending setTimeout at all. If the command's stdio kept
// producing data faster than the event loop could drain it -- exactly what
// the overflow itself implies -- the timer could still be sitting on the
// queue when it came due, fire before the overflow-triggered kill's "close"
// event ever arrived, and stamp timedOut: true onto a run that was actually
// stopped by the output cap. attemptKill() now clears the timer synchronously,
// in the same tick the overflow is detected, so the timer can never fire
// after an overflow kill has already been attempted. A large enough burst
// with a short enough timeout reproduces the old race directly: this test
// would have been flaky-to-failing under the previous code and is
// deterministic under the fix, because the clear now happens before the
// timer is ever given a chance to run.

test("an output overflow clears the pending timeout instead of leaving it to fire later (finding 1)", async () => {
  // A 20MB burst against a 100-byte cap and a 30ms timeout reproduces the
  // old race reliably: overflow is detected within a few ms, well before
  // the timer, but before this fix the timer stayed armed and the child's
  // "close" event (which used to be the only thing that cancelled it) was
  // slow enough, under a burst this size, to sometimes arrive after 30ms.
  // Running this against the pre-fix killForOverflow (which called killTree
  // directly instead of attemptKill) produced outputOverflowed && timedOut
  // both true in roughly a third of 20 runs; against the fix, 20/20 runs
  // showed outputOverflowed with timedOut false.
  const result = await spawnCommand("node -e \"process.stdout.write('x'.repeat(20_000_000))\"", {
    cwd: process.cwd(),
    maxBufferBytes: 100,
    timeoutMs: 30,
  });
  assert.equal(result.outputOverflowed, true, "expected the output cap to trigger the kill");
  assert.equal(
    result.timedOut,
    false,
    "expected the overflow's kill to have cancelled the timer before it could fire",
  );
});

// --- design correction A: SIGHUP is forwarded, the same as SIGINT/SIGTERM ---

// A closed terminal sends SIGHUP to its foreground group, the same way
// Ctrl-C sends SIGINT to it, and detached: true (needed so a timeout can
// kill a whole process group) moves the command out of that group either
// way. This proves SIGHUP is forwarded the same way SIGINT and SIGTERM
// already were: a worker that shares its process group and ignores
// SIGTERM, killed only by a real SIGHUP sent to this test process itself,
// exactly what a closed terminal sends.

test(
  "spawnCommand forwards SIGHUP to the command's whole process tree, killing it (design correction A)",
  {
    // Unlike SIGINT (used by the other new signal tests, e.g.
    // census-cli.test.ts, induce-cli.test.ts, mutate-cli.test.ts), SIGHUP
    // is not in Node's documented allow-list of signals Windows delivers
    // reliably (SIGINT, SIGBREAK, SIGTERM, SIGKILL). A raw
    // process.kill(process.pid, "SIGHUP") against this test process is not
    // a defect in the fix being tested here; it is untested on Windows
    // because Windows has no SIGHUP to test.
    skip: process.platform === "win32" ? "SIGHUP delivery is unreliable on Windows; see Node's signal docs" : false,
  },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "adg-spawn-command-sighup-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const pidFile = join(dir, "worker.pid");
    writeFileSync(
      join(dir, "worker.mjs"),
      'process.on("SIGTERM", () => {});\nprocess.on("SIGINT", () => {});\nsetInterval(() => {}, 1000);\n',
    );
    writeFileSync(
      join(dir, "run.mjs"),
      `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const worker = spawn(process.execPath, ["worker.mjs"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(pidFile)}, String(worker.pid));
worker.on("exit", (code) => process.exit(code ?? 0));
`,
    );

    const promise = spawnCommand("node run.mjs", { cwd: dir });
    const recordDeadline = Date.now() + 10_000;
    while (true) {
      try {
        const pid = Number(readFileSync(pidFile, "utf8"));
        if (Number.isInteger(pid) && pid > 0) break;
      } catch {
        // not written yet
      }
      if (Date.now() > recordDeadline) assert.fail("expected the worker's pid to be recorded before SIGHUP");
      await new Promise((r) => setTimeout(r, 50));
    }
    const workerPid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(isAlive(workerPid), "expected the worker to be alive just before SIGHUP");

    process.kill(process.pid, "SIGHUP");
    await promise;

    const survivors = await waitForNoneAlive([workerPid], 5_000);
    assert.deepEqual(survivors, [], "the worker outlived a real SIGHUP sent to this process");
  },
);
