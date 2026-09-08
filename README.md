# agent-delivery-gates

Rules that check what an AI coding agent claims about its own work, not just the code it wrote.

A refund module with four passing tests. An agent is asked to record a
timestamp on each refund, does that, and tidies the test layout in the same
commit.

```
$ node --test tests/*.test.js
# tests 0
# pass 0
# fail 0
```

Nothing failed, because nothing ran. `tests/refund.test.js` was renamed to
`tests/refund.spec.helper.js`, the runner collects `tests/*.test.js`, and four
tests stopped being executed while staying in the repository.

Here is everything a reviewer sees:

```
$ git show --stat --format='' HEAD
 src/refund.js                                   | 2 +-
 tests/{refund.test.js => refund.spec.helper.js} | 0
 2 files changed, 1 insertion(+), 1 deletion(-)
```

Zero lines against the test file, and git is right: not one character of it
changed. The source file did change, so this is not a commit that only touches
tests either.

```
$ npx agent-delivery-gates test-diff --rev HEAD
Source diff:
  src/refund.js  +1 -1

Test diff:
  tests/refund.spec.helper.js  +0 -0

Signals (1):
  test-file-declassified high tests/refund.spec.helper.js: a test file was renamed so its basename no longer matches a test naming convention; the file may no longer be collected by the test runner, so its tests stop running while the suite still reports success
    tests/refund.test.js -> tests/refund.spec.helper.js
```

Exit code 1.

Every other check a project runs says this commit is fine. The tests pass,
because there are none left to fail. The lines that remain keep their
coverage. A linter sees valid code. Continuous integration goes green. The
only sign is the test count dropping, and nobody reads that on a passing
build.

A [second example](docs/examples/02-test-edited-to-match-a-bug.md) is quieter
and more common: a bulk discount that was never built, and an agent that makes
the failing test pass by editing what it expects, from 108 to 120, so the
assertion agrees with the missing feature.

## What this is

A rule system checks the code an agent wrote. Runtime guardrails check its
inputs and tool calls while it works. Neither checks what the agent claims
about its own work once the work is done, which is what the rules in this
repository are for: thirteen proof obligations for a delivery report, five
of them checked by a hook on every commit, and tooling that runs the same
way in Claude Code, Cursor, Codex, GitHub Copilot, CI, or a plain
pre-commit hook with no agent at all.

## 🚀 Quickstart

New project:
```
npm install --save-dev agent-delivery-gates
npx adg init
git config core.hooksPath .githooks
```

Existing project, so the rules apply only to what changes from here:
```
npm install --save-dev agent-delivery-gates
npx adg init --prose-preset house-style --baseline
git config core.hooksPath .githooks
```

`init` writes a git pre-commit hook, `AGENTS.md`, an empty gate tally log,
a CI workflow, and the hook and MCP configs for the agents listed below,
and only ever creates a file that does not already exist. `--prose-preset
house-style` turns on the prose gate with this project's own banned-word
list; without it the prose gate stays off. `--baseline` records every
match the project already has to `.adg/prose-baseline.txt`, so turning the
gate on does not fail on everything already there, only on what gets
added after. `--dry-run` prints what would happen without writing
anything, `--force` overwrites a file that already exists, and `--dir
PATH` targets a directory other than the current one.

## 🔌 Where it runs

| Agent | Wiring |
|---|---|
| Claude Code | a plugin, `.claude-plugin/plugin.json` and `hooks/hooks.json`, that wires its own hooks in with no `init` step needed, or the lines `init` prints for `.claude/settings.json` |
| Cursor | `.cursor/hooks.json`, written by `init` |
| Codex | `.codex/hooks.json`, written by `init` |
| GitHub Copilot | `.github/hooks/agent-delivery-gates.json`, written by `init` |
| CI, no agent | `.github/workflows/agent-delivery-gates.yml`, written by `init` |
| Command line, no agent | `agent-delivery-gates validate-report` and `agent-delivery-gates test-diff`, run directly or from any pre-commit hook |

`init` never overwrites an existing hook config for Cursor, Codex, or
Copilot; if one is already there it prints the template's content for a
person to merge in by hand.

## 🧩 The MCP server

`agent-delivery-gates mcp` starts a server on stdio. It is a local
subprocess, not a hosted service: a client starts it, writes requests to
its stdin, and reads replies from its stdout until the pipe closes.
Nothing about a project's code or reports leaves the machine.

It offers the rule catalog as resources, one per rule plus a combined
`rule-catalog` listing, and two of the checks as tools,
`validate_report` and `separate_test_diff`. It is advisory, not a gate: an
agent calls a tool here when it chooses to, and nothing stops a session
that never calls it. The enforced version of the same two checks is the
hook route above, which runs whether an agent reaches for it or not.

`init` writes the stdio entry to `.mcp.json`, `.cursor/mcp.json`, and
`.windsurf/mcp.json`, and to `.vscode/mcp.json` in VS Code's own form,
which uses `servers` as its top-level key instead of `mcpServers`. Codex
keeps its MCP config in TOML in the user's home directory instead of a
file in the project, so `init` prints the block to add to
`~/.codex/config.toml` instead of writing it.

## 📁 More examples

The cart fix above is one of four scenarios, each run for real with the
exact output it produced, collected in
[`docs/examples/`](docs/examples/README.md). The other three: a report
that claims more than it proved, an edit blocked mid-review because the
tree was dirty, and adopting the gates on a project that already exists.

## 🗂️ What happened

Two rules in `rules/` name a specific event that led to them.

`commit-before-mutation`: a reviewer ran `git checkout` on an uncommitted
route file in the middle of a review that mutates code, runs tests, and
restores. The checkout wiped the uncommitted diff. The change was rebuilt
from memory and checked again by running the test suite, which confirmed
the code worked but proved nothing about whether the rebuilt version
matched what had been lost.

`filesystem-allowlist`: a delivery report said that some specification
files could not be found in a synced personal folder. That sentence meant
an agent had gone looking there. A folder an agent can read from is a
folder it can write to, and a wrong write there would replicate to every
device that folder syncs to, not just the one running the build.

The rest of the thirteen rules generalize a pattern seen across more than
one build step, not a single recorded event. Only these two name one.

Building this repository also produced its own record of what its gates
caught, logged in `docs/gate-tally.md` as the work went. Four entries land
hardest:

- The prose gate ran under its own command and never under the test
  runner, so nothing in the repository had ever checked it. A sweep of
  deliberate breaks found that inverting its exit codes, which would make
  it report success on prose that fails the rules, failed no test. It
  was never actually inverted; nothing would have noticed if it had been.
- Packing the package and installing it somewhere else showed that none
  of it ran. Node refuses to strip types from a file under
  `node_modules`, so every tool and every hook was dead the moment the
  package was installed, while every test in this repository passed,
  because they run the source in place.
- A first version of the pre-commit hook printed the whole test log on a
  good commit, tens of thousands of lines. A gate that noisy gets turned
  off, and a gate nobody runs catches nothing. Output is held back now
  and shown only on a failure.
- An early draft of this README stated that the prose gate had once
  shipped with its exit codes actually inverted. It had not; that was a
  deliberate break made during a sweep, and no test caught it, which is a
  different claim. Checking the sentence against the tally entry it came
  from is what caught the overclaim, in the file most likely to be read.

Running `agent-delivery-gates tally` counts entries per rule. As of this
build: 66 entries, dated 2026-09-07 to 2026-09-08, five with no automated
test behind them because someone read the situation and wrote it down
instead.

```
induced-failure-required: 23
full-finding-list: 15
cross-cutting-audit: 9
named-spec-files-fail-loud: 9
filesystem-allowlist: 5
commit-before-mutation: 4
coverage-as-gap-finder: 1
artifact-inputs-reproducible: 0
builder-reviewer-separation: 0
one-fail-loud-setup-script: 0
red-before-green: 0
standing-adversarial-self-review: 0
test-diff-reported-apart: 0
```

A zero does not mean a rule was unnecessary. It means the work stayed
clean on that rule for the life of this build, or nothing looked closely
enough to catch anything on it yet, and the count alone cannot tell you
which. Every tally entry names where to see the result, so any row can be
checked instead of taken on trust.

## 📜 The thirteen rules

All thirteen are recorded in `rules/`, one JSON file per rule, and
described at length in `AGENTS.md`. Grouped by each record's own
`enforcement` field:

Enforced by a hook that runs on every relevant tool call or commit:

- `commit-before-mutation`: a deliverable is not finished until the tree
  is committed, so a reviewer's restore step has something to restore to.
- `filesystem-allowlist`: a build agent's file access stays inside an
  allowlist of roots, checked against the real, symlink-free path.
- `full-finding-list`: a review report carries every finding, every
  severity, with nothing marked deferred on the agent's own say.
- `induced-failure-required`: a claim that a failure path is handled
  needs evidence the failure actually happened and the handling fired.
- `test-diff-reported-apart`: a fix that touches an existing test file
  has its test changes reported apart from its source changes.

Carried by prompt instructions only, with no mechanical check today:

- `artifact-inputs-reproducible`: a generated artifact's report states
  the exact inputs needed to build it again.
- `coverage-as-gap-finder`: a coverage pass names the branches that never
  ran instead of chasing a percentage.
- `named-spec-files-fail-loud`: a prompt names every file it depends on
  up front, and a missing one stops the build instead of being guessed
  at.
- `one-fail-loud-setup-script`: manual setup ships as one script that
  stops at the first real error, not a checklist to follow by hand.
- `red-before-green`: a bug fix ships with a test that failed before the
  fix and passes after it.
- `standing-adversarial-self-review`: a build step runs a self-review
  checklist against its own output before any other reviewer sees it.

Needs a human gate, meaning no script can confirm it from the outside:

- `builder-reviewer-separation`: a review that counts crosses a session
  boundary or reaches a person; a same-session review does not.
- `cross-cutting-audit`: a fresh session with no build history checks
  that a multi-step build stays consistent across its own seams.

## ⚠️ What is not covered

- `path-confinement.ts` only sees `Read`, `Write`, `Edit`, `MultiEdit`,
  and `NotebookEdit` calls. A shell command's filesystem effects are not
  read reliably from its text, so a script that reaches outside the
  allowlist through `Bash` is not caught.
- Five rules have no mechanical check at all: `artifact-inputs-reproducible`,
  `coverage-as-gap-finder`, `named-spec-files-fail-loud`,
  `one-fail-loud-setup-script`, and `standing-adversarial-self-review`.
  They depend on the agent following the prompt instruction and on a
  person reading the report afterward.
- `builder-reviewer-separation` and `cross-cutting-audit` need a person
  or an actually separate agent session. No script can tell from outside
  whether a review was independent; it can only be arranged for and then
  checked.
- No hook can tell whether a test failed before a fix and passed after
  it. That is what `red-before-green` asks for, and only a person or the
  delivery report itself can say it happened.
- A timeout on a hook call fails open on every platform wired here: if
  the hook does not answer in time, the tool call goes ahead unchecked.
- The Codex, Cursor, and Copilot hook configs use each platform's tool
  names as best guesses; only the Claude Code plugin has run against the
  real tool, so the other three configs have not been loaded and
  confirmed by the coding tool they target.

## ⚖️ Requirements and licence

Node 22.18 or newer. No runtime dependencies. Run the test suite with
`npm test`. Licensed under Apache 2.0.

Distilled from building a cross-platform desktop application in Rust and Python.
