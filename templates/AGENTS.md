# AGENTS.md

agent-delivery-gates checks what an AI coding agent claims about a
change, not only whether the code it wrote runs. A test suite proves the
code executes. It does not prove a claim in a delivery report, such as
"the retry path is handled" or "the fix is verified," was ever actually
exercised. A green run and a false claim can read the same from outside.

This file exists so any agent working in this project, not only Claude
Code, can find and run the same checks a human reviewer would run.

## The commands

Every command below is a subcommand of the `agent-delivery-gates` binary
(short alias: `adg`). Each one is a plain program with a defined exit
code, and each can run on its own, from a shell, a CI step, or a git
pre-commit hook.

```
agent-delivery-gates validate-report [--report PATH] [--prior PATH] [--format text|json]
agent-delivery-gates test-diff [--rev REV] [--range A..B] [--staged] [--diff PATH] [--format text|json]
agent-delivery-gates scan-prose [FILE...] [--rules PATH] [--require-rules] [--baseline PATH | --write-baseline PATH]
agent-delivery-gates tally [--tally PATH] [--format text|json] [--check]
agent-delivery-gates check
agent-delivery-gates init [--dry-run] [--force] [--prose-preset NAME] [--baseline] [--dir PATH]
```

### validate-report

Reads a delivery report and fails it when the report claims more than it
proved: a finding list missing a severity, a claim that a failure was
handled with no evidence a failure was ever induced, a missing commit
line before a claim that a step is finished.

Exit codes: `0` the report passes; `1` at least one check failed; `2` the
tool could not run as asked, an unreadable path, empty input, or a bad
argument.

### test-diff

Separates a diff into its source half and its test half, and reports
weakening signals found only in the test files: a removed assertion, a
removed test case, an added skip, a widened tolerance, a raised timeout.
A fix can reach a green run by changing the tests instead of the code
under test; this is how that move gets caught.

Exit codes: `0` no test file changed, or none of the changed files carry
a signal; `1` at least one signal was found; `2` could not run as asked,
including a git failure, so a broken git call never reads as a pass.

### scan-prose

Checks text against a configurable list of banned words and patterns.
With no rules file configured, nothing runs and the exit code is `0`;
point it at a rules file with `--rules`, or run `init --prose-preset
NAME`, to turn it on.

Exit codes: `0` clean, or nothing configured; `1` a banned pattern was
found; `2` the scan could not run: a missing rules file or a bad path.

### Turning the prose scan on for an existing project

An existing project usually already has text the rules would catch, and
a scan that fails on everything already there gets turned off before it
catches anything new. Turn the rules on with `init --prose-preset NAME`,
then add `--baseline` to record every match the project already has, to
`.adg/prose-baseline.txt`. Once the baseline is in place, the scan fails
only on a new match; fixing an old one and deleting its recorded line
lets the baseline shrink over time.

### tally

Reads a log of what each gate has caught and reports its counts, or
checks the log for problems such as an entry pointing at a path nobody
can open.

Exit codes: `0` sound; `1` at least one problem; `2` could not run.

### check

Runs the checks a project should pass before a piece of work is
considered ready to hand off or to make public: no commit message
carries AI attribution or a personal path, no tracked file carries one
either, and the prose scan passes.

Exit codes: `0` everything passed; `1` at least one check failed, or was
skipped, which counts as incomplete; `2` could not run as asked.

### init

Writes starter files into a project: a git pre-commit hook, this file,
and an empty gate tally log. It only ever creates a file that does not
exist yet; nothing already on disk is changed unless `--force` is given.
Run `agent-delivery-gates init --help` for the full option list.

## Wiring into Claude Code

Two routes exist. The plugin route needs no manual wiring at all;
installing the plugin adds the hooks on its own. The standalone route
needs a few lines added to `.claude/settings.json` by hand;
`agent-delivery-gates init` prints them.

## What this does not cover

None of these commands read intent. A report can pass every check here
and still describe work that a human reviewer would reject on its own
merits. These checks catch a claim that outran its evidence; they do not
replace review.
