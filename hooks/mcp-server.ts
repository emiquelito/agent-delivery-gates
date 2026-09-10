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

// How long the drain in the `close` handler below waits for in-flight work
// before it stops waiting and answers what is left with an explicit error.
// A few seconds: long enough for the slowest real thing this server does
// mid-request (loading the tree-sitter Python grammar the first time a .py
// file shows up, a git diff-tree over a large repo) to finish under normal
// conditions, short enough that an editor closing this process down does
// not sit there for the length of a coffee break waiting on a request that,
// by definition, is never going to finish on its own. Overridable for
// tests, which want this bound in milliseconds, not seconds.
const DRAIN_TIMEOUT_MS = (() => {
  const raw = process.env.ADG_MCP_DRAIN_TIMEOUT_MS;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5000;
})();

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
  // The id of every request still in flight, so the `close` handler below
  // can answer one that is still pending when its bound expires instead of
  // dropping it. Only a request gets an entry here (a message with an
  // "id"); a notification gets no reply whatever happens to it, so there is
  // nothing useful to track for one.
  const pendingIds = new Map<Promise<void>, string | number | null>();

  rl.on("line", (line: string) => {
    // A best-effort peek at the id, for the drain bound below only. This
    // is not the parse that decides what handleLine does with the line;
    // handleLine does its own parsing and owns every real decision about
    // malformed input. A line that fails to parse here (or carries no
    // "id") simply gets no entry in pendingIds, which only matters if this
    // exact request is still unresolved when the bound expires; handleLine
    // resolves a parse failure on its own almost immediately, so that case
    // does not arise in practice.
    let id: string | number | null | undefined;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null && Object.prototype.hasOwnProperty.call(parsed, "id")) {
        const rawId = (parsed as Record<string, unknown>).id;
        if (typeof rawId === "string" || typeof rawId === "number" || rawId === null) id = rawId;
      }
    } catch {
      // Malformed line: handleLine reports the parse error itself, with no
      // id to reply against. Nothing to track here.
    }

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
        pendingIds.delete(task);
      });
    inFlight.add(task);
    if (id !== undefined) pendingIds.set(task, id);
  });

  rl.on("close", () => {
    // Drain every reply already in flight before exiting, but never past
    // DRAIN_TIMEOUT_MS: Finding 1 was this drain waiting on
    // Promise.allSettled with no bound at all, so one handler stalled on
    // real work that never finished (a stuck grammar load, a hung child
    // process, any stalled I/O) hung this process forever, killable only
    // from outside. Finding 2 was that even bounding it is not enough on
    // its own: a pending promise that holds no timer, socket, or other
    // active handle lets Node's own idle exit fire before either the drain
    // or this timeout ever gets a say, dropping the reply exactly as
    // silently as before the drain existed. Setting this timer here, and
    // never calling `.unref()` on it, is what keeps the process alive
    // until one of the two paths below actually runs.
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Every request still in flight when the bound expired gets an
      // explicit error reply instead of silence, so a client sees "this
      // did not finish" instead of a hang or a dropped reply.
      // Never a duplicate: a task only reaches this loop while it is still
      // in inFlight, and finishing removes it from both maps before this
      // callback (a macrotask) can even run, since every microtask queued
      // by a settling task drains first.
      for (const task of inFlight) {
        const id = pendingIds.get(task);
        if (id === undefined) continue;
        process.stdout.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32000,
              message: `mcp-server: shutting down after ${DRAIN_TIMEOUT_MS}ms; this request had not finished`,
            },
          })}\n`,
        );
      }
      process.exit(0);
    }, DRAIN_TIMEOUT_MS);

    void Promise.allSettled(inFlight).then(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.exit(0);
    });
  });
}

main();
