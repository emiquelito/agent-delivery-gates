// Reading a hook's input, in one place. Four copies of this existed, and they
// had drifted: the same unreadable input blocked in one hook and passed in
// another. An audit found the drift across that seam.

import { readSync } from "node:fs";

/**
 * Reads the whole of a file descriptor, usually stdin. A single read stops at
 * the pipe buffer, about 64KB, and a hook payload carries the file being
 * written, so it goes past that often. Reads in a loop until the end.
 */
export function readAllStdin(fd: number = 0): string {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(65536);
  for (;;) {
    let read: number;
    try {
      read = readSync(fd, buf, 0, buf.length, null);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") continue;
      if (code === "EOF") break;
      return chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : "";
    }
    if (read === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, read)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Parses a hook payload. A payload that is not a JSON object is an error, not
 * an empty one: a hook that cannot read its input has not done its job, and
 * saying nothing would look the same as saying there was nothing to do.
 */
export function parseHookPayload(raw: string): Record<string, unknown> | { error: string } {
  if (raw.trim() === "") {
    return { error: "stdin was empty" };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    return { error: `stdin was not valid JSON (${(err as Error).message})` };
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { error: "hook input was not a JSON object" };
  }
  return payload as Record<string, unknown>;
}
