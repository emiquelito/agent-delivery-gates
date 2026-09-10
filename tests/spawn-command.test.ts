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
import { spawnCommand, killTree } from "../src/spawn-command.ts";

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
// after an overflow kill has already been attempted.
//
// This used to be one test that raced a 30ms timeout against a 20MB burst
// and asserted the overflow always won. Under load from other concurrent
// test runs, process creation and event loop scheduling can be delayed past
// 30ms, so the timer fires -- correctly, on its own terms -- before the
// child had even produced 100 bytes of output. That is not a bug in the
// fix; it is a fragile test hard-coding an assumption about relative
// scheduling latency that concurrent load violates. It is split into two
// tests below that each establish one property without racing a wall
// clock: one that the cap always reports an overflow given enough data and
// no deadline to lose to, and one that the overflow branch itself clears
// the pending timer, checked by counting clearTimeout calls instead of
// hoping a timer that was never armed with enough headroom stays silent.

test("a burst larger than the cap always reports an overflow, with no timeout to race", async () => {
  // No timeoutMs at all: with nothing to race, a large enough burst
  // against a small cap always overflows, on any machine, loaded or not.
  const result = await spawnCommand("node -e \"process.stdout.write('x'.repeat(20_000_000))\"", {
    cwd: process.cwd(),
    maxBufferBytes: 100,
  });
  assert.equal(result.outputOverflowed, true, "expected the output cap to trigger the kill");
  assert.equal(result.timedOut, false, "no timeout was set, so it can never fire");
});

test("an output overflow clears the pending timeout instead of leaving it to fire later (finding 1)", async (t) => {
  // A generous 5s timeout against a burst this size means the overflow
  // always wins the "who gets detected first" race in real wall-clock
  // time, on any machine, loaded or not -- there is no race left to win
  // here. What is under test instead is whether *winning that race clears
  // the pending timer proactively*, independent of the run eventually
  // settling.
  //
  // clearTimer() is idempotent and unconditional in finish(), so a
  // clearTimeout call always happens once, at settle, whether or not the
  // fix is present. The fix adds a second, earlier clearTimeout call, from
  // attemptKill() inside the overflow branch itself, before the run
  // settles. Spying on the global clearTimeout and counting calls tells
  // the two cases apart without depending on any timing at all: two calls
  // means the overflow branch cleared the timer itself; one call means it
  // only ever got cleared as a side effect of the close event, which is
  // exactly the pre-fix behaviour this test exists to catch. Reverting the
  // fix in a scratch copy and running this test against it fails 20/20
  // runs on 1 clearTimeout call instead of 2, including under 8-way
  // concurrent full-suite load; against the fix it passes 8/8 under the
  // same concurrent load.
  const realClearTimeout = globalThis.clearTimeout;
  let clearTimeoutCalls = 0;
  globalThis.clearTimeout = ((...args: Parameters<typeof clearTimeout>) => {
    clearTimeoutCalls++;
    return realClearTimeout(...args);
  }) as typeof clearTimeout;
  t.after(() => {
    globalThis.clearTimeout = realClearTimeout;
  });

  const result = await spawnCommand("node -e \"process.stdout.write('x'.repeat(20_000_000))\"", {
    cwd: process.cwd(),
    maxBufferBytes: 100,
    timeoutMs: 5_000,
  });

  assert.equal(result.outputOverflowed, true, "expected the output cap to trigger the kill");
  assert.equal(result.timedOut, false, "expected the overflow to win, not the 5s timeout");
  assert.equal(
    clearTimeoutCalls,
    2,
    "expected clearTimeout to be called twice: once by the overflow branch itself, " +
      "and once more, unconditionally, when the run settles -- one call would mean " +
      "the timer was only ever cleared as a side effect of settling, not by the " +
      "overflow branch cancelling it proactively",
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

// --- Windows silent-failure fix: the kill must report what it did --------

// Three rounds of a real Windows run reporting "outlived after a real
// SIGINT" with no error traced back to killTree's Windows branch running
// inside a bare `catch {}` around a call whose stdio was set to "ignore".
// Nothing could get out: not a PowerShell error (discarded by stdio), and
// Windows PowerShell 5.1's own `-Command` mode does not reliably turn an
// internal script error into a non-zero exit code either, so execFileSync
// had nothing to throw on. The fix makes the script report its own
// outcome on stdout and threads that report onto the result (`treeKill`),
// instead of the caller having to infer success from whether processes
// happened to die.
//
// This suite runs on Linux, where killTree's `win32` branch cannot be
// exercised end-to-end -- there is no Windows process tree here to kill.
// What these two tests can and do prove without one: (1) the POSIX
// branch's own report structure, which the fix must not disturb, since the
// POSIX path is unchanged by design; and (2) that when the win32 branch's
// underlying command cannot even be launched, the failure now comes back
// as a populated `treeKill.error` and a message on this process's own
// stderr, instead of vanishing the way it did in production.

test("a timeout on POSIX reports a tree-kill that was attempted, with no enumerated pids", { skip: process.platform === "win32" }, async () => {
  const result = await spawnCommand("node -e \"setTimeout(() => {}, 10_000)\"", {
    cwd: process.cwd(),
    timeoutMs: 200,
  });
  assert.equal(result.timedOut, true);
  assert.ok(result.treeKill, "expected a treeKill report once a kill was attempted");
  assert.equal(result.treeKill?.platform, process.platform);
  assert.equal(result.treeKill?.attempted, true);
  assert.equal(result.treeKill?.matchedPids, null, "POSIX does not enumerate what it killed, only that it tried");
  assert.equal(result.treeKill?.error, null, "a POSIX group kill that succeeds (or finds the group already gone) is not an error");
});

test(
  "killTree's win32 branch reports a launch failure instead of staying silent, when powershell.exe cannot run",
  { skip: process.platform === "win32" ? "this test forces the win32 branch on a non-Windows host on purpose" : false },
  (t) => {
    const realPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    t.after(() => {
      Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
    });

    // killTree's win32 branch inherits this process's own env, unmodified,
    // for its execFileSync call. Clearing PATH for the duration of this
    // test is what actually forces the launch to fail here: some hosts
    // running this suite (this one included, under WSL) can reach a real
    // powershell.exe via interop, which would make the call succeed
    // instead of exercising the failure path this test is for.
    const realPath = process.env.PATH;
    process.env.PATH = "";
    t.after(() => {
      if (realPath === undefined) delete process.env.PATH;
      else process.env.PATH = realPath;
    });

    const realStderrWrite = process.stderr.write.bind(process.stderr);
    let stderrOutput = "";
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      stderrOutput += chunk.toString();
      return (realStderrWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;
    t.after(() => {
      process.stderr.write = realStderrWrite;
    });

    // The pid itself is never used for anything but string interpolation
    // into the script before the launch fails, so an arbitrary value is
    // enough.
    const report = killTree(999_999);

    assert.equal(report.platform, "win32");
    assert.equal(report.attempted, true);
    assert.equal(report.matchedPids, null);
    assert.ok(
      report.error && /powershell/i.test(report.error),
      `expected a populated error mentioning powershell, got: ${JSON.stringify(report.error)}`,
    );
    assert.ok(
      /Windows process-tree kill.*did not complete cleanly/.test(stderrOutput),
      `expected a human-readable line on stderr, got: ${JSON.stringify(stderrOutput)}`,
    );
  },
);
