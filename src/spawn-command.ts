// One subprocess, run through a shell, with a timeout that kills the
// command's whole descendant tree, not just its direct child.
//
// mutate, induce, and census each called spawnSync(command, { shell: true,
// timeout, killSignal: "SIGKILL" }). With shell: true, Node spawns
// "/bin/sh -c <command>", and on timeout it kills only that one process.
// Anything the command itself started (a test runner's worker process,
// say) is never signalled: it shares the shell's process group but a
// signal to one pid does not cascade to that pid's children, so the
// worker is reparented to init and keeps running. Sixty-four such
// processes were found orphaned in production, the oldest ten hours old,
// pinning every core at load average 64.
//
// The fix is to run the command as the leader of its own process group
// (POSIX: spawn with detached: true, which calls setpgid so the command
// and everything it spawns share one new group distinct from ours) and,
// on timeout, kill that whole group with `process.kill(-pid, "SIGKILL")`
// instead of signalling the direct child alone.
//
// spawnSync cannot do this: it exposes no pid to send a second signal to
// and cannot be told to create a new process group before the timeout
// fires, so this is built on the async spawn() instead, with the timeout
// and the buffering both handled by hand.
//
// Windows has no such thing as a POSIX process group to signal. There,
// `detached` does not create one, and a negative pid is meaningless.
// killTree's Windows branch instead enumerates every process on the
// machine (via PowerShell's Win32_Process, the one enumeration mechanism
// guaranteed present on a plain install -- see the comment on that branch
// for why a live tree walk cannot be trusted to find everything) and
// kills by that reconstructed tree; it is used there instead, and nowhere
// else, so the platform split is a deliberate choice written down here,
// not an accident of what `detached` happens to do on each OS.
//
// This one implementation is shared by all three call sites on purpose:
// the same subtle bug was independently present in all three, and a
// single audited kill path is easier to keep correct than three copies
// free to drift back to it.
//
// A second leak, in the same form as the first, followed from the same
// change: `detached: true` puts the command in a new process group so the
// group can be killed at the timeout, but that also takes it out of the
// terminal's foreground group. A real Ctrl-C sends SIGINT only to the
// foreground group, so it now reaches this tool but never the command it
// spawned, which is exactly the orphaning the timeout fix was written to
// stop, just triggered a different way. This module is what creates the
// detached group, so it is what owns tearing it down: while a command is
// in flight, spawnCommand adds its own SIGINT/SIGTERM listener that kills
// the whole group, registered with `prependListener` so it runs before
// whatever handler the caller registered at startup (mutate restores
// mutated files and calls process.exit; census removes its worktree and
// does the same; either one, running first, would exit before the group
// was ever signalled). The listener is added when the child starts and
// removed the moment it settles, so a run of many sequential commands
// (mutate's mutation loop, induce's specs) never accumulates listeners,
// and a signal that arrives between commands falls through to the
// caller's own handler exactly as before.
//
// Windows is unaffected by this: `detached` is false there already (see
// below), so a command spawned there was never moved out of the console's
// process group, and Ctrl-C's default propagation was never taken away by
// this fix. The listener added here still fires on Windows and calls
// killTree, but killTree's own Windows branch (taskkill /t) is idempotent
// against a process that has already received Ctrl-C the ordinary way.
//
// SIGHUP is forwarded the same way as SIGINT and SIGTERM, for the same
// reason: a closed terminal sends SIGHUP to its foreground group, not to a
// detached one, so a command in flight would otherwise be orphaned by that
// route instead of Ctrl-C's.
//
// Re-raising the signal that got a run interrupted, so the tool that was
// running exits with that signal's own code instead of a fixed one, is a
// separate concern from the tree-killing done here and lives in
// reraiseSignal below: this module's listener only ever kills the
// in-flight command's group, it never decides how the caller itself ends.

import { spawn, execFileSync } from "node:child_process";
import process from "node:process";

export interface SpawnCommandOptions {
  cwd: string;
  /** Milliseconds before the command's whole process tree is killed.
   * Undefined means no timeout at all, matching spawnSync's own default. */
  timeoutMs?: number;
  /** Caps how much stdout/stderr is held in memory. Once either stream
   * crosses this many bytes, the tree is killed and `outputOverflowed` is
   * set, the same way spawnSync's own maxBuffer used to arrive as
   * ENOBUFS. Undefined means no cap. */
  maxBufferBytes?: number;
  env?: NodeJS.ProcessEnv;
}

export interface SpawnCommandResult {
  /** The command's exit code, or null when it was killed or never ran. */
  status: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  outputOverflowed: boolean;
  /** A signal that killed the tree for a reason other than the timeout or
   * the output cap above: a segfault, an out-of-memory kill, and so on.
   * Null when the process exited on its own, or when it was killed for
   * one of those two other reasons instead. */
  killedBySignal: NodeJS.Signals | null;
  /** Set when the command could not even be started (e.g. `cwd` does not
   * exist). Distinct from a command that started and exited non-zero. */
  spawnError?: string;
}

/** Kills the command's whole descendant tree. `pid` is the pid handed
 * back by spawn() for the command itself (the process group leader on
 * POSIX, the shell on Windows). Errors are swallowed: by the time this
 * runs, the group or the process may already be gone, and that is
 * success, not a failure to report.
 *
 * The Windows branch used to run `taskkill /pid <pid> /t /f` and rely on
 * its own tree walk. A real interrupted run proved that walk cannot be
 * trusted: sampling every node.exe and cmd.exe on the machine through a
 * real Ctrl-C (100ms, with command lines, 191 samples) showed the shell
 * `pid` names here was already dead before the signal handler even ran --
 * it appears in zero of those samples while it was "alive" by the test's
 * own accounting, only ever recorded as the parent id stamped on its two
 * surviving children, in a four-deep tree where the two deepest processes
 * were the survivors. The same sample shows a live shell for other tests
 * in the same file, so the sampler was finding shells correctly
 * elsewhere -- this one really was gone early. `taskkill /t` walks the
 * *live* tree below the pid it is given; given a pid with no live process
 * behind it, it finds nothing to walk and reports success having killed
 * nothing, and everything actually running underneath -- the script the
 * shell launched, the worker beneath that -- is never touched. No timeout
 * value fixes this: the kill was never cut short, it was aimed at a
 * process that no longer existed.
 *
 * Unlike POSIX, Windows does not reassign an orphan to a new parent when
 * that parent dies -- the dead parent's process id stays stamped on the
 * child for the child's whole life. That is *why* the sampler could still
 * show the parent/child relationship above, and it is what this fix
 * relies on: the tree is reconstructable from parent ids after the
 * parent is gone, even though it cannot be walked live from the parent
 * down. So instead of asking Windows to walk a live tree from `pid`, this
 * snapshots every process on the machine (id and parent id) with
 * PowerShell's `Win32_Process` (via CIM, the successor to the `wmic` this
 * project has already been burned by assuming was present -- wmic is an
 * optional, increasingly absent component on current Windows, where
 * PowerShell is not: Windows PowerShell 5.1 has shipped inside every
 * Windows install since Windows 7 SP1 / Server 2008 R2 SP1, and unlike
 * wmic it has never been marked deprecated or removed from a default
 * image), reconstructs the set of pids descended from `pid` by following
 * parent ids forward through that snapshot (seeding the set with `pid`
 * itself whether or not it still appears in the snapshot, since a dead
 * parent's children are exactly what would otherwise be missed), and
 * kills each one directly by id -- never by asking Windows to walk from a
 * parent that might already be gone.
 *
 * A job object is the textbook answer to this class of problem, but it
 * needs a native module, which this project does not take on. Recording
 * each descendant's pid as it is spawned was considered too: it would
 * avoid the enumeration call below, but it means tracking spawns at
 * arbitrary depth for the life of every command this module runs, for a
 * case (interrupt arriving between the parent's death and the kill) that
 * only matters at kill time, and it still cannot see a grandchild the
 * command spawned that this module was never told about. Enumerating
 * once, at kill time, costs one process launch instead, only when a kill
 * actually happens, and needs no bookkeeping while the command runs.
 *
 * This one PowerShell invocation does the snapshot, the reconstruction,
 * and the kill together, and runs synchronously via execFileSync on
 * purpose. It used to fire the async execFile and return immediately,
 * without waiting for the callback: killTree() is called from a
 * SIGINT/SIGTERM/SIGHUP listener registered with prependListener
 * specifically so it runs before whatever the caller does on the same
 * signal (mutate restoring a mutated file and exiting, census removing
 * its worktree and exiting). Node invokes every listener for one signal
 * synchronously in registration order without awaiting one before the
 * next, so returning before the kill had actually finished would let the
 * caller's handler reach process.exit while descendants were still being
 * torn down in the background -- and a test watching for this tool's own
 * exit could move on to removing a directory a still-terminating
 * descendant was still running out of, before every one of them had
 * actually stopped. execFileSync blocks killTree, and so this listener,
 * until the PowerShell process itself has exited, closing that race; it
 * does not by itself prove the OS has released every handle those
 * processes held (see reraiseSignal's caller for that part), but it does
 * mean the kill was actually issued and PowerShell's own process has
 * ended before anything downstream of this signal runs.
 *
 * Bounded at 5000ms, the same number `taskkill` was widened back to after
 * a real Windows run showed a shorter bound (1500ms) cutting a tree-kill
 * off mid-walk and abandoning whatever it had not yet reached -- alive,
 * which is worse than doing nothing, since the caller's own cleanup that
 * runs right after (mutate writing mutated files back, census removing
 * its worktree) can then fail against a directory a surviving process
 * still holds as its working directory. That mechanism still applies
 * here even though the walk itself moved out of taskkill: the script
 * below still does its kill as a loop of individual Stop-Process calls
 * over the reconstructed set, so a bound that lands mid-loop abandons the
 * targets after the cut the same way a truncated taskkill walk did.
 *
 * Keeping the same number is not "because it was already there" --
 * this operation is not the same cost taskkill was bounded for, and
 * widening from 5000ms was considered and rejected:
 *
 *   - What changed: this now pays PowerShell's process-launch cost
 *     (hosting the CLR-based engine, not the small native taskkill.exe)
 *     before the kill can even begin, on top of one Win32_Process query
 *     over CIM/WMI. Both are documented as capable of running into the
 *     hundreds of milliseconds on an ordinary machine, and measurably
 *     worse under the antivirus interception or busy-runner conditions
 *     1500ms was already found too short for. This project cannot run
 *     Windows to measure either figure directly, so that cost is
 *     inference, not a measurement: reason enough to leave the bound
 *     alone, not to widen it further on top of it.
 *   - What did not change, measured here on Linux as a lower-bound
 *     proxy (a different mechanism -- /proc via `ps`, not WMI via CIM --
 *     so this bounds the floor, not PowerShell's actual cost): spawning a
 *     process and listing every pid/ppid on this machine both complete in
 *     single-digit milliseconds. The snapshot-and-reconstruct logic
 *     itself is not what a slow run would be spending time on; the
 *     platform's process-launch and WMI-provider overhead is.
 *   - The bound this tool's own tests already hold the whole real-SIGINT
 *     path to: waitForNoneAlive gives 10s for the interrupted process to
 *     exit and 5s more for its descendants to be confirmed gone (see
 *     census-cli.test.ts, induce-cli.test.ts, mutate-cli.test.ts). Going
 *     past 5000ms here would eat directly into that budget's remaining
 *     headroom for the parts of the shutdown this bound does not cover
 *     (the rest of the process actually exiting, streams closing), for a
 *     Windows cost this project cannot measure to confirm needs it.
 *     5000ms is the widest bound that still leaves that headroom meaningful.
 *
 * A PowerShell invocation that hits the bound has already killed whatever
 * part of the reconstructed set it reached before being cut off, which is
 * bounded, partial orphan cleanup, never less than doing nothing; a
 * timeout throws, which the catch below treats the same as any other
 * failure of this call. */
function killTree(pid: number): void {
  if (process.platform === "win32") {
    // One CIM snapshot of every process's id and parent id, a
    // breadth-first walk forward from `pid` through those parent ids
    // (added even if `pid` itself is not in the snapshot -- see the
    // comment above), and a Stop-Process of everything found, all in one
    // script so only one PowerShell process is launched. -ErrorAction
    // SilentlyContinue on Stop-Process means a pid that exits between the
    // snapshot and the kill (or was never real to begin with) does not
    // abort the rest of the set.
    const script = `
$targets = @{ ${pid} = $true }
$rows = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
$changed = $true
while ($changed) {
  $changed = $false
  foreach ($row in $rows) {
    $child = [int]$row.ProcessId
    $parent = [int]$row.ParentProcessId
    if ($targets.ContainsKey($parent) -and -not $targets.ContainsKey($child)) {
      $targets[$child] = $true
      $changed = $true
    }
  }
}
foreach ($id in $targets.Keys) {
  Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
}
`;
    try {
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        stdio: "ignore",
        timeout: 5000,
      });
    } catch {
      // best effort; nothing to do if the process already exited or the
      // call above timed out
    }
    return;
  }
  try {
    // The negative pid addresses the whole process group spawn() made
    // this command the leader of.
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

/**
 * Runs `command` in a shell at `cwd`, with an optional timeout, and
 * resolves once it and everything it spawned has exited. A timeout or an
 * output overflow kills the command's whole process tree; nothing this
 * command started is left running once the promise settles.
 */
export function spawnCommand(command: string, options: SpawnCommandOptions): Promise<SpawnCommandResult> {
  const { cwd, timeoutMs, maxBufferBytes, env } = options;
  return new Promise((settle) => {
    const started = Date.now();
    const child = spawn(command, {
      cwd,
      shell: true,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      // POSIX: makes this command the leader of a new process group, so
      // the whole tree can be killed by group later. Windows has no such
      // group to create; killTree() falls back to taskkill /t there.
      detached: process.platform !== "win32",
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputOverflowed = false;
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const clearTimer = (): void => {
      if (timer !== undefined) clearTimeout(timer);
    };

    // The signal handler, the output-overflow handler, and the timeout
    // below all reach for the same child and can each fire independently
    // within one run (an impatient second Ctrl-C, an overflow followed by
    // a signal, and so on). Without a guard, a kill that stalls -- the
    // exact case the timeout in killTree's Windows branch exists for --
    // would let a later trigger run the whole blocking call again on top
    // of the first. killAttempted caps it at one call per child, and
    // folds in clearTimer() so that whichever trigger fires first also
    // cancels the timeout timer, instead of leaving it to fire later and
    // attempt a second kill of its own.
    let killAttempted = false;
    const attemptKill = (): void => {
      if (killAttempted) return;
      killAttempted = true;
      clearTimer();
      if (child.pid !== undefined) killTree(child.pid);
    };

    // A real Ctrl-C (or an external SIGTERM) reaches this tool's own
    // process, not the detached group the command runs in. These two
    // listeners are what makes that signal keep killing the group the way
    // it used to before the group was detached. `prependListener` puts
    // them ahead of any handler the caller registered earlier at startup,
    // so the group is dead before that handler's own process.exit runs.
    const onSignal = (): void => {
      attemptKill();
    };
    process.prependListener("SIGINT", onSignal);
    process.prependListener("SIGTERM", onSignal);
    process.prependListener("SIGHUP", onSignal);
    const removeSignalListeners = (): void => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      process.off("SIGHUP", onSignal);
    };

    const finish = (status: number | null, signal: NodeJS.Signals | null, spawnError?: string): void => {
      if (settled) return;
      settled = true;
      clearTimer();
      removeSignalListeners();
      const result: SpawnCommandResult = {
        status,
        timedOut,
        durationMs: Date.now() - started,
        stdout,
        stderr,
        outputOverflowed,
        killedBySignal: !timedOut && !outputOverflowed ? signal : null,
      };
      if (spawnError !== undefined) result.spawnError = spawnError;
      settle(result);
    };

    const killForOverflow = (): void => {
      if (outputOverflowed) return;
      outputOverflowed = true;
      attemptKill();
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      stdout += chunk.toString("utf8");
      if (maxBufferBytes !== undefined && stdoutBytes > maxBufferBytes) killForOverflow();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      stderr += chunk.toString("utf8");
      if (maxBufferBytes !== undefined && stderrBytes > maxBufferBytes) killForOverflow();
    });

    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        attemptKill();
      }, timeoutMs);
    }

    child.on("error", (err: NodeJS.ErrnoException) => {
      // Could not even start (e.g. cwd does not exist, or the shell
      // itself was not found).
      clearTimer();
      finish(null, null, err.code ?? err.message);
    });

    // "close" is used here instead of "exit": it fires once the child's
    // stdio is also done, so no output is missed after the process itself
    // exits.
    child.on("close", (code, signal) => {
      finish(code, signal);
    });
  });
}

/**
 * Ends this process the way it would have ended if it had never registered
 * a signal handler at all. In Node, registering any listener for SIGINT or
 * SIGTERM removes the default POSIX disposition, which on its own would
 * have terminated the process with exit code 128 plus the signal number
 * (130 for SIGINT, 143 for SIGTERM). Without this, mutate, induce, and
 * census each exited with a fixed code of their own choosing (2) on
 * Ctrl-C, indistinguishable to a shell or a CI job from an ordinary
 * failure that had nothing to do with being interrupted.
 *
 * The fix is the one esbuild, Biome, and `foreground-child` all use: once
 * this tool's own cleanup is done (mutate has restored its mutated files,
 * census has removed its worktree), strip every listener still registered
 * for the signal and re-send it to this same process. This removes every
 * listener, not only the caller's own, because
 * src/spawn-command.ts's own SIGINT/SIGTERM/SIGHUP listener (above) may
 * still be attached at this point: it is only unregistered once the
 * command it was watching actually closes, which had not necessarily
 * happened yet by the time the caller's own handler ran. Leaving it in
 * place would mean the signal was still "handled" from Node's point of
 * view, and the default disposition this function exists to restore would
 * never take over. With no listener left for the signal at all, the
 * re-sent signal is delivered with nothing to intercept it, and the
 * process ends exactly as if this tool had never touched the signal in
 * the first place.
 *
 * Windows has no such default disposition to restore: it has no POSIX
 * signals, and re-sending SIGINT or SIGTERM to the current process there
 * is not guaranteed to report the signal in the exit code at all; it can
 * exit with plain status 1 instead. Chasing that down is separate work
 * this project is not taking on here, so Windows keeps exiting with
 * `windowsFallbackExitCode`, the same fixed code it used before this
 * function existed, and every other part of its behaviour is unchanged.
 *
 * The one hole this cannot close, on any platform: a SIGKILL cannot be
 * intercepted at all, so a process killed with SIGKILL never runs this or
 * any other cleanup. The only known answer to that is a watchdog child
 * process, which this project is not taking on.
 */
export function reraiseSignal(signal: NodeJS.Signals, windowsFallbackExitCode: number): void {
  if (process.platform === "win32") {
    process.exit(windowsFallbackExitCode);
    return;
  }
  process.removeAllListeners(signal);
  process.kill(process.pid, signal);
}
