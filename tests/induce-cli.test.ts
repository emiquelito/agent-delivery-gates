// Tests for hooks/induce.ts. Every test builds a real directory in
// os.tmpdir(), writes real spec files, and spawns the CLI as a real
// subprocess that runs real commands. Nothing is mocked, and nothing
// touches this repository's own tree.
//
// The scratch project is the worked example from
// docs/examples/07-a-retry-that-never-retries.md, in Node: a client that
// treats a 503 as a failure and one that hands the error body back as if
// it were a quote. The check asserts a user-observable outcome, the quote
// file on disk, and never an internal value.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(HERE, "..", "hooks", "induce.ts");

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(cwd: string, args: string[]): RunResult {
  const result = spawnSync("node", [CLI_PATH, ...args], { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// A transport that always answers 503 with a JSON body, and counts what
// went out. This is what induces the failure.
const TRANSPORT = `export function makeTransport() {
  let calls = 0;
  return {
    calls: () => calls,
    get() {
      calls++;
      return { status: 503, body: { error: "upstream unavailable" } };
    },
  };
}
`;

// The client with the handling in place: a 503 is a failure, it is retried
// three times, and it never comes back as a quote.
const CLIENT = `export function fetchQuote(transport) {
  let attempt = 0;
  while (attempt < 3) {
    attempt++;
    const response = transport.get();
    if (response.status >= 500) continue;
    return response.body;
  }
  throw new Error("quote service failed after 3 attempts");
}
`;

// The same client with the handling taken away: the 503 body parses fine,
// so the caller is handed an error payload where a quote was expected, and
// only one call ever goes out.
const CLIENT_WITHOUT_HANDLING = `export function fetchQuote(transport) {
  const response = transport.get();
  return response.body;
}
`;

// The check: induce the 503, then assert what a user would see. The quote
// file must not be on disk, and three calls must have gone out.
const CHECK = `import { existsSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { makeTransport } from "./src/transport.mjs";

const modulePath = process.argv[2];
const { fetchQuote } = await import(modulePath);

rmSync("out", { recursive: true, force: true });
mkdirSync("out", { recursive: true });
const transport = makeTransport();
try {
  const quote = fetchQuote(transport);
  writeFileSync("out/quote.json", JSON.stringify(quote));
} catch {
  // A failed fetch writes no quote, which is the point.
}

const wroteAQuote = existsSync("out/quote.json");
const calls = transport.calls();
if (wroteAQuote) {
  console.log("a 503 body was written out as a quote");
  process.exit(1);
}
if (calls !== 3) {
  console.log("outbound calls: " + calls + ", expected 3");
  process.exit(1);
}
console.log("no quote written, outbound calls: " + calls);
`;

// The check that measures nothing: it asks only that the client was called
// and that the process did not crash. Both clients satisfy that, so it
// would pass if the handling produced nothing at all.
const WEAK_CHECK = `import { makeTransport } from "./src/transport.mjs";

const modulePath = process.argv[2];
const { fetchQuote } = await import(modulePath);

const transport = makeTransport();
try {
  fetchQuote(transport);
} catch {
  // Either way counts, which is the problem.
}
if (transport.calls() < 1) process.exit(1);
console.log("the client ran");
`;

const HAPPY_PATH = `console.log("happy path ok");
`;

function makeProject(specs: Record<string, unknown>, extra: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "adg-induce-cli-test-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, ".adg", "induced"), { recursive: true });
  writeFileSync(join(dir, "src", "transport.mjs"), TRANSPORT);
  writeFileSync(join(dir, "src", "client.mjs"), CLIENT);
  writeFileSync(join(dir, "src", "client-without-handling.mjs"), CLIENT_WITHOUT_HANDLING);
  writeFileSync(join(dir, "check.mjs"), CHECK);
  writeFileSync(join(dir, "weak-check.mjs"), WEAK_CHECK);
  writeFileSync(join(dir, "happy-path.mjs"), HAPPY_PATH);
  for (const [name, spec] of Object.entries(specs)) {
    const text = typeof spec === "string" ? spec : `${JSON.stringify(spec, null, 2)}\n`;
    writeFileSync(join(dir, ".adg", "induced", name), text);
  }
  for (const [path, content] of Object.entries(extra)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

function withProject(dir: string, fn: () => void): void {
  try {
    fn();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PROVEN_SPEC = {
  claim: "A 503 from the quote service is retried three times and never comes back as a quote.",
  inject: "node check.mjs ./src/client.mjs",
  neutralize: "node check.mjs ./src/client-without-handling.mjs",
};

const NOT_MEASURING_SPEC = {
  claim: "A 503 from the quote service is retried three times and never comes back as a quote.",
  inject: "node weak-check.mjs ./src/client.mjs",
  neutralize: "node weak-check.mjs ./src/client-without-handling.mjs",
};

const DID_NOT_FIRE_SPEC = {
  claim: "A 503 from the quote service is retried three times and never comes back as a quote.",
  inject: "node check.mjs ./src/client-without-handling.mjs",
  neutralize: "node check.mjs ./src/client-without-handling.mjs",
};

// --- the four verdicts, against real commands ---------------------------------

test("proven: the check passes with the handling and fails without it, exit 0", () => {
  const dir = makeProject({ "retry.json": PROVEN_SPEC });
  withProject(dir, () => {
    const result = runCli(dir, []);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /proven 1, handler-did-not-fire 0, check-does-not-measure 0, could-not-run 0/);
    assert.match(result.stdout, /Verdict: proven/);
    assert.match(result.stdout, /Every spec was proven/);
  });
});

test("the evidence block names the claim and both commands, so a report can cite them", () => {
  const dir = makeProject({ "retry.json": PROVEN_SPEC });
  withProject(dir, () => {
    const result = runCli(dir, []);
    assert.match(result.stdout, /Claim: A 503 from the quote service is retried three times/);
    assert.match(result.stdout, /inject\s+node check\.mjs \.\/src\/client\.mjs/);
    assert.match(result.stdout, /neutralize\s+node check\.mjs \.\/src\/client-without-handling\.mjs/);
    assert.match(result.stdout, /passed \(exit 0/);
    assert.match(result.stdout, /failed \(exit 1/);
  });
});

test("handler-did-not-fire: the inject run failed, exit 1", () => {
  const dir = makeProject({ "retry.json": DID_NOT_FIRE_SPEC });
  withProject(dir, () => {
    const result = runCli(dir, []);
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.match(result.stdout, /Verdict: handler-did-not-fire/);
    assert.match(result.stdout, /never seen to fire/);
  });
});

test("check-does-not-measure: the check passes with the handling taken away, exit 1", () => {
  const dir = makeProject({ "retry.json": NOT_MEASURING_SPEC });
  withProject(dir, () => {
    const result = runCli(dir, []);
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.match(result.stdout, /Verdict: check-does-not-measure/);
    assert.match(result.stdout, /would pass if the handling produced nothing/);
  });
});

test("could-not-run: a command that does not exist is not a control that worked, exit 2", () => {
  const dir = makeProject({
    "retry.json": { ...PROVEN_SPEC, neutralize: "definitely-not-a-real-command-here" },
  });
  withProject(dir, () => {
    const result = runCli(dir, []);
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stdout, /Verdict: could-not-run/);
    assert.match(result.stdout, /could not be executed/);
  });
});

// --- refusals -----------------------------------------------------------------

test("a spec with no neutralize is refused with exit 2 and never reports proven", () => {
  const dir = makeProject({
    "retry.json": { claim: PROVEN_SPEC.claim, inject: PROVEN_SPEC.inject },
  });
  withProject(dir, () => {
    const result = runCli(dir, []);
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stdout, /missing 'neutralize'/);
    assert.match(result.stdout, /not optional/);
    assert.doesNotMatch(result.stdout, /Verdict: proven/);
  });
});

test("a malformed spec is refused with exit 2", () => {
  const dir = makeProject({ "retry.json": "{ this is not json\n" });
  withProject(dir, () => {
    const result = runCli(dir, []);
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stdout, /not valid JSON/);
  });
});

test("an unknown field is refused with exit 2, naming the field", () => {
  const dir = makeProject({ "retry.json": { ...PROVEN_SPEC, injects: "typo" } });
  withProject(dir, () => {
    const result = runCli(dir, []);
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stdout, /unknown field 'injects'/);
  });
});

test("a missing spec directory is refused with exit 2 on stderr", () => {
  const dir = makeProject({});
  withProject(dir, () => {
    const result = runCli(dir, ["--dir", "no/such/place"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /could not read the spec directory/);
  });
});

test("a spec directory with no spec in it is refused, never reported as a clean run", () => {
  const dir = makeProject({});
  withProject(dir, () => {
    const result = runCli(dir, []);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /nothing to run/);
  });
});

test("a --spec path that does not exist is refused with exit 2", () => {
  const dir = makeProject({ "retry.json": PROVEN_SPEC });
  withProject(dir, () => {
    const result = runCli(dir, ["--spec", "no-such-spec.json"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /could not read the spec/);
  });
});

test("--dir and --spec together is a bad argument, exit 2", () => {
  const dir = makeProject({ "retry.json": PROVEN_SPEC });
  withProject(dir, () => {
    const result = runCli(dir, ["--dir", ".adg/induced", "--spec", ".adg/induced/retry.json"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /not both/);
  });
});

test("an unknown argument is refused with exit 2", () => {
  const dir = makeProject({ "retry.json": PROVEN_SPEC });
  withProject(dir, () => {
    const result = runCli(dir, ["--not-a-flag"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown argument/);
  });
});

// --- the baseline -------------------------------------------------------------

test("a passing baseline runs first and does not change a proven verdict", () => {
  const dir = makeProject({
    "retry.json": { ...PROVEN_SPEC, baseline: "node happy-path.mjs" },
  });
  withProject(dir, () => {
    const result = runCli(dir, []);
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /baseline\s+node happy-path\.mjs/);
    assert.match(result.stdout, /Verdict: proven/);
  });
});

test("a failing baseline stops the run: exit 2, and the later steps never ran", () => {
  const dir = makeProject({
    "retry.json": { ...PROVEN_SPEC, baseline: "node -e 'process.exit(1)'" },
  });
  withProject(dir, () => {
    const result = runCli(dir, []);
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stdout, /Verdict: could-not-run/);
    assert.match(result.stdout, /baseline was already failing/);
    assert.match(result.stdout, /not-run \(never ran/);
  });
});

// --- the timeout --------------------------------------------------------------

test("a command that hits the timeout gets its own outcome and exit 3, never a fail", () => {
  const dir = makeProject({
    "slow.json": {
      claim: "A slow check is not a failed check.",
      inject: "node -e 'setTimeout(() => {}, 10000)'",
      neutralize: "node -e 'process.exit(1)'",
    },
  });
  withProject(dir, () => {
    const result = runCli(dir, ["--timeout", "1"]);
    assert.equal(result.status, 3, result.stdout);
    assert.match(result.stdout, /timed-out \(timed out/);
    assert.match(result.stdout, /Verdict: could-not-run/);
    assert.match(result.stdout, /hit the timeout/);
    assert.doesNotMatch(result.stdout, /handler-did-not-fire: /);
  });
});

test("a spec's own timeout overrides the default", () => {
  const dir = makeProject({
    "slow.json": {
      claim: "A slow check is not a failed check.",
      inject: "node -e 'setTimeout(() => {}, 10000)'",
      neutralize: "node -e 'process.exit(1)'",
      timeout: 1,
    },
  });
  withProject(dir, () => {
    const result = runCli(dir, ["--timeout", "600"]);
    assert.equal(result.status, 3, result.stdout);
    assert.match(result.stdout, /timed-out/);
  });
});

// --- several specs at once ----------------------------------------------------

test("several specs: one not proven among three, exit 1, and every verdict is reported", () => {
  const dir = makeProject({
    "a-retry.json": PROVEN_SPEC,
    "b-weak.json": NOT_MEASURING_SPEC,
    "c-retry.json": { ...PROVEN_SPEC, claim: "The same failure, checked a second way." },
  });
  withProject(dir, () => {
    const result = runCli(dir, []);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /proven 2, handler-did-not-fire 0, check-does-not-measure 1, could-not-run 0/);
    assert.match(result.stdout, /a-retry\.json/);
    assert.match(result.stdout, /b-weak\.json/);
    assert.match(result.stdout, /c-retry\.json/);
  });
});

test("a proven spec beside a timed-out one is exit 3, not exit 0", () => {
  const dir = makeProject({
    "a-retry.json": PROVEN_SPEC,
    "b-slow.json": {
      claim: "A slow check is not a failed check.",
      inject: "node -e 'setTimeout(() => {}, 10000)'",
      neutralize: "node -e 'process.exit(1)'",
      timeout: 1,
    },
  });
  withProject(dir, () => {
    const result = runCli(dir, []);
    assert.equal(result.status, 3, result.stdout);
    assert.match(result.stdout, /proven 1/);
    assert.match(result.stdout, /never judged/);
  });
});

test("a finding beside a timed-out spec is exit 1: the finding wins", () => {
  const dir = makeProject({
    "a-weak.json": NOT_MEASURING_SPEC,
    "b-slow.json": {
      claim: "A slow check is not a failed check.",
      inject: "node -e 'setTimeout(() => {}, 10000)'",
      neutralize: "node -e 'process.exit(1)'",
      timeout: 1,
    },
  });
  withProject(dir, () => {
    const result = runCli(dir, []);
    assert.equal(result.status, 1, result.stdout);
  });
});

// --- options ------------------------------------------------------------------

test("--spec runs exactly the spec named", () => {
  const dir = makeProject({ "a-retry.json": PROVEN_SPEC, "b-weak.json": NOT_MEASURING_SPEC });
  withProject(dir, () => {
    const result = runCli(dir, ["--spec", ".adg/induced/a-retry.json"]);
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /proven 1/);
    assert.doesNotMatch(result.stdout, /b-weak\.json/);
  });
});

test("--format json parses, and carries the verdict, the steps and the exit codes", () => {
  const dir = makeProject({ "retry.json": PROVEN_SPEC });
  withProject(dir, () => {
    const result = runCli(dir, ["--format", "json"]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as {
      summary: Record<string, number>;
      runs: { verdict: string; claim: string; steps: { step: string; command: string; exitCode: number | null }[] }[];
    };
    assert.equal(parsed.summary.proven, 1);
    assert.equal(parsed.runs[0].verdict, "proven");
    assert.match(parsed.runs[0].claim, /retried three times/);
    assert.deepEqual(
      parsed.runs[0].steps.map((s) => s.step),
      ["inject", "neutralize"],
    );
    assert.equal(parsed.runs[0].steps[0].exitCode, 0);
    assert.equal(parsed.runs[0].steps[1].exitCode, 1);
  });
});

test("a spec's cwd is where its commands run", () => {
  const dir = makeProject(
    {
      "nested.json": {
        claim: "The commands run where the spec says.",
        inject: "node -e 'process.exit(require(\"node:fs\").existsSync(\"marker.txt\") ? 0 : 1)'",
        neutralize: "node -e 'process.exit(1)'",
        cwd: "nested",
      },
    },
    { "nested/marker.txt": "here\n" },
  );
  withProject(dir, () => {
    const result = runCli(dir, []);
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /Verdict: proven/);
  });
});

test("a cwd that is not a directory is refused with exit 2", () => {
  const dir = makeProject({ "bad-cwd.json": { ...PROVEN_SPEC, cwd: "no/such/dir" } });
  withProject(dir, () => {
    const result = runCli(dir, []);
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stdout, /is not a directory/);
  });
});

// --- help ---------------------------------------------------------------------

test("--help exits 0 and says what this command does not do", () => {
  const dir = makeProject({});
  withProject(dir, () => {
    const result = runCli(dir, ["--help"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage: induce/);
    assert.match(result.stdout, /does not read a delivery report/);
    assert.match(result.stdout, /validate-report does not run a\s+spec/);
    assert.match(result.stdout, /cannot tell whether a\s+spec is honest/);
    assert.match(result.stdout, /control is not optional/);
  });
});
