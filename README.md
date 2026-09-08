# agent-delivery-gates

Rules that check what an AI coding agent claims about its own work, not just the code it wrote.

A fix that looks like one line:
```
$ git show --stat HEAD
 src/queue.js        | 2 +-
 tests/queue.test.js | 4 +---
 2 files changed, 2 insertions(+), 4 deletions(-)
```

The suite is green:
```
$ node --test tests/*.test.js
# tests 2
# pass 1
# fail 0
# skipped 1
```

With the original tests against that same source it was red: `# pass 1  # fail 1`. The fix broke a real check, and the check was skipped instead of fixed.

What this tool says:
```
$ npx agent-delivery-gates test-diff --rev HEAD
Source diff:
  src/queue.js  +1 -1

Test diff:
  tests/queue.test.js  +1 -3

Signals (4):
  assertion-removed high tests/queue.test.js: an assertion was removed with no equivalent added in this file; confirm this check was not deleted to reach green
      assert.equal(drain([]).length, 0);
  assertion-removed high tests/queue.test.js: an assertion was removed with no equivalent added in this file; confirm this check was not deleted to reach green
      assert.throws(() => drain(null));
  test-case-removed high tests/queue.test.js: a test case was removed with no equivalent added in this file; confirm this test was not deleted to reach green
    test("rejects a malformed list", () => {
  skip-added high tests/queue.test.js: a skip, exclusion, or narrowing to '.only' was added; confirm this test was not disabled to reach green
    test.skip("rejects a malformed list", () => {
```
Exit code 1.

A rule system checks the code an agent wrote. Runtime guardrails check its inputs and tool calls while it works. Neither checks what the agent claims about its own work once the work is done, which is what the rules in this repository are for.

## Quickstart

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

`init` writes a git pre-commit hook, `AGENTS.md`, and an empty gate tally log, and only ever creates a file that does not already exist. `--prose-preset house-style` turns on the prose gate with this project's own banned-word list; without it the prose gate stays off. `--baseline` records every match the project already has to `.adg/prose-baseline.txt`, so turning the gate on does not fail on everything already there, only on what gets added after. `--dry-run` prints what would happen without writing anything, `--force` overwrites a file that already exists, and `--dir PATH` targets a directory other than the current one. `init` prints the lines to add to `.claude/settings.json` for the standalone hook route; it never edits that file itself.

## Which agent

| Agent | Wiring |
|---|---|
| Claude Code | a plugin that wires its own hooks in, or the lines `init` prints for `.claude/settings.json` |
| Codex | `.codex/hooks.json`, written by `init` |
| Cursor | `.cursor/hooks.json`, written by `init` |
| GitHub Copilot | `.github/hooks/agent-delivery-gates.json`, written by `init` |

`init` never overwrites an existing hook config for Cursor, Codex, or Copilot; if one is already there it prints the template's content for a person to merge in by hand.

Two command line tools, `agent-delivery-gates validate-report` and `agent-delivery-gates test-diff`, need no agent at all. They read a delivery report or a diff and exit non-zero on a problem, so they run the same way as a CI step or a git pre-commit hook, with no coding tool or hook system underneath them.

## What happened

Two rules in `rules/` name a specific event that led to them.

`commit-before-mutation`: a reviewer ran `git checkout` on an uncommitted route file in the middle of a review that mutates code, runs tests, and restores. The checkout wiped the uncommitted diff. The change was rebuilt from memory and checked again by running the test suite, which confirmed the code worked but proved nothing about whether the rebuilt version matched what had been lost.

`filesystem-allowlist`: a delivery report said that some specification files could not be found in a synced personal folder. That sentence meant an agent had gone looking there. A folder an agent can read from is a folder it can write to, and a wrong write there would replicate to every device that folder syncs to, not just the one running the build.

The rest of the thirteen rules generalize a pattern seen across more than one build step, not a single recorded event. Only these two name one.

Building this repository also produced its own record of what its gates caught, logged in `docs/gate-tally.md` as the work went. A few land hardest:

- Mutation testing ran against work that had not been committed yet. Restoring each induced failure with a checkout wiped three fixes that were never committed, the exact failure `commit-before-mutation` describes. The rule was already written down at that point. The hook that enforces it was still being built.
- The prose gate that checks this repository's own writing reported success in four situations where it had checked nothing: a banned word written in capitals, a run started outside a git repository, a path that did not exist, and a directory passed where a file was expected. Each one exited zero.
- A fix for that gate passed every test written for it, all of them made up for the occasion. Run against a real file in the repository, the same fix joined two filenames into one path that could not be opened.
- A path bug that let a check look at the wrong file was fixed once, in the prose gate. The clean-tree hook carried the same bug and kept it, until an audit run in a fresh session with no memory of the earlier fix reproduced a live hole: with a dirty tree and a phase file naming a review, a write went through, because the phase file was looked for next to the working directory instead of at the repository root.
- Writing tests for the prose gate broke the prose gate. The tests had to contain the words the gate rejects, and the gate reads its own test files along with everything else in the repository.
- The prose gate had guarded every commit since the first one, and had no automated tests at all, because it runs under its own command and never under the test runner. A sweep of deliberate breaks found that inverting its exit codes, which would make it report success on prose that breaks the rules, failed no test. It was never actually inverted. Nothing would have noticed if it had been.

`docs/gate-tally.md` holds one row per time a gate caught something while this repository was built. Running `node scripts/tally-report.ts` prints a count per rule:

```
induced-failure-required: 20
full-finding-list: 15
cross-cutting-audit: 9
named-spec-files-fail-loud: 9
commit-before-mutation: 4
filesystem-allowlist: 4
coverage-as-gap-finder: 1
artifact-inputs-reproducible: 0
builder-reviewer-separation: 0
one-fail-loud-setup-script: 0
red-before-green: 0
standing-adversarial-self-review: 0
test-diff-reported-apart: 0
```

62 entries, dated 2026-09-07 to 2026-09-08. Five have no automated test behind them; they are on record because someone read the situation and wrote it down. A zero does not mean a rule was unnecessary. It means one of two things: either the work stayed clean on that rule for the life of this build, or nothing looked closely enough to catch anything on it yet, and the count alone cannot tell you which. What makes the count worth reading is that every entry names where to see the result, so any row can be checked instead of taken on trust.

## The thirteen rules

All thirteen are recorded in `rules/`, one JSON file per rule, and described at length in `AGENTS.md`. Grouped by each record's own `enforcement` field:

Enforced by a hook, a script that runs on every relevant tool call or commit:

- `commit-before-mutation`: a deliverable is not finished until the tree is committed, so a reviewer's restore step has something to restore to.
- `filesystem-allowlist`: a build agent's file access stays inside an allowlist of roots, checked against the real, symlink-free path.
- `full-finding-list`: a report on a review has to carry every finding, every severity, with nothing marked deferred on the agent's own say. The hook checks one part of that: the list holds a Low or Info entry, or says there were none.
- `induced-failure-required`: a claim that a failure path is handled needs evidence the failure actually happened and the handling fired.
- `test-diff-reported-apart`: a fix that touches an existing test file has its test changes reported apart from its source changes.

Carried by prompt instructions only, with no mechanical check today:

- `artifact-inputs-reproducible`: a generated artifact's report states the exact inputs needed to build it again.
- `coverage-as-gap-finder`: a coverage pass names the branches that never ran instead of chasing a percentage.
- `named-spec-files-fail-loud`: a prompt names every file it depends on up front, and a missing one stops the build instead of being guessed at.
- `one-fail-loud-setup-script`: manual setup ships as one script that stops at the first real error, not a checklist to follow by hand.
- `red-before-green`: a bug fix ships with a test that failed before the fix and passes after it.
- `standing-adversarial-self-review`: a build step runs a self-review checklist against its own output before any other reviewer sees it.

Needs a human gate, meaning no script can confirm it from the outside:

- `builder-reviewer-separation`: a review that counts crosses a session boundary or reaches a person; a same-session review does not.
- `cross-cutting-audit`: a fresh session with no build history checks that a multi-step build stays consistent across its own seams.

## What is not covered

- `path-confinement.ts` only sees `Read`, `Write`, `Edit`, `MultiEdit`, and `NotebookEdit` calls. A shell command's filesystem effects are not read reliably from its text, so a script that reaches outside the allowlist through `Bash` is not caught.
- Five rules have no mechanical check at all: `artifact-inputs-reproducible`, `coverage-as-gap-finder`, `named-spec-files-fail-loud`, `one-fail-loud-setup-script`, and `standing-adversarial-self-review`. They depend on the agent following the prompt instruction and on a person reading the report afterward.
- `builder-reviewer-separation` and `cross-cutting-audit` need a person or an actually separate agent session. No script can tell from outside whether a review was independent; it can only be arranged for and then checked.
- No hook can tell whether a test failed before a fix and passed after it. That is what `red-before-green` asks for, and only a person or the delivery report itself can say it happened.
- A timeout on a hook call fails open on every platform wired here: if the hook does not answer in time, the tool call goes ahead unchecked.
- The Codex, Cursor, and Copilot hook configs use each platform's tool names as best guesses; only the Claude Code plugin has run against the real tool, so the other three configs have not been loaded and confirmed by the coding tool they target.

## Requirements and licence

Node 22.18 or newer. No runtime dependencies. Run the test suite with `npm test`. Licensed under Apache 2.0.

Distilled from building a cross-platform desktop application in Rust and Python.
