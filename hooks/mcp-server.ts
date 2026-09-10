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

  // Every line in flight, so `close` can wait for all of them before this
  // process exits. handleLine became async in the same commit that added
  // the tree-sitter Python service: a request needing that grammar now
  // crosses a real filesystem read before it resolves, and a client that
  // sends its last request and closes stdin right away used to win that
  // race against this process, exiting 0 with the reply never written.
  // Nothing but `close` reads this set; `line` only ever adds to it and
  // removes what it added, so nothing here can leak across requests.
  const inFlight = new Set<Promise<void>>();

  rl.on("line", (line: string) => {
    // handleLine documents that it never throws: every failure it hits,
    // from a malformed line to an internal error mid-request, comes back
    // as a JSON-RPC reply (or null for a notification), never an
    // exception. The `.catch` below is a second line of defense, not
    // reliance on that promise: if handleLine ever did throw, this still
    // has to resolve so `close` is never left waiting on a task that can
    // no longer finish, and the failure still reaches a human instead of
    // vanishing.
    const task = handleLine(line, ctx)
      .then((reply) => {
        if (reply !== null) {
          process.stdout.write(`${reply}\n`);
        }
      })
      .catch((e) => {
        process.stderr.write(`mcp-server: internal error handling a request (${(e as Error).message})\n`);
      })
      .finally(() => {
        inFlight.delete(task);
      });
    inFlight.add(task);
  });

  rl.on("close", () => {
    // Drain every reply already in flight before exiting. A client that
    // never closes stdin never reaches this at all, so it is unaffected;
    // one that does gets every reply it is owed first.
    void Promise.allSettled(inFlight).then(() => {
      process.exit(0);
    });
  });
}

main();
