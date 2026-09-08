# agent-delivery-gates

A rule system checks the code an agent wrote. Runtime guardrails check its
inputs, outputs, and tool calls while it works. Neither checks what the
agent claims about its own work once the work is done. A green test run and
a delivery report saying a failure path was verified look the same from
outside, and only one of those can be true. This repository holds rules
that govern which claims an agent may make in a delivery report, and what
evidence each claim needs before it counts.

## What happened

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
caught: 33 entries logged in `docs/gate-tally.md` as the work went. A few
land hardest:

- Mutation testing ran against work that had not been committed yet.
  Restoring each induced failure with a checkout wiped three fixes that
  were never committed, the exact failure `commit-before-mutation`
  describes. The rule was already written down at that point. The hook
  that enforces it was still being built (entry 7).
- The prose gate that checks this repository's own writing reported
  success in four situations where it had checked nothing: a banned word
  written in capitals, a run started outside a git repository, a path
  that did not exist, and a directory passed where a file was expected.
  Each one exited zero (entry 2).
- A fix for that gate passed every test written for it, all of them made
  up for the occasion. Run against a real file in the repository, the
  same fix joined two filenames into one path that could not be opened
  (entry 3).
- A path bug that let a check look at the wrong file was fixed once, in
  the prose gate. The clean-tree hook carried the same bug and kept it,
  until an audit run in a fresh session with no memory of the earlier fix
  reproduced a live hole: with a dirty tree and a phase file naming a
  review, a write went through, because the phase file was looked for
  next to the working directory instead of at the repository root
  (entries 5 and 26).
- Writing tests for the prose gate broke the prose gate. The tests had to
  contain the words the gate rejects, and the gate reads its own test
  files along with everything else in the repository (entry 22).

## The numbers

`docs/gate-tally.md` holds 33 entries recorded between 2026-09-07 and
2026-09-08, one row per time a gate caught something while this
repository was built. Running `node scripts/tally-report.ts` prints a
count per rule:

```
induced-failure-required: 10
full-finding-list: 8
named-spec-files-fail-loud: 7
cross-cutting-audit: 4
commit-before-mutation: 2
coverage-as-gap-finder: 1
filesystem-allowlist: 1
artifact-inputs-reproducible: 0
builder-reviewer-separation: 0
one-fail-loud-setup-script: 0
red-before-green: 0
standing-adversarial-self-review: 0
test-diff-reported-apart: 0
```

Five of the 33 entries have no automated test behind them; they are on
record because someone read the situation and wrote it down. A zero does
not mean a rule was unnecessary. It means one of two things: either the
work stayed clean on that rule for the life of this build, or nothing
looked closely enough to catch anything on it yet, and the count alone
cannot tell you which. What makes the count worth reading is that every
entry names the test that backs it, so any row can be checked instead of
taken on trust.

## The rules

All thirteen rules are recorded in `rules/`, one JSON file per rule, and
described at length in `AGENTS.md`. Grouped by what enforces them, taken
from each record's own `enforcement` field:

Enforced by a hook, a script that runs on every relevant tool call or
commit:

- `commit-before-mutation`: a deliverable is not finished until the tree
  is committed, so a reviewer's restore step has something to restore to.
- `filesystem-allowlist`: a build agent's file access stays inside an
  allowlist of roots, checked against the real, symlink-free path.
- `full-finding-list`: a report on a review has to carry every finding,
  every severity, with nothing marked deferred on the agent's own say. The
  hook checks one part of that: the list holds a Low or Info entry, or
  says there were none. Whether something was dropped before the list was
  written is left to a reader.
- `induced-failure-required`: a claim that a failure path is handled
  needs evidence the failure actually happened and the handling fired.
- `test-diff-reported-apart`: a fix that touches an existing test file
  has its test changes reported apart from its source changes.

Carried by prompt instructions only, with no mechanical check today:

- `artifact-inputs-reproducible`: a generated artifact's report states
  the exact inputs needed to build it again.
- `coverage-as-gap-finder`: a coverage pass names the branches that
  never ran instead of chasing a percentage.
- `named-spec-files-fail-loud`: a prompt names every file it depends on
  up front, and a missing one stops the build instead of being guessed at.
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

`red-before-green` sits partly in the hook group: a hook cannot confirm a
red-before-green test existed, but `test-diff-reported-apart` catches the
opposite move, a fix reaching green by changing the tests instead of the
code. Whether the fix actually carried a red test first stays with the
report and whoever reads it.

## Using it

Four scripts under `hooks/` are wired through `.claude/settings.json`:

- `hooks/path-confinement.ts` runs on every `Read`, `Write`, `Edit`,
  `MultiEdit`, and `NotebookEdit` call and enforces
  `filesystem-allowlist`.
- `hooks/pre-mutation-clean-tree.ts` runs before every `Edit`, `Write`,
  `MultiEdit`, and `NotebookEdit` call and enforces
  `commit-before-mutation`.
- `hooks/test-diff-post-tool-hook.ts` runs after a `Bash` call, acts only
  when that call ran `git commit`, and enforces `test-diff-reported-apart`
  by separating the commit's test diff from its source diff.
- `hooks/delivery-report-stop-hook.ts` runs when the agent tries to stop
  and enforces `full-finding-list` and `induced-failure-required` against
  a delivery report.

The last two are thin wrappers: each calls one of two vendor-neutral
command line tools that do the actual checking and work the same way no
matter what calls them.

`delivery-report-validator` reads a delivery report and checks it against
`full-finding-list`, `commit-before-mutation`, and
`induced-failure-required`.

```
node hooks/delivery-report-validator.ts [--report PATH] [--prior PATH] [--format text|json]
```

With no `--report`, it reads the report from standard input. Exit `0`
means the report passes. Exit `1` means it failed at least one check.
Exit `2` means the validator could not run as asked, an unreadable path,
a bad argument, or empty input, so an unreadable report never reads as a
clean one.

`test-diff-separator` separates a diff into its source half and its test
half and reports weakening signals found only in the test files.

```
node hooks/test-diff-separator.ts [--rev REV] [--range A..B] [--staged] [--diff PATH] [--format text|json]
```

With none of `--rev`, `--range`, `--staged`, or `--diff` given, it
defaults to `--rev HEAD`. Exit `0` means no test file changed, or none of
the changed ones carry a signal. Exit `1` means at least one signal was
found. Exit `2` means it could not run as asked, including a git failure,
so a broken git call never reads as "no signals."

The prose scan checks this repository's own writing:

```
bash scripts/scan-prose.sh [FILE...]
```

With no arguments it scans every tracked text file apart from three named
exclusions. Exit `0` means it scanned cleanly. Exit `1` means it found
banned prose. Exit `2` means it could not run as asked.

Both command line tools run with no agent involved: as a CI step, or as a
git pre-commit hook, checking the exit code. Blocking a tool call in the
middle of a build, before the agent acts on a bad claim, needs a tool
with a hook system to call into, which is what `.claude/settings.json`
wires up for this repository.

## What is not covered

- `path-confinement.ts` only sees `Read`, `Write`, `Edit`, `MultiEdit`,
  and `NotebookEdit` calls. A shell command's filesystem effects are not
  read reliably from its text, so a script that reaches outside the
  allowlist through `Bash` is not caught.
- Five rules have no mechanical check at all:
  `artifact-inputs-reproducible`, `coverage-as-gap-finder`,
  `named-spec-files-fail-loud`, `one-fail-loud-setup-script`, and
  `standing-adversarial-self-review`. They depend on the agent following
  the prompt instruction and on a person reading the report afterward.
- `builder-reviewer-separation` and `cross-cutting-audit` need a person
  or an actually separate agent session. No script can tell from outside
  whether a review was independent; it can only be arranged for and then
  checked.
- `delivery-report-validator` reads report text for patterns. It does not
  verify that the evidence behind a claim is the right evidence, only
  that some durable reference is present. Whether that reference proves
  the claim is still a human judgment.
- No hook can tell whether a test failed before a fix and passed after
  it. That is what `red-before-green` asks for, and only a person or the
  delivery report itself can say it happened.

## Requirements and licence

Node 22.18 or newer. No runtime dependencies. Run the test suite with
`npm test`. Licensed under Apache 2.0.

Distilled from building a cross-platform desktop application in Rust and
Python.
