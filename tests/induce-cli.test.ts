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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

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
    assert.match(result.stdout, /Every spec: the inject command passed and the neutralize command failed\./);
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

// --- what the neutralize command said -----------------------------------------
//
// A proven verdict rests on the neutralize command failing, and any failure
// counts: a syntax error in the control script fails just as loudly as a
// control that worked, and the exit code cannot tell them apart. The report
// prints what the command said so a reader can.

test("a proven spec prints the tail of the neutralize output, so a broken control is visible", () => {
  const dir = makeProject(
    {
      "retry.json": {
        ...PROVEN_SPEC,
        neutralize: "node broken-control.mjs",
      },
    },
    { "broken-control.mjs": "this is not( valid javascript\n" },
  );
  withProject(dir, () => {
    const result = runCli(dir, []);
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /Verdict: proven/);
    assert.match(result.stdout, /SyntaxError/);
    assert.match(result.stdout, /Neutralize output, tail/);
    assert.match(result.stdout, /Nothing here checks why it failed/);
  });
});

test("a proven spec's neutralize output reaches --format json", () => {
  const dir = makeProject({ "retry.json": PROVEN_SPEC });
  withProject(dir, () => {
    const result = runCli(dir, ["--format", "json"]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as {
      runs: { steps: { step: string; stdout: string; stderr: string }[] }[];
    };
    const [inject, neutralize] = parsed.runs[0].steps;
    assert.match(inject.stdout, /no quote written, outbound calls: 3/);
    assert.match(neutralize.stdout, /a 503 body was written out as a quote/);
  });
});

test("a proven spec whose neutralize command printed nothing says so, and never leaves the block empty", () => {
  const dir = makeProject({
    "quiet.json": {
      claim: "A control that says nothing is still shown as saying nothing.",
      inject: "node -e 'process.exit(0)'",
      neutralize: "node -e 'process.exit(1)'",
    },
  });
  withProject(dir, () => {
    const result = runCli(dir, []);
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /Neutralize output: nothing was printed/);
  });
});

// --- a command cut off before it could be judged ------------------------------

test("a command printing more than 1 MB is run to the end, not killed and called a timeout", () => {
  const dir = makeProject({
    "loud.json": {
      claim: "A loud check is not a check that ran out of time.",
      inject: "node -e 'process.stdout.write(\"x\".repeat(3000000)); process.exit(0)'",
      neutralize: "node -e 'process.stdout.write(\"y\".repeat(3000000)); process.exit(1)'",
    },
  });
  withProject(dir, () => {
    const result = runCli(dir, []);
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /Verdict: proven/);
    assert.doesNotMatch(result.stdout, /timed-out/);
    assert.doesNotMatch(result.stdout, /hit the timeout/);
  });
});

test("a command killed by a signal is reported as killed and names the signal, never as a timeout", () => {
  const dir = makeProject({
    "killed.json": {
      claim: "A killed check is not a check that ran out of time.",
      inject: "node -e 'process.exit(0)'",
      neutralize: "kill -9 $$",
    },
  });
  withProject(dir, () => {
    const result = runCli(dir, ["--timeout", "120"]);
    assert.equal(result.status, 3, result.stdout);
    assert.match(result.stdout, /killed \(killed by SIGKILL before it finished/);
    assert.match(result.stdout, /Verdict: could-not-run/);
    assert.match(result.stdout, /killed by a signal before it finished/);
    assert.doesNotMatch(result.stdout, /timed-out/);
    assert.doesNotMatch(result.stdout, /hit the timeout/);
    // A control that was killed is never a control that worked.
    assert.doesNotMatch(result.stdout, /Verdict: proven/);
  });
});

test("a command that hits the timeout still reports the timeout, not a signal kill", () => {
  const dir = makeProject({
    "slow.json": {
      claim: "A check that ran out of time is not a killed check.",
      inject: "node -e 'setTimeout(() => {}, 10000)'",
      neutralize: "node -e 'process.exit(1)'",
      timeout: 1,
    },
  });
  withProject(dir, () => {
    const result = runCli(dir, []);
    assert.equal(result.status, 3, result.stdout);
    assert.match(result.stdout, /timed-out \(timed out/);
    assert.match(result.stdout, /hit the timeout/);
    assert.doesNotMatch(result.stdout, /killed by/);
  });
});

// --- entries in the spec directory that were not run --------------------------

test("a near-miss extension is named and counted in the header, never dropped in silence", () => {
  const dir = makeProject({
    "a-good.json": PROVEN_SPEC,
    "b-second.JSON": PROVEN_SPEC,
    "c-third.json.bak": PROVEN_SPEC,
    "d-fourth.jsonc": PROVEN_SPEC,
  });
  withProject(dir, () => {
    const result = runCli(dir, []);
    assert.match(result.stdout, /Not run: 3 entries/);
    for (const name of ["b-second.JSON", "c-third.json.bak", "d-fourth.jsonc"]) {
      assert.ok(result.stdout.includes(name), `${name} is not named in:\n${result.stdout}`);
    }
    assert.match(result.stdout, /proven 1/);
  });
});

test("a directory holding only near misses is refused, and the message names them", () => {
  const dir = makeProject({ "b-second.JSON": PROVEN_SPEC, "c-third.json.bak": PROVEN_SPEC });
  withProject(dir, () => {
    const result = runCli(dir, []);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /nothing to run/);
    assert.match(result.stderr, /b-second\.JSON/);
    assert.match(result.stderr, /c-third\.json\.bak/);
  });
});

test("--spec names no skipped entries, because nothing beside it was looked at", () => {
  const dir = makeProject({ "a-good.json": PROVEN_SPEC, "b-second.JSON": PROVEN_SPEC });
  withProject(dir, () => {
    const result = runCli(dir, ["--spec", ".adg/induced/a-good.json"]);
    assert.equal(result.status, 0, result.stdout);
    assert.doesNotMatch(result.stdout, /Not run:/);
  });
});

// --- what --help discloses ----------------------------------------------------

test("--help says a spec runs shell commands with the caller's privileges", () => {
  const dir = makeProject({});
  withProject(dir, () => {
    const result = runCli(dir, ["--help"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /runs with the\s+privileges of whoever ran this command/);
    assert.match(result.stdout, /Read a spec that came from a\s+repository you did not write/);
    assert.match(result.stdout, /"cwd" is not contained/);
  });
});

test("--help says specs are not isolated from each other and must clean up", () => {
  const dir = makeProject({});
  withProject(dir, () => {
    const result = runCli(dir, ["--help"]);
    assert.match(result.stdout, /share one working directory/);
    assert.match(result.stdout, /clean up after\s+itself/);
  });
});

test("--help says the environment is inherited, not cleaned", () => {
  const dir = makeProject({});
  withProject(dir, () => {
    const result = runCli(dir, ["--help"]);
    assert.match(result.stdout, /environment is inherited from the caller, not cleaned/);
    assert.match(result.stdout, /ADG_RETRY_DISABLED=1/);
  });
});

test("--help says the whole process tree is killed at the timeout, not just the command", () => {
  const dir = makeProject({});
  withProject(dir, () => {
    const result = runCli(dir, ["--help"]);
    assert.match(result.stdout, /whole process tree\s+is killed/);
    assert.match(result.stdout, /worker\s+process it started cannot outlive it/);
  });
});

test("--help says any neutralize failure counts, and that the output tail is there to be read", () => {
  const dir = makeProject({});
  withProject(dir, () => {
    const result = runCli(dir, ["--help"]);
    assert.match(result.stdout, /Any neutralize failure counts/);
    assert.match(result.stdout, /tail of what its neutralize command said/);
  });
});

test("a command printing more than the read buffer holds is an overflow, not a timeout", () => {
  const dir = makeProject({
    "flood.json": {
      claim: "A check that prints without end is never judged.",
      inject: "node -e 'process.exit(0)'",
      neutralize: "yes 0123456789012345678901234567890123456789 | head -c 70000000; exit 1",
    },
  });
  withProject(dir, () => {
    const result = runCli(dir, ["--timeout", "120"]);
    assert.equal(result.status, 3, result.stdout.slice(0, 400));
    assert.match(result.stdout, /output-overflow \(printed more than 64 MB and was killed for it/);
    assert.match(result.stdout, /Verdict: could-not-run/);
    assert.match(result.stdout, /printed more output than this tool will hold/);
    assert.doesNotMatch(result.stdout, /hit the timeout/);
    assert.doesNotMatch(result.stdout, /Verdict: proven/);
  });
});

// --- no descendant survives a timed-out step ---------------------------------

// The same production incident this file's induce spec is not otherwise
// about: spawnSync(command, { shell: true, timeout, killSignal: "SIGKILL" })
// killed only the shell, never a worker process the command itself
// started. This proves the fix directly: a step whose command spawns a
// worker sharing its own process group, and the worker ignores SIGTERM
// and never returns.

const LEAK_RUN_MJS = `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const pidDir = process.argv[2];
const here = dirname(fileURLToPath(import.meta.url));
const worker = spawn(process.execPath, [join(here, "leak-worker.mjs")], { stdio: "ignore" });
writeFileSync(join(pidDir, worker.pid + ".pid"), String(worker.pid));
worker.on("exit", (code) => process.exit(code ?? 0));
`;

const LEAK_WORKER_MJS = `process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`;

function recordedPids(pidDir: string): number[] {
  return readdirSync(pidDir)
    .filter((name) => name.endsWith(".pid"))
    .map((name) => Number(readFileSync(join(pidDir, name), "utf8")));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Polls for up to `budgetMs` for every pid to be gone, then force-kills
 * anything still alive so this test never leaves a process behind, red
 * run or green. Returns the pids still alive when the budget ran out,
 * which is empty exactly when the fix works. */
function waitForNoneAlive(pids: number[], budgetMs: number): number[] {
  const deadline = Date.now() + budgetMs;
  let stillAlive = pids.filter(isAlive);
  while (stillAlive.length > 0 && Date.now() < deadline) {
    spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 50)"], { timeout: 200 });
    stillAlive = pids.filter(isAlive);
  }
  for (const pid of stillAlive) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  return stillAlive;
}

test("a timed-out step leaves no descendant running", () => {
  const pidDir = mkdtempSync(join(tmpdir(), "adg-induce-orphan-pids-"));
  const dir = makeProject(
    {
      "leak.json": {
        claim: "test fixture: a step whose command spawns a worker that never returns",
        inject: `node leak-run.mjs ${pidDir}`,
        neutralize: "node -e \"process.exit(1)\"",
        timeout: 1,
      },
    },
    {
      "leak-run.mjs": LEAK_RUN_MJS,
      "leak-worker.mjs": LEAK_WORKER_MJS,
    },
  );
  withProject(dir, () => {
    try {
      const result = runCli(dir, []);
      const pids = recordedPids(pidDir);
      assert.ok(
        pids.length > 0,
        `expected the step to spawn a worker; induce printed: ${result.stdout}\n${result.stderr}`,
      );
      const survivors = waitForNoneAlive(pids, 5_000);
      assert.deepEqual(survivors, [], "a worker process outlived the timed-out step");
    } finally {
      rmSync(pidDir, { recursive: true, force: true });
    }
  });
});
