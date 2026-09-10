// Whether this process can create a symlink right now. Windows refuses
// symlinkSync with EPERM unless the process runs with an administrator token
// or the machine is in developer mode; every other platform this suite
// targets allows it unconditionally. Detecting the capability directly,
// instead of assuming it from process.platform, means a Windows machine in
// developer mode still runs the tests that need it, and any other platform
// that someday denies the privilege is caught too.

import { symlinkSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Actually tries to create a symlink in a throwaway temp directory and
 * reports whether it worked. Computed once and cached: the answer does not
 * change during a test run. */
function canCreateSymlinks(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "adg-symlink-probe-"));
  try {
    symlinkSync(join(dir, "target"), join(dir, "link"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CAN_SYMLINK = canCreateSymlinks();

/** A `node:test` `skip` value for a test that needs to create a real
 * symlink: `false` (run it) when this process can, otherwise the reason a
 * reader would want, never a bare platform check. */
export const SYMLINK_SKIP: string | false = CAN_SYMLINK
  ? false
  : "creates a symlink, which this machine refuses without developer mode or elevation (Windows: enable Developer Mode, or run as Administrator)";
