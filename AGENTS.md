# AGENTS.md

This project checks an AI coding agent's claims about its own work, not
just the code it wrote. A test suite tells you the code runs. It does not
tell you whether a claim in a delivery report, such as "the retry path is
handled" or "the fix is verified," was ever actually exercised. A green
run and a false claim can look identical from outside, and only one of
them is true. The rules and tools here exist to tell the two apart.

`CLAUDE.md` covers this repository's own conventions for building the
project. This file exists so the thirteen rules are usable by an agent that
is not Claude Code. The tools that carry the mechanical checks are
ordinary command line programs, and they work the same way no matter what
is calling them.

## The thirteen rules

Each rule below is a proof obligation: a kind of claim, and what evidence
that claim needs before it counts as validated. The heading is the rule's
id, taken from its record's file name in `rules/`, because that id is
what the tooling and this file both refer to.

### induced-failure-required

Covers any claim that something is handled, isolated, recovered,
prevented, rejected, or validated. The evidence has to show the specific
failure actually happened and that the handling fired in response; a run
that only takes the happy path proves nothing about a failure path. The
check backing this rule also requires that the assertion look at
something a user would notice, a real file, a missing queue entry, a
completed job, and not an internal value the code satisfies for free. A
robustness claim with no such evidence near it is the exact failure this
project is built to catch: code that runs clean because the failure it
claims to handle was never triggered.

### filesystem-allowlist

Covers a claim that a build agent's file access stayed inside its
intended scope. Every read, write, or edit call is checked against an
allowlist of roots (the repository, the system temp directory, and any
extra roots configured for the run), and the path is resolved to its
real, symlink-free form before the comparison, so a symlink cannot make
an out-of-bounds path look contained. A denied call is blocked before it
runs. Without this, a wrong write can land in a folder that syncs to
other devices or holds documents that are the source of truth for
something else, corrupting the canonical copies everywhere at once
instead of in one place.

### commit-before-mutation

Covers a claim that a deliverable is finished and ready for a reviewer
that runs mutation tests, meaning it deliberately breaks code, runs
tests, and restores. The evidence is a `git status` run immediately
before handoff, a commit if the tree was not already clean, and a
delivery report that states the resulting commit hash and confirms the
tree is clean. Without a commit first, a reviewer's restore step can run
against a tree that still holds an uncommitted diff and wipe it, leaving
nothing to reconstruct against except memory, which is not verification.

### full-finding-list

Covers any deliverable that runs a reviewer, automated or human, over the
work and then reports on the review. The report has to carry the
reviewer's complete finding list, every severity level including Low and
Info, each with an id, severity, description, and disposition, and an
agent never marks a finding deferred on its own authority. Without this,
a finding can be summarized away before it ever reaches review, the same
way a test can be quietly excluded from a passing count: the report
reads clean precisely because the item carrying the risk was left out.

### red-before-green

Covers a claim that a bug fix actually fixed something. Every fix needs a
test that failed before the fix and passes after it, and the delivery
report has to say plainly that this was checked. A test that already
passed before the fix says nothing about whether the fix changed
anything; without a red run first, a fix can ship next to a test that
passed both before and after it, or with no dedicated test at all, and
still get reported as proven.

### test-diff-reported-apart

Covers a claim that a fix works, resting on a run that came back green. When
a fix changes files that already held tests, the report has to show the test
changes apart from the source changes. A fix can reach green by changing the
tests instead of the code: an assertion deleted, an assertion loosened, an
expected value edited to match the wrong behaviour, a case skipped, a test
file renamed so it stops being collected. From outside that looks the same as
a fix that works, and the source change is often one line, which is where a
reader's eye goes.

This rule was written for this project. The other twelve come from one set of
notes; this one was added later, because nothing in that set covered a fix
where the tests move to meet the code.

### standing-adversarial-self-review

Covers a claim that a build step is finished and ready to hand off,
before any reviewer has looked at it. Every build prompt carries a
self-review checklist the agent runs against its own output first:
naming every error variant and whether it is routed correctly, testing
any comparison logic against values that differ and not just values that
already match, checking locks for re-entrancy, stating whether a
filesystem check resolves the real path or only inspects the string, and
naming any assumption, any check-then-use window, or any acceptance claim
that has no proving test. Skipping this means the questions an
independent reviewer would ask go unasked until a later, costlier review,
if they get asked at all.

### builder-reviewer-separation

Covers a claim that independent review happened during a build. A
reviewer spawned inside the same session as the builder shares the
builder's context and framing, so that review is weaker than one that
crosses a session boundary or reaches a human. At minimum, a
separate builder agent and a separate reviewer agent run for every build
step, with the reviewer running an adversarial checklist against the
builder's output and reporting findings the builder addresses before the
gate passes. A deliverable produced by one agent reviewing its own work
does not satisfy this. Without the boundary crossing, any blind spot the
builder and a same-session reviewer share goes unexamined all the way to
delivery.

### cross-cutting-audit

Covers a claim that a multi-step build is consistent across steps, not
just correct step by step. At each phase boundary, before the next phase
builds on top, a separate audit has to run in a fresh session with no
build history, given only the spec files, the final code, and the
invariants the build depends on. Each finding must name two layers, the
shared invariant between them, and both code locations. Without this, an
invariant that held early can be silently broken later, or a later layer
can invalidate an assumption an earlier layer depended on, and nothing
catches it because no reviewer ever looks across the seams between steps.

### artifact-inputs-reproducible

Covers a claim that a step produced an artifact whose content depends on
specific inputs: a generated image, a scaffold built from a template, a
dataset pulled from a query. The delivery report has to print the exact
inputs needed to regenerate it, the prompt and seed, the template name
and version and parameters, or the query and its filters. Without this,
nobody can regenerate the artifact later or check it against a changed
input, because the inputs that produced it were never written down.

### coverage-as-gap-finder

Covers a claim that test coverage supports confidence in a phase or
step. Coverage is run to find gaps, not to produce a score: the pass
names the specific branches that never ran, especially failure and error
paths, and stops once those gaps are named and closed. There is no
target percentage to chase. Without this framing, the percentage climbs
while the failure branches it was supposed to point at keep running for
the first time in production.

### named-spec-files-fail-loud

Covers a claim that a prompt needing specification or reference files
used the right ones. Any such prompt opens with a section, before the
task body, naming every needed file by its exact name and stating that
the files live in the repository. This lets a person confirm the files
are in place before work starts, and lets the agent fail loud: report a
missing file as not present and stop, instead of working from a guess or
a similarly named file nearby.

### one-fail-loud-setup-script

Covers a claim that a deliverable's manual setup steps are ready for a
person to run. Those steps ship as one script run top to bottom, never a
prose checklist. The script automates what it can, checks for anything
needing a person instead of installing it quietly, stops at the first
real error with what broke and what to do next, is safe to run again, and
states what it validated on success or the exact error on failure.
Without this, a prose checklist gets followed out of order or with a
mistyped value nobody catches, and the environment ends up subtly wrong.

## What is enforced, and by what

Take this section as the source of truth over any summary above it: each
rule's `enforcement` field says whether a hook checks it, whether it is
carried by prompt instructions only, or whether it needs a human review
gate, and that field comes straight from the rule's own record.

Hook enforced, with the check ids each one emits:

- `commit-before-mutation`: `missing-commit-line`
- `filesystem-allowlist`: `path-allowlist-confinement`
- `full-finding-list`: `finding-list-incomplete`, `open-finding-not-carried`
- `induced-failure-required`: `unproven-robustness-claim`, `evidence-not-durable`

Prompt only, no mechanical check today:

- `artifact-inputs-reproducible`
- `coverage-as-gap-finder`
- `named-spec-files-fail-loud`
- `one-fail-loud-setup-script`
- `standing-adversarial-self-review`

Human gate, meaning no tool can carry this at all; it needs a person or
an actually separate agent session:

- `builder-reviewer-separation`
- `cross-cutting-audit`

One rule needs its own line, because a hook covers half of it and cannot
cover the other half. `red-before-green` asks that every fix ship a test
that was red before the fix and green after. A hook cannot confirm such a
test exists. It can catch the opposite move, a fix reaching green by
changing the tests, and that is what runs: on a commit touching existing
test files, the test diff is reported apart from the source diff and
seven checks name what was weakened. Whether the fix carried a
red-before-green test stays with the report and the reviewer.

## Running the checks outside Claude Code

Both tools are plain command line programs with defined exit codes. They
do not depend on any hook system to run; a hook system is only what makes
them block a tool call in-loop before it happens, which needs a coding
tool that supports hooks. Anywhere else, run them as a CI step or a git
pre-commit hook and check the exit code.

### delivery-report-validator

Checks a delivery report against `full-finding-list`,
`commit-before-mutation`, and `induced-failure-required`.

```
delivery-report-validator [--report PATH] [--prior PATH] [--format text|json]
```

With no `--report`, it reads the report from standard input. `--prior`
points at a file listing prior open finding ids, one per line, so a
finding already known and still open is not treated as new.

Exit codes: `0` the report passes; `1` the report fails at least one
check; `2` the validator could not run as asked, an unreadable path, a
bad argument, or empty input. Exit 2 is deliberately distinct from exit 0
so an unreadable report never reads as a clean one.

Verified: piping an empty string in gives exit 2 with "the report is
empty; nothing to validate" on stderr. Piping in a short report with no
findings section and no commit line gives exit 1, printing
`finding-list-incomplete` and `missing-commit-line`, each with severity
and a fix instruction.

### test-diff-separator

Separates a diff into its source half and its test half, and reports
weakening signals found only in the test files: a removed assertion, a
removed test case, an added skip, a widened tolerance, a raised timeout.
This is the mechanical part of `red-before-green`, and the anomaly
flagged above.

```
test-diff-separator [--rev REV] [--range A..B] [--staged] [--diff PATH] [--format text|json]
```

Exactly one of `--rev`, `--range`, `--staged`, `--diff` may be given.
With none of them, it defaults to `--rev HEAD`, the diff introduced by
the current commit.

Exit codes: `0` no test file changed, or none of the changed test files
carry a signal; `1` at least one signal was found; `2` could not run as
asked, including a git failure, so a broken git call never reads as "no
signals."

Verified: `test-diff-separator --rev HEAD` against this repository's
current HEAD printed the source diff, reported no test files changed,
and exited 0.

### Wiring them in without a hook system

A pre-commit hook or a CI step can call either command directly and act
on its exit code, for example:

```
delivery-report-validator --report delivery-report.md || exit 1
test-diff-separator --staged || exit 1
```

An agent that is not Claude Code, and so has no hook system of its own,
still gets the same coverage by running these two commands itself before
declaring a step finished, or by having its CI pipeline run them after
every push.

## What this does not cover

Reading this file does not make an agent trustworthy on its own; it
still needs the checks above actually run.

- The filesystem allowlist hook only sees Read, Write, Edit, MultiEdit,
  and NotebookEdit calls. A shell command's filesystem effects are not
  reliably readable from its text, so a script that reaches outside the
  allowlist through Bash is not caught by that hook.
- Five rules (`artifact-inputs-reproducible`, `coverage-as-gap-finder`,
  `named-spec-files-fail-loud`, `one-fail-loud-setup-script`, and
  `standing-adversarial-self-review`) have no mechanical check at all
  today. They depend on the agent actually following the prompt
  instruction, and on a person reading the resulting report.
- `builder-reviewer-separation` and `cross-cutting-audit` need a human
  gate or an actually separate agent session. No script can confirm a
  review was independent from the outside; it can only be arranged for
  and then checked by a person.
- The delivery-report-validator reads report text for patterns; it does
  not verify that the evidence a finding or a claim points at is the
  right evidence, only that some durable reference is present. Whether
  the reference actually proves the claim is still a human judgment.
