// Tests for hooks/mcp-server.ts, driven as a real subprocess over stdio,
// the way the client actually talks to it: JSON-RPC 2.0, one object per
// line. Nothing here calls into src/mcp-server.ts directly, because the
// contract that matters is what a byte stream in and a byte stream out
// look like, not any internal function's return value.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const SERVER_PATH = join(REPO_ROOT, "hooks", "mcp-server.ts");

// --- A minimal JSON-RPC client over a child process's stdio ------------------

class Session {
  #child: ReturnType<typeof spawn>;
  #buffer = "";
  #rawOut = "";
  #waiters: Array<(line: string) => void> = [];
  #queue: string[] = [];
  #closed = false;
  exitCode: number | null = null;

  constructor(cwd: string = REPO_ROOT) {
    this.#child = spawn("node", [SERVER_PATH], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.#child.stdout!.setEncoding("utf8");
    this.#child.stdout!.on("data", (chunk: string) => {
      this.#rawOut += chunk;
      this.#buffer += chunk;
      let idx: number;
      while ((idx = this.#buffer.indexOf("\n")) !== -1) {
        const line = this.#buffer.slice(0, idx);
        this.#buffer = this.#buffer.slice(idx + 1);
        const waiter = this.#waiters.shift();
        if (waiter) waiter(line);
        else this.#queue.push(line);
      }
    });
    this.#child.on("close", (code) => {
      this.#closed = true;
      this.exitCode = code;
    });
  }

  /** Raw bytes ever written to stdout, exactly as sent, for the
   * every-byte-is-JSON-RPC test. */
  get rawStdout(): string {
    return this.#rawOut;
  }

  stderrText = "";

  captureStderr(): void {
    this.#child.stderr!.setEncoding("utf8");
    this.#child.stderr!.on("data", (chunk: string) => {
      this.stderrText += chunk;
    });
  }

  writeLine(text: string): void {
    this.#child.stdin!.write(`${text}\n`);
  }

  sendRequest(method: string, params: unknown, id: number | string): void {
    this.writeLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  }

  sendNotification(method: string, params?: unknown): void {
    this.writeLine(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  /** Waits for the next full line on stdout, or rejects after `ms` with no
   * line arriving, which is exactly what "produces no reply at all" needs
   * to be able to prove: a timeout is a real assertion, not a guess. */
  nextLine(ms = 2000): Promise<string> {
    if (this.#queue.length > 0) return Promise.resolve(this.#queue.shift()!);
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        const i = this.#waiters.indexOf(onLine);
        if (i !== -1) this.#waiters.splice(i, 1);
        reject(new Error(`no line arrived within ${ms}ms`));
      }, ms);
      const onLine = (line: string) => {
        clearTimeout(timer);
        resolvePromise(line);
      };
      this.#waiters.push(onLine);
    });
  }

  async expectNoReply(ms = 300): Promise<void> {
    await assert.rejects(() => this.nextLine(ms));
  }

  async nextMessage(ms = 2000): Promise<any> {
    const line = await this.nextLine(ms);
    return JSON.parse(line);
  }

  close(): Promise<number | null> {
    return new Promise((resolvePromise) => {
      if (this.#closed) {
        resolvePromise(this.exitCode);
        return;
      }
      this.#child.on("close", (code) => resolvePromise(code));
      this.#child.stdin!.end();
    });
  }
}

async function withSession(cwd: string, fn: (s: Session) => Promise<void>): Promise<void> {
  const session = new Session(cwd);
  try {
    await fn(session);
  } finally {
    await session.close();
  }
}

function withTempDir(fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "adg-mcp-test-"));
  return Promise.resolve(fn(dir)).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

async function initialize(s: Session, id: number | string = 1): Promise<any> {
  s.sendRequest("initialize", { protocolVersion: "2025-06-18" }, id);
  const msg = await s.nextMessage();
  s.sendNotification("notifications/initialized");
  return msg;
}

const PKG = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version: string };

// --- Handshake ----------------------------------------------------------------

test("initialize returns the protocol version, capabilities, and serverInfo", async () => {
  await withSession(REPO_ROOT, async (s) => {
    const msg = await initialize(s);
    assert.equal(msg.jsonrpc, "2.0");
    assert.equal(msg.id, 1);
    assert.equal(msg.result.protocolVersion, "2025-06-18");
    assert.deepEqual(msg.result.capabilities, { resources: {}, tools: {} });
    assert.equal(msg.result.serverInfo.name, "agent-delivery-gates");
    assert.equal(msg.result.serverInfo.version, PKG.version);
    assert.equal(typeof msg.result.instructions, "string");
  });
});

test("initialize's instructions describe the server as advisory, never as a gate", async () => {
  await withSession(REPO_ROOT, async (s) => {
    const msg = await initialize(s);
    const text: string = msg.result.instructions.toLowerCase();
    assert.match(text, /advisory/);
    assert.doesNotMatch(text, /\bgate\b/);
  });
});

test("notifications/initialized produces no reply at all", async () => {
  await withSession(REPO_ROOT, async (s) => {
    await initialize(s);
    // initialize() already sent the notification; nothing should have
    // arrived because of it specifically. Send it again on its own and
    // confirm silence.
    s.sendNotification("notifications/initialized");
    await s.expectNoReply();
  });
});

// --- tools/list -----------------------------------------------------------

test("tools/list returns both tools, each with a valid JSON Schema", async () => {
  await withSession(REPO_ROOT, async (s) => {
    await initialize(s);
    s.sendRequest("tools/list", {}, 2);
    const msg = await s.nextMessage();
    const names = msg.result.tools.map((t: any) => t.name).sort();
    assert.deepEqual(names, ["separate_test_diff", "validate_report"]);
    for (const tool of msg.result.tools) {
      assert.equal(typeof tool.description, "string");
      assert.equal(tool.inputSchema.type, "object");
      assert.equal(typeof tool.inputSchema.properties, "object");
    }
  });
});

// --- tools/call: validate_report ----------------------------------------------

const REPORT_WITH_FINDINGS = ["# Report", "", "The retry path is handled.", ""].join("\n");

const REPORT_WITH_NO_FINDINGS = [
  "# Report",
  "",
  "The retry path is handled.",
  "Evidence: commit a1b2c3d4 and tests/report-validator.test.ts.",
  "",
  "## Findings",
  "",
  "- Low: wording only",
  "",
  "Committed as a1b2c3d4; tree clean.",
  "",
].join("\n");

test("tools/call validate_report: a report with findings comes back non-error, listing them", async () => {
  await withSession(REPO_ROOT, async (s) => {
    await initialize(s);
    s.sendRequest("tools/call", { name: "validate_report", arguments: { text: REPORT_WITH_FINDINGS } }, 3);
    const msg = await s.nextMessage();
    assert.equal(msg.result.isError, false);
    const text = msg.result.content[0].text;
    assert.match(text, /finding/i);
    assert.match(text, /unproven-robustness-claim|missing-commit-line/);
  });
});

test("tools/call validate_report: a clean report reports no findings, plainly", async () => {
  await withSession(REPO_ROOT, async (s) => {
    await initialize(s);
    s.sendRequest("tools/call", { name: "validate_report", arguments: { text: REPORT_WITH_NO_FINDINGS } }, 4);
    const msg = await s.nextMessage();
    assert.equal(msg.result.isError, false);
    assert.match(msg.result.content[0].text, /no findings/i);
  });
});

test("tools/call validate_report: giving neither text nor path is the tool's own failure, isError true, not a protocol error", async () => {
  await withSession(REPO_ROOT, async (s) => {
    await initialize(s);
    s.sendRequest("tools/call", { name: "validate_report", arguments: {} }, 5);
    const msg = await s.nextMessage();
    assert.equal(msg.error, undefined);
    assert.equal(msg.result.isError, true);
  });
});

// --- tools/call: separate_test_diff --------------------------------------------

const DIFF_WITH_SIGNAL = [
  "diff --git a/tests/foo.test.ts b/tests/foo.test.ts",
  "index 1111111..2222222 100644",
  "--- a/tests/foo.test.ts",
  "+++ b/tests/foo.test.ts",
  "@@ -1,3 +1,2 @@",
  " test(\"does the thing\", () => {",
  "-  assert.equal(result, 42);",
  " });",
  "",
].join("\n");

const DIFF_WITH_NO_SIGNAL = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "index 1111111..2222222 100644",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -1,2 +1,2 @@",
  "-export const x = 1;",
  "+export const x = 2;",
  "",
].join("\n");

test("tools/call separate_test_diff: a removed assertion is reported as a signal", async () => {
  await withSession(REPO_ROOT, async (s) => {
    await initialize(s);
    s.sendRequest("tools/call", { name: "separate_test_diff", arguments: { diff_text: DIFF_WITH_SIGNAL } }, 6);
    const msg = await s.nextMessage();
    assert.equal(msg.result.isError, false);
    assert.match(msg.result.content[0].text, /assertion-removed/);
  });
});

test("tools/call separate_test_diff: a source-only diff reports no signals", async () => {
  await withSession(REPO_ROOT, async (s) => {
    await initialize(s);
    s.sendRequest("tools/call", { name: "separate_test_diff", arguments: { diff_text: DIFF_WITH_NO_SIGNAL } }, 7);
    const msg = await s.nextMessage();
    assert.equal(msg.result.isError, false);
    assert.match(msg.result.content[0].text, /none found/i);
  });
});

const DIFF_TOUCHING_PYTHON = [
  "diff --git a/foo.py b/foo.py",
  "index 1111111..2222222 100644",
  "--- a/foo.py",
  "+++ b/foo.py",
  "@@ -1,2 +1,2 @@",
  "-x = 1",
  "+x = 2",
  "",
].join("\n");

test("a request needing the Python grammar still gets a reply when the client closes stdin right after sending it", async () => {
  await withSession(REPO_ROOT, async (s) => {
    await initialize(s);
    // No await between the request and closing stdin: this is exactly the
    // race Finding 1 describes. Loading the tree-sitter Python service to
    // answer this request crosses a real filesystem read, so a server
    // that does not wait for in-flight work before exiting can close
    // before the reply is written, and the request is silently dropped.
    s.sendRequest("tools/call", { name: "separate_test_diff", arguments: { diff_text: DIFF_TOUCHING_PYTHON } }, 42);
    const exitCode = await s.close();
    assert.equal(exitCode, 0);
    assert.match(
      s.rawStdout,
      /"id":42/,
      `expected a reply for id 42 on stdout before exit, got: ${JSON.stringify(s.rawStdout)}`,
    );
  });
});

// --- Protocol errors -----------------------------------------------------------

test("tools/call with an unknown tool name gives error -32602", async () => {
  await withSession(REPO_ROOT, async (s) => {
    await initialize(s);
    s.sendRequest("tools/call", { name: "not_a_real_tool", arguments: {} }, 8);
    const msg = await s.nextMessage();
    assert.equal(msg.result, undefined);
    assert.equal(msg.error.code, -32602);
  });
});

test("an unknown method gives error -32601", async () => {
  await withSession(REPO_ROOT, async (s) => {
    await initialize(s);
    s.sendRequest("not/a/real/method", {}, 9);
    const msg = await s.nextMessage();
    assert.equal(msg.error.code, -32601);
  });
});

test("malformed JSON gives error -32700", async () => {
  await withSession(REPO_ROOT, async (s) => {
    await initialize(s);
    s.writeLine("{not valid json");
    const msg = await s.nextMessage();
    assert.equal(msg.error.code, -32700);
  });
});

// --- resources/list and resources/read ------------------------------------------

const RULES_DIR = join(REPO_ROOT, "rules");
function ruleFileCount(): number {
  return readdirSync(RULES_DIR).filter((f) => f.endsWith(".json") && f !== "schema.json").length;
}

test("resources/list returns one entry per rule record plus the catalog", async () => {
  await withSession(REPO_ROOT, async (s) => {
    await initialize(s);
    s.sendRequest("resources/list", {}, 10);
    const msg = await s.nextMessage();
    const resources = msg.result.resources;
    assert.equal(resources.length, ruleFileCount() + 1);
    assert.ok(resources.some((r: any) => r.uri === "adg://rules"));
    for (const r of resources) {
      assert.equal(r.mimeType, "application/json");
      assert.equal(typeof r.name, "string");
    }
  });
});

test("resources/read for one rule returns JSON that parses and carries that rule's id", async () => {
  await withSession(REPO_ROOT, async (s) => {
    await initialize(s);
    s.sendRequest("resources/read", { uri: "adg://rules/commit-before-mutation" }, 11);
    const msg = await s.nextMessage();
    const record = JSON.parse(msg.result.contents[0].text);
    assert.equal(record.id, "commit-before-mutation");
    assert.equal(msg.result.contents[0].mimeType, "application/json");
  });
});

test("resources/read for the catalog returns every rule as one JSON array", async () => {
  await withSession(REPO_ROOT, async (s) => {
    await initialize(s);
    s.sendRequest("resources/read", { uri: "adg://rules" }, 12);
    const msg = await s.nextMessage();
    const records = JSON.parse(msg.result.contents[0].text);
    assert.equal(records.length, ruleFileCount());
  });
});

test("resources/read for an unknown uri gives error -32002", async () => {
  await withSession(REPO_ROOT, async (s) => {
    await initialize(s);
    s.sendRequest("resources/read", { uri: "adg://rules/not-a-real-rule" }, 13);
    const msg = await s.nextMessage();
    assert.equal(msg.error.code, -32002);
  });
});

// --- Every byte on stdout is JSON-RPC -------------------------------------------

test("every byte written to stdout across a session parses as JSON-RPC", async () => {
  await withSession(REPO_ROOT, async (s) => {
    await initialize(s);
    s.sendRequest("tools/list", {}, 20);
    await s.nextMessage();
    s.sendRequest("resources/list", {}, 21);
    await s.nextMessage();
    s.sendRequest("tools/call", { name: "validate_report", arguments: { text: REPORT_WITH_FINDINGS } }, 22);
    await s.nextMessage();
    s.sendNotification("notifications/initialized");
    s.writeLine("{also not valid");
    await s.nextMessage();

    const raw = s.rawStdout;
    const lines = raw.split("\n").filter((l) => l.length > 0);
    assert.ok(lines.length >= 5);
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line), `line was not valid JSON: ${line}`);
    }
  });
});

// --- Path confinement -----------------------------------------------------------

test("validate_report refuses a path outside the working directory", async () => {
  await withTempDir(async (dir) => {
    // A report that exists, but outside `dir`: this repository's own
    // README, well clear of the temp directory used as the working
    // directory below.
    const outside = join(REPO_ROOT, "README.md");
    await withSession(dir, async (s) => {
      await initialize(s);
      s.sendRequest("tools/call", { name: "validate_report", arguments: { path: outside } }, 30);
      const msg = await s.nextMessage();
      assert.equal(msg.error, undefined, "a bad path is the tool's own failure, not a protocol error");
      assert.equal(msg.result.isError, true);
      assert.match(msg.result.content[0].text, /outside/);
    });
  });
});

test("validate_report accepts a path inside the working directory", async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, "report.md"), REPORT_WITH_NO_FINDINGS);
    await withSession(dir, async (s) => {
      await initialize(s);
      s.sendRequest("tools/call", { name: "validate_report", arguments: { path: "report.md" } }, 31);
      const msg = await s.nextMessage();
      assert.equal(msg.result.isError, false);
      assert.match(msg.result.content[0].text, /no findings/i);
    });
  });
});

// --- templates/mcp.json ---------------------------------------------------------

test("templates/mcp.json parses and names a real subcommand", () => {
  const parsed = JSON.parse(readFileSync(join(REPO_ROOT, "templates", "mcp.json"), "utf8"));
  const entry = parsed.mcpServers["agent-delivery-gates"];
  assert.equal(entry.command, "npx");
  assert.ok(entry.args.includes("mcp"));

  const adgSource = readFileSync(join(REPO_ROOT, "bin", "adg.ts"), "utf8");
  assert.match(adgSource, /case "mcp":/);
});
