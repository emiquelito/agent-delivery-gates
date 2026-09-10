// Tests for tests/lib/portable-command.ts, the helper every CLI test uses
// to build a --command / --inject / --neutralize value that runs the same
// way under sh and cmd.exe.
//
// nodeCommand's one safety net is the throw on a double quote: the whole
// script it builds is wrapped in double quotes, so a script that contains
// one would run fine under sh and silently break under cmd.exe. A reviewer
// verified the throw fires by hand; nothing in the suite asserted it, so a
// change that quietly removed the guard would have shipped with every
// other test still green.

import { test } from "node:test";
import assert from "node:assert/strict";
import { nodeCommand } from "./lib/portable-command.ts";

test("nodeCommand throws on a script containing a double quote", () => {
  assert.throws(() => nodeCommand(`console.log("hi")`), /must avoid double quotes/);
});

test("nodeCommand accepts a script with no double quote", () => {
  assert.equal(nodeCommand(`console.log('hi')`), `node -e "console.log('hi')"`);
});
