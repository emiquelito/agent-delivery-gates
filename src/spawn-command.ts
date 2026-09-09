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
// `detached` does not create one, and a negative pid is meaningless. The
// closest equivalent is `taskkill /pid <pid> /t /f`, which walks and
// kills the process's own descendant tree; it is used there instead, and
// nowhere else, so the platform split is a deliberate choice written down
// here, not an accident of what `detached` happens to do on each OS.
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

import { spawn, execFile } from "node:child_process";
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
 * POSIX). Errors are swallowed: by the time this runs, the group or the
 * process may already be gone, and that is success, not a failure to
 * report. */
function killTree(pid: number): void {
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(pid), "/t", "/f"], () => {
      // best effort; nothing to do if the process already exited
    });
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

    // A real Ctrl-C (or an external SIGTERM) reaches this tool's own
    // process, not the detached group the command runs in. These two
    // listeners are what makes that signal keep killing the group the way
    // it used to before the group was detached. `prependListener` puts
    // them ahead of any handler the caller registered earlier at startup,
    // so the group is dead before that handler's own process.exit runs.
    const onSignal = (): void => {
      if (child.pid !== undefined) killTree(child.pid);
    };
    process.prependListener("SIGINT", onSignal);
    process.prependListener("SIGTERM", onSignal);
    const removeSignalListeners = (): void => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
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
      if (child.pid !== undefined) killTree(child.pid);
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
        if (child.pid !== undefined) killTree(child.pid);
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
