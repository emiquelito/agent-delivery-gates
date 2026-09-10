#!/usr/bin/env node
// Transport for the agent-delivery-gates MCP server: reads JSON-RPC
// messages from stdin, one per line, and writes replies to stdout, one per
// line. Every line this process writes to stdout is a JSON-RPC message and
// nothing else; a stray log line here would corrupt the stream for
// whatever MCP client started this process, so anything diagnostic goes to
// stderr instead. The protocol itself lives in ../src/mcp-server.ts, which
// this file never duplicates.
//
// Started as a subprocess by an MCP client on the developer's own machine.
// There is no network and no host: the client owns the process, writes
// requests to its stdin, and reads replies from its stdout until it closes
// the pipe, at which point this process exits.

import process from "node:process";
import { createInterface } from "node:readline";
import { findPackageRoot } from "../src/package-root.ts";
import { buildContext, handleLine } from "../src/mcp-server.ts";

function main(): void {
  let ctx;
  try {
    const packageRoot = findPackageRoot(import.meta.url);
    ctx = buildContext(packageRoot, process.cwd());
  } catch (e) {
    // Cannot even find this package's own root or read its package.json.
    // Nothing past this point can run, and nothing has read a line of
    // input yet, so there is no request to reply to; report the failure to
    // stderr and stop before anything touches stdout.
    process.stderr.write(`mcp-server: could not start (${(e as Error).message})\n`);
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on("line", (line: string) => {
    // handleLine never throws: every failure it hits, from a malformed
    // line to an internal error mid-request, comes back as a JSON-RPC
    // reply (or null for a notification), never an exception. Nothing here
    // writes to stdout except that reply. It is async only because
    // separate_test_diff may need to load the tree-sitter Python service
    // before it can run; every other method still resolves on the same
    // tick it always did.
    void handleLine(line, ctx).then((reply) => {
      if (reply !== null) {
        process.stdout.write(`${reply}\n`);
      }
    });
  });

  rl.on("close", () => {
    process.exit(0);
  });
}

main();
