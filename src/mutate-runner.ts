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
    const verdict: Verdict = run.timedOut ? "timeout" : run.status === 0 ? "survived" : "killed";
    return { mutation, verdict, durationMs: run.durationMs, exitCode: run.timedOut ? null : run.status };
  } finally {
    io.writeFile(absolutePath, originalText);
  }
}
