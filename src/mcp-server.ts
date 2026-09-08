// Core message handling for the agent-delivery-gates MCP server. Takes one
// line of JSON-RPC text at a time and returns the line to write back, or
// null for a notification, which gets no reply at all. The transport
// (hooks/mcp-server.ts) owns stdin/stdout and never touches the protocol
// itself; this file owns the protocol and never touches a stream.
//
// This server is advisory. It exposes the rule catalog as resources and two
// checks as tools so an agent that speaks MCP can reach them when it
// chooses to. Nothing here runs on its own and nothing here blocks a tool
// call the way a hook does; an agent that never calls a tool here has not
// broken any rule this file enforces, because this file enforces none.
//
// Protocol notes taken from the Model Context Protocol specification,
// version 2025-06-18: JSON-RPC 2.0, one object per line, newline
// delimited. A message with no "id" property is a notification and must
// never receive a reply, whatever its method. An unknown method is
// -32601, bad params -32602, malformed JSON -32700, a failure inside this
// server -32603, and an unknown resource uri -32002 (used by resources/read
// only; nothing else in this server needs it).

import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { checkPathAllowed } from "./path-allowlist.ts";
import { validateReport, formatFindingText } from "./report-validator.ts";
import { separateTestDiff, formatSignalText, type RuleSet } from "./test-diff-separator.ts";
import { ConfigError, loadRuleSet, resolveConfigPath } from "./test-diff-config.ts";

export const PROTOCOL_VERSION = "2025-06-18";

// --- Context ------------------------------------------------------------

export interface McpContext {
  /** The installed package's own root, where rules/ and package.json live. */
  packageRoot: string;
  /** The directory tool calls resolve a path against and may never read
   * outside of. This is the project the server was started in, not this
   * package's own root, when the two differ (an install under
   * node_modules, for instance). */
  workingDir: string;
  version: string;
}

export function buildContext(packageRoot: string, workingDir: string): McpContext {
  const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version?: string };
  return { packageRoot, workingDir, version: pkg.version ?? "0.0.0" };
}

// --- Rule catalog ---------------------------------------------------------

interface RuleRecord {
  id: string;
  name: string;
  [key: string]: unknown;
}

/** Every rule record under rules/, minus the schema itself, sorted by id so
 * the catalog reads the same way on every run. */
function loadRuleRecords(ctx: McpContext): RuleRecord[] {
  const rulesDir = join(ctx.packageRoot, "rules");
  const files = readdirSync(rulesDir).filter((f) => f.endsWith(".json") && f !== "schema.json");
  const records = files.map((f) => JSON.parse(readFileSync(join(rulesDir, f), "utf8")) as RuleRecord);
  records.sort((a, b) => a.id.localeCompare(b.id));
  return records;
}

function ruleResourceUri(id: string): string {
  return `adg://rules/${id}`;
}

const CATALOG_URI = "adg://rules";

// --- JSON-RPC message forms --------------------------------------------------------

interface JsonRpcError {
  code: number;
  message: string;
}

type JsonRpcId = string | number | null;

interface ParsedMessage {
  hasId: boolean;
  id: JsonRpcId;
  method?: unknown;
  params?: unknown;
}

function ok(id: JsonRpcId, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function err(id: JsonRpcId, error: JsonRpcError): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error });
}

function errorObj(code: number, message: string): JsonRpcError {
  return { code, message };
}

// --- Tool schemas and descriptions ------------------------------------------

const VALIDATE_REPORT_TOOL = {
  name: "validate_report",
  title: "Validate delivery report",
  description:
    "Checks a delivery report's claims against the rules in src/report-validator.ts: an unproven robustness claim, evidence that will not outlive the conversation that produced it, a findings section missing its Low or Info entries, a missing commit line, or a prior open finding dropped from this report. Advisory: nothing calls this on its own, an agent calls it when it wants the check run. Give exactly one of 'text' or 'path'.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "The report's own text." },
      path: {
        type: "string",
        description:
          "Path to a file holding the report, resolved against the server's working directory. Refused when it resolves outside that directory.",
      },
      prior_finding_ids: {
        type: "array",
        items: { type: "string" },
        description: "Ids of findings a prior report left open, one per entry. Fires when one does not appear anywhere in this report.",
      },
    },
    additionalProperties: false,
  },
};

const SEPARATE_TEST_DIFF_TOOL = {
  name: "separate_test_diff",
  title: "Separate test diff from source diff",
  description:
    "Splits a unified diff into its source half and its test half using src/test-diff-separator.ts, and reports weakening signals found in the test files alone: a removed assertion, a weakened one, a removed test case, a rename that declassifies a test file, an added skip, a widened tolerance, a raised timeout. Advisory: nothing calls this on its own, an agent calls it when it wants the check run. Give exactly one of 'revision', 'range', or 'diff_text'.",
  inputSchema: {
    type: "object",
    properties: {
      revision: { type: "string", description: "A git revision; the diff that one commit introduced is checked." },
      range: { type: "string", description: "A git revision range, e.g. 'main..HEAD'." },
      diff_text: { type: "string", description: "Unified diff text, checked directly with no git call." },
    },
    additionalProperties: false,
  },
};

const TOOLS = [VALIDATE_REPORT_TOOL, SEPARATE_TEST_DIFF_TOOL];

// --- Path resolution, refusing anything outside the working directory -------

interface ResolvedPath {
  ok: true;
  realPath: string;
}
interface DeniedPath {
  ok: false;
  message: string;
}

/** Resolves a tool-supplied path against the working directory and refuses
 * anything that lands outside it, the same reasoning src/path-allowlist.ts
 * applies to a hook's tool calls: a symlink can point a path that reads as
 * local somewhere else, so the check runs on the resolved real path, never
 * on the string as given. */
function resolveWithinWorkingDir(candidate: string, ctx: McpContext): ResolvedPath | DeniedPath {
  const decision = checkPathAllowed(candidate, [ctx.workingDir], realpathSync, ctx.workingDir);
  if (!decision.allowed) {
    return { ok: false, message: decision.message };
  }
  return { ok: true, realPath: decision.realPath };
}

// --- Tool results -----------------------------------------------------------

interface ToolContentBlock {
  type: "text";
  text: string;
}

interface ToolResult {
  content: ToolContentBlock[];
  isError: boolean;
}

function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], isError };
}

function toolError(message: string): ToolResult {
  return textResult(message, true);
}

// --- validate_report ----------------------------------------------------------

function runValidateReport(args: Record<string, unknown>, ctx: McpContext): ToolResult {
  const hasText = typeof args.text === "string";
  const hasPath = typeof args.path === "string";
  if (hasText === hasPath) {
    return toolError("give exactly one of 'text' or 'path'");
  }

  let reportText: string;
  if (hasPath) {
    const path = args.path as string;
    const resolved = resolveWithinWorkingDir(path, ctx);
    if (!resolved.ok) return toolError(resolved.message);
    try {
      reportText = readFileSync(resolved.realPath, "utf8");
    } catch (e) {
      return toolError(`could not read '${path}' (${(e as Error).message})`);
    }
  } else {
    reportText = args.text as string;
  }

  if (reportText.trim() === "") {
    return toolError("the report is empty; nothing to validate");
  }

  const priorFindingIds = Array.isArray(args.prior_finding_ids)
    ? args.prior_finding_ids.filter((v): v is string => typeof v === "string")
    : [];

  const findings = validateReport(reportText, { priorFindingIds });

  if (findings.length === 0) {
    return textResult("No findings. Every check in src/report-validator.ts passed.");
  }
  const lines = findings.map(formatFindingText);
  return textResult(`${findings.length} finding(s):\n${lines.join("\n")}`);
}

// --- separate_test_diff --------------------------------------------------------

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  return env;
}

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, env: gitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function tryResolveRepoRoot(cwd: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      env: gitEnv(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return undefined;
  }
}

function resolveRules(ctx: McpContext): RuleSet | { error: string } {
  const repoRoot = tryResolveRepoRoot(ctx.workingDir);
  const configPath = resolveConfigPath({ env: process.env, repoRoot });
  try {
    return loadRuleSet(configPath);
  } catch (e) {
    if (e instanceof ConfigError) return { error: `config: ${e.message}` };
    throw e;
  }
}

function runSeparateTestDiff(args: Record<string, unknown>, ctx: McpContext): ToolResult {
  const given = ["revision", "range", "diff_text"].filter(
    (key) => typeof args[key] === "string",
  );
  if (given.length !== 1) {
    return toolError("give exactly one of 'revision', 'range', or 'diff_text'");
  }

  let diffText: string;
  if (typeof args.diff_text === "string") {
    diffText = args.diff_text;
  } else {
    try {
      diffText =
        typeof args.revision === "string"
          ? runGit(["diff-tree", "-p", "--no-color", "--root", "-r", args.revision], ctx.workingDir)
          : runGit(["diff", "--no-color", args.range as string], ctx.workingDir);
    } catch (e) {
      const detail = (e as { stderr?: string; message?: string }).stderr || (e as Error).message;
      return toolError(`git failed: ${detail}`);
    }
  }

  if (diffText.trim() === "") {
    return textResult("The diff is empty. No source or test files changed.");
  }

  const rules = resolveRules(ctx);
  if ("error" in rules) return toolError(rules.error);

  const result = separateTestDiff(diffText, { rules });

  const lines: string[] = [];
  lines.push(
    result.sourceFiles.length === 0
      ? "Source: no source files changed."
      : `Source (${result.sourceFiles.length} file(s), +${result.sourceAdded} -${result.sourceRemoved}):`,
  );
  for (const f of result.sourceFiles) lines.push(`  ${f.path}  +${f.added} -${f.removed}`);
  lines.push(
    result.testFiles.length === 0
      ? "Test: no test files changed."
      : `Test (${result.testFiles.length} file(s), +${result.testAdded} -${result.testRemoved}):`,
  );
  for (const f of result.testFiles) lines.push(`  ${f.path}  +${f.added} -${f.removed}`);
  lines.push(result.signals.length === 0 ? "Signals: none found." : `Signals (${result.signals.length}):`);
  for (const signal of result.signals) lines.push(`  ${formatSignalText(signal)}`);

  return textResult(lines.join("\n"), false);
}

// --- Method handlers ----------------------------------------------------------

const SERVER_INSTRUCTIONS =
  "agent-delivery-gates is advisory, not enforcement: it exposes a rule catalog as resources " +
  "and two checks as tools. Nothing here runs on its own and no tool call here blocks anything; " +
  "call a tool when you want its check run against your own work, the same way you would run it " +
  "from the command line. validate_report checks a delivery report's claims. separate_test_diff " +
  "splits a diff into its source and test halves and reports weakening signals found in the test " +
  "files alone. Read adg://rules for the full rule catalog, or adg://rules/<id> for one record.";

function handleInitialize(params: unknown, ctx: McpContext): unknown {
  const requested =
    typeof params === "object" && params !== null && typeof (params as Record<string, unknown>).protocolVersion === "string"
      ? ((params as Record<string, unknown>).protocolVersion as string)
      : undefined;
  const protocolVersion = requested === PROTOCOL_VERSION ? requested : PROTOCOL_VERSION;
  return {
    protocolVersion,
    capabilities: { resources: {}, tools: {} },
    serverInfo: { name: "agent-delivery-gates", version: ctx.version },
    instructions: SERVER_INSTRUCTIONS,
  };
}

function handleToolsList(): unknown {
  return { tools: TOOLS };
}

function handleToolsCall(params: unknown): { ok: true; value: unknown } | { ok: false; error: JsonRpcError } {
  if (typeof params !== "object" || params === null) {
    return { ok: false, error: errorObj(-32602, "params must be an object") };
  }
  const p = params as Record<string, unknown>;
  const name = p.name;
  if (typeof name !== "string") {
    return { ok: false, error: errorObj(-32602, "params.name must be a string") };
  }
  const args = typeof p.arguments === "object" && p.arguments !== null ? (p.arguments as Record<string, unknown>) : {};

  return { ok: true, value: { name, args } };
}

function handleResourcesList(ctx: McpContext): unknown {
  const records = loadRuleRecords(ctx);
  const resources = [
    {
      uri: CATALOG_URI,
      name: "rule-catalog",
      title: "Rule catalog",
      description: "Every gate rule record, as one JSON array.",
      mimeType: "application/json",
    },
    ...records.map((r) => ({
      uri: ruleResourceUri(r.id),
      name: r.id,
      title: r.name,
      description: typeof r.proof_obligation === "string" ? r.proof_obligation : r.name,
      mimeType: "application/json",
    })),
  ];
  return { resources };
}

function handleResourcesRead(
  params: unknown,
  ctx: McpContext,
): { ok: true; value: unknown } | { ok: false; error: JsonRpcError } {
  if (typeof params !== "object" || params === null || typeof (params as Record<string, unknown>).uri !== "string") {
    return { ok: false, error: errorObj(-32602, "params.uri must be a string") };
  }
  const uri = (params as Record<string, unknown>).uri as string;

  if (uri === CATALOG_URI) {
    const records = loadRuleRecords(ctx);
    return {
      ok: true,
      value: { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(records, null, 2) }] },
    };
  }

  if (uri.startsWith("adg://rules/")) {
    const id = uri.slice("adg://rules/".length);
    const records = loadRuleRecords(ctx);
    const record = records.find((r) => r.id === id);
    if (record !== undefined) {
      return {
        ok: true,
        value: { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(record, null, 2) }] },
      };
    }
  }

  return { ok: false, error: errorObj(-32002, `unknown resource uri '${uri}'`) };
}

// --- Message dispatch -----------------------------------------------------

/** Parses one line of input into its JSON-RPC form. Returns null when the
 * line is blank, which carries no message at all and is not itself a parse
 * error: a stray blank line between messages is normal on some transports. */
function parseLine(raw: string): { ok: true; msg: ParsedMessage } | { ok: false } | null {
  if (raw.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false };
  }
  const obj = parsed as Record<string, unknown>;
  const hasId = Object.prototype.hasOwnProperty.call(obj, "id");
  const id = hasId ? (obj.id as JsonRpcId) : null;
  return { ok: true, msg: { hasId, id, method: obj.method, params: obj.params } };
}

/**
 * Handles one line of JSON-RPC input and returns the line to write back, or
 * null when nothing should be written: a blank input line, or a message
 * with no "id", which JSON-RPC defines as a notification and which this
 * server never replies to, whatever its method.
 */
export function handleLine(raw: string, ctx: McpContext): string | null {
  const parsed = parseLine(raw);
  if (parsed === null) return null;
  if (!parsed.ok) {
    // A malformed line carries no id to reply against; the specification's
    // own examples reply with id: null in exactly this case.
    return err(null, errorObj(-32700, "parse error: line was not a single JSON object"));
  }

  const { msg } = parsed;
  const method = msg.method;

  if (typeof method !== "string") {
    if (!msg.hasId) return null;
    return err(msg.id, errorObj(-32601, "method missing or not a string"));
  }

  // A notification, by JSON-RPC definition, carries no "id" and receives no
  // reply at all, regardless of which method it names.
  if (!msg.hasId) return null;

  try {
    return dispatch(method, msg, ctx);
  } catch (e) {
    // A failure inside this server, not a failure of the request it was
    // asked to run (a tool's own failure is reported as isError: true in a
    // normal result, never here). The request still carried an id and
    // still deserves a reply; dropping it silently would leave the client
    // waiting on a request that will never resolve.
    return err(msg.id, errorObj(-32603, `internal error: ${(e as Error).message}`));
  }
}

function dispatch(method: string, msg: ParsedMessage, ctx: McpContext): string | null {
  switch (method) {
    case "initialize":
      return ok(msg.id, handleInitialize(msg.params, ctx));

    case "tools/list":
      return ok(msg.id, handleToolsList());

    case "tools/call": {
      const parsedCall = handleToolsCall(msg.params);
      if (!parsedCall.ok) return err(msg.id, parsedCall.error);
      const { name, args } = parsedCall.value as { name: string; args: Record<string, unknown> };
      let result: ToolResult;
      switch (name) {
        case "validate_report":
          result = runValidateReport(args, ctx);
          break;
        case "separate_test_diff":
          result = runSeparateTestDiff(args, ctx);
          break;
        default:
          return err(msg.id, errorObj(-32602, `unknown tool '${name}'`));
      }
      return ok(msg.id, result);
    }

    case "resources/list":
      return ok(msg.id, handleResourcesList(ctx));

    case "resources/read": {
      const read = handleResourcesRead(msg.params, ctx);
      if (!read.ok) return err(msg.id, read.error);
      return ok(msg.id, read.value);
    }

    default:
      return err(msg.id, errorObj(-32601, `unknown method '${method}'`));
  }
}
