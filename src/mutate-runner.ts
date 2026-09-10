// The one mutation step of `adg mutate`: write the broken text, run the
// command, put the original back. It lives here, apart from the CLI in
// hooks/mutate.ts, for one reason: the restore is the most safety-critical
// line in the tool, and a line that can only be exercised by spawning a
// real subprocess against a real repository is a line no test can pin.
// Writing the file and running the command are both passed in, so a test
// can make either of them throw and then check what is on disk.
//
// An audit found this restore held by nothing: the try/finally below could
// be replaced with plain sequential code that restores only when nothing
// throws, and the whole suite stayed green. tests/mutate-runner.test.ts is
// what now holds it.

import { applyMutation, type Mutation, type MutationResult, type Verdict } from "./mutate.ts";

export interface CommandRun {
  /** The command's exit code, or null when it was killed or never ran. */
  status: number | null;
  timedOut: boolean;
  durationMs: number;
  /** True when the command printed more than the run's output cap and was
   * killed for it, the way src/spawn-command.ts reports it. A run killed
   * for overflowing was never judged by whatever it printed: it says
   * nothing about whether the suite would have caught the mutation,
   * exactly as isUnmeasured in src/mutate.ts already says about a
   * timeout. */
  outputOverflowed?: boolean;
  /** The signal that killed the command, when something other than the
   * timeout or the output cap did: a segfault, an out-of-memory kill, a
   * command that signals itself. Null or absent when nothing did. */
  killedBySignal?: string | null;
}

/** The two effects one mutation step has on the world outside this module.
 * runCommand is async because running the command safely means spawning it
 * detached and racing it against a timer by hand (see
 * src/spawn-command.ts): spawnSync cannot create a process group before
 * its timeout fires, and cannot be told to kill one after. */
export interface MutationIo {
  writeFile(absolutePath: string, text: string): void;
  runCommand(): Promise<CommandRun>;
}

/**
 * Applies one mutation to one file, runs the command, and always puts the
 * original text back, whatever the command did and whatever threw. The
 * restore is in a finally block on purpose: a throw here would otherwise
 * leave a caller's source file broken on disk, and the caller may not be
 * in a position to write it back.
 */
export async function runOneMutation(
  mutation: Mutation,
  originalText: string,
  absolutePath: string,
  io: MutationIo,
): Promise<MutationResult> {
  const mutated = applyMutation(originalText, mutation);
  if (mutated === originalText) {
    return { mutation, verdict: "skipped", durationMs: 0, exitCode: null };
  }
  try {
    io.writeFile(absolutePath, mutated);
    const run = await io.runCommand();
    // Order matters, the same way it does in src/induce.ts's outcomeFor: a
    // run that hit the timeout is a timeout even if the kill also crossed
    // the output cap or arrived as a signal, and an overflow kill also
    // carries a signal (the kill itself sends one), so the signal check
    // comes last of the three.
    const verdict: Verdict = run.timedOut
      ? "timeout"
      : run.outputOverflowed === true
        ? "output-overflow"
        : run.killedBySignal !== undefined && run.killedBySignal !== null
          ? "killed-by-signal"
          : run.status === 0
            ? "survived"
            : "killed";
    const unjudged = verdict === "timeout" || verdict === "output-overflow" || verdict === "killed-by-signal";
    return { mutation, verdict, durationMs: run.durationMs, exitCode: unjudged ? null : run.status };
  } finally {
    io.writeFile(absolutePath, originalText);
  }
}
