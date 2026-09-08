// Finding the installed package's own root, from anywhere inside it.
//
// Counting directory levels up from a module does not work, because the same
// file runs from two places: scripts/ in a checkout and dist/scripts/ in an
// installed package. Walking up to the nearest package.json works from both.

import { existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Walks up from a module's own file until it finds the directory holding
 * package.json. Throws when there is none, because every caller needs a real
 * answer and a guessed path would send them to a directory that is not there.
 */
export function findPackageRoot(fromFileUrl: string): string {
  let dir = dirname(fileURLToPath(fromFileUrl));
  const { root } = parse(dir);
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    if (dir === root) break;
    dir = dirname(dir);
  }
  throw new Error(`could not find package.json above '${fileURLToPath(fromFileUrl)}'`);
}
