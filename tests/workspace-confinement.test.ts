// The internal working directory is gitignored and must never reach a
// published clone, in the tree or in history. An audit pointed out this
// invariant had no mechanical check anywhere, which left the whole thing
// resting on the pre-publication list being run by hand.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = ".workspace";

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

test("no file under the internal working directory is tracked", () => {
  const tracked = git(["ls-files", "--", DIR]).trim();
  assert.equal(tracked, "", `these are tracked and must not be: ${tracked}`);
});

test("no commit ever added a path under the internal working directory", () => {
  const added = git(["log", "--all", "--diff-filter=A", "--name-only", "--pretty=format:"])
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${DIR}/`) || line === DIR);
  assert.deepEqual(added, [], "a file deleted later is still readable at its commit");
});

// The ignore rule has to name the directory, so that one line is the single
// permitted mention. Anything else pointing at it breaks for whoever clones
// and advertises that the directory exists.
test("only the ignore rule mentions the internal working directory", () => {
  const hits = git(["grep", "-n", "--", DIR])
    .split("\n")
    .filter((line) => line.trim() !== "")
    .filter((line) => !line.startsWith(".gitignore:"));
  assert.deepEqual(hits, [], `tracked files pointing at ${DIR}: ${hits.join(", ")}`);
});
