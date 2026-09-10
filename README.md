# agent-delivery-gates

**Because green tests are never enough.** 🔥

- ✅ Breaks your code on purpose and reports the breaks no test noticed.
- ✅ Runs a change's new tests against the code from before it.
- ✅ Induces the failure your report says is handled.
- ✅ Git hook, CI step or MCP server. No API key, one sandboxed dependency that cannot open a socket.

It reads what an agent writes about its own work too, and fails a claim with
nothing behind it, against [fourteen proof obligations](#the-rules) for a
delivery report.

Gates that check the work and the account of it, on the assumption that
neither is owed the benefit of the doubt. Nothing leaves your machine while a
gate runs, and the [questions](#questions) below have the rest. Five of the obligations are
carried by a hook on every commit, the checks run the same way in Claude Code,
Cursor, Codex, GitHub Copilot, CI, or a plain pre-commit hook with no agent at
all, and [the MCP server](#the-mcp-server) is there for an agent that would
rather ask than be stopped.

Seven worked examples, hardest first, each one run for real with the output it
produced:

- **[A retry that never retries](https://github.com/emiquelito/agent-delivery-gates/blob/main/docs/examples/07-a-retry-that-never-retries.md)**:
  a retry decorator with three attempts, backoff, and a timeout, approved by
  everyone who read it, that makes one call and hands the caller a 503 body as
  though it were a quote. Only an induced failure tells the broken version
  from the fixed one.
- **[A feature that shipped with nothing holding it](https://github.com/emiquelito/agent-delivery-gates/blob/main/docs/examples/06-a-feature-with-nothing-holding-it.md)**:
  four tests become seven, all passing, and a customer starts paying for
  shipping. One assertion in eighteen added lines was swapped for one that is
  true whatever the code does, and the new tests check a flag and a type but
  never the money. Breaking the total three different ways leaves the suite
  green.
- **[A test edited to match a bug](https://github.com/emiquelito/agent-delivery-gates/blob/main/docs/examples/02-test-edited-to-match-a-bug.md)**:
  a bulk discount that was never built, and a failing test made to pass by
  changing what it expects from 108 to 120, so the assertion agrees with the
  missing feature.
- **[Tests that stopped running](https://github.com/emiquelito/agent-delivery-gates/blob/main/docs/examples/01-tests-that-stopped-running.md)**:
  a test file renamed so the runner stops collecting it. Git reports zero
  lines changed against that file and git is right, the suite goes green with
  nothing left to fail, and the only trace is a test count nobody reads on a
  passing build.
- **[A report claiming more than it proved](https://github.com/emiquelito/agent-delivery-gates/blob/main/docs/examples/03-report-claiming-more-than-it-proved.md)**:
  "failure handling verified", with nothing behind it anyone can open. A
  robustness claim has to point at a commit, a path, or a command; pointing at
  a conversation fails.
- **[An edit blocked mid-review](https://github.com/emiquelito/agent-delivery-gates/blob/main/docs/examples/04-edit-blocked-mid-review.md)**:
  the clean-tree hook stopping a review phase from writing over work that was
  never committed, which is how this project lost three fixes once.
- **[Adopting the gates on a repository that already exists](https://github.com/emiquelito/agent-delivery-gates/blob/main/docs/examples/05-adopting-on-an-existing-repository.md)**:
  `init` on a project with its own history, a baseline recording what is
  already there, then a clean commit and a caught one.

## 🚀 Quickstart

```
npm install --save-dev agent-delivery-gates
npx adg init
git config core.hooksPath .githooks
```

`init` writes a git pre-commit hook, `AGENTS.md`, an empty gate tally log,
a CI workflow, and the hook and MCP configs for the agents listed below,
and only ever creates a file that does not already exist. `--dry-run`
prints what would happen without writing anything, `--force` overwrites
a file that already exists, and `--dir PATH` targets a directory other
than the current one.

### Optional: this project's own banned-word list

The prose scan is this project's own taste, not one of the gates, and it
stays off unless asked for. Turn it on with:

```
npx adg init --prose-preset house-style --baseline
```

On an existing project, `--baseline` records every match already there
to `.adg/prose-baseline.txt`, so the gate fails only on what gets added
after, not on everything the project already has. Leave `--baseline` off
on a new project, which has nothing to record; on its own, without
`--prose-preset`, it is rejected.

## 🔌 Where it runs

| Agent | Wiring |
|---|---|
| Claude Code | a plugin, `.claude-plugin/plugin.json` and `hooks/hooks.json`, that wires its own hooks in with no `init` step needed, or the lines `init` prints for `.claude/settings.json` |
| Cursor | `.cursor/hooks.json`, written by `init` |
| Codex | `.codex/hooks.json`, written by `init` |
| GitHub Copilot | `.github/hooks/agent-delivery-gates.json`, written by `init` |
| CI, no agent | `.github/workflows/agent-delivery-gates.yml`, written by `init` |
| Command line, no agent | every check is a plain command with an exit code: `validate-report`, `test-diff`, `mutate`, `census`, `induce`, `scan-prose`, `tally`, `check` |

`init` never overwrites an existing hook config for Cursor, Codex, or
Copilot; if one is already there it prints the template's content for a
person to merge in by hand.

<a id="the-mcp-server"></a>

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

The rest of the fourteen rules generalize a pattern seen across more than
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
<!-- tally:start -->
build: 103 entries, dated 2026-09-07 to 2026-09-09, five with no automated
test behind them because someone read the situation and wrote it down
instead.

```
induced-failure-required: 31
full-finding-list: 19
cross-cutting-audit: 14
named-spec-files-fail-loud: 11
filesystem-allowlist: 6
one-fail-loud-setup-script: 6
commit-before-mutation: 5
coverage-as-gap-finder: 3
test-diff-reported-apart: 3
expected-value-derived-apart: 2
standing-adversarial-self-review: 2
red-before-green: 1
artifact-inputs-reproducible: 0
builder-reviewer-separation: 0
```
<!-- tally:end -->

A zero does not mean a rule was unnecessary. It means the work stayed
clean on that rule for the life of this build, or nothing looked closely
enough to catch anything on it yet, and the count alone cannot tell you
which. Every tally entry names where to see the result, so any row can be
checked instead of taken on trust.

<a id="the-rules"></a>

## 📜 The fourteen rules

All fourteen are recorded in `rules/`, one JSON file per rule, and
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

<a id="questions"></a>

## ❓ Questions

| | |
|---|---|
| Needs an API key | No. Nothing here calls a model. |
| Code leaves the machine | Not during a gate run. `adg lang add` (and `adg init`, only with your yes) fetches a language's tree-sitter grammar at the moment you ask for it; `check`, `mutate`, `census`, `induce`, `test-diff`, and every hook never touch the network. |
| Runtime dependencies | One: [web-tree-sitter](https://www.npmjs.com/package/web-tree-sitter), MIT licensed, zero dependencies of its own. The grammar it loads is WebAssembly, which cannot open a socket, read a file it was not handed, or make a syscall. |
| Same input, same answer | Yes. No model call means no variance to average out. |
| Works offline | Yes, for every gate. Only `adg lang add` needs the network, once, to fetch a grammar. |
| Blocks | Yes. The hooks exit non-zero and stop the tool call or the commit. |
| Needs an agent | No. Every check is a command with an exit code. |
| Costs tokens | Not by itself. Inside an agent session, yes: see below. |

**Does it use my model, my tokens, or my key?**
No key, and no model call. These are ordinary programs, and run from a git
hook or a CI job they cost nothing but time.

Tokens are a different question, and the answer is yes when you run this the
way most people will. Inside Claude Code, Cursor, Codex or Copilot, the agent
runs the command and reads what it printed, and that output lands in the
context you are paying for. A blocked tool call, a list of surviving
mutations, a report on what did not settle: the agent reads all of it and
often acts on it. That is the point, and it is not free.

One command is more than reading. `induce` needs a spec naming the failure to
cause and the handling to take away, and writing that for an unfamiliar
codebase means finding the handler and working out how to break it. That is
model work, and your agent does it.

Which is the division worth understanding. A model is already in the loop; it
is not inside the tool. The agent reads the code and proposes, and the tool
runs it and judges, deterministically, with no opinion of its own. Putting a
model inside would duplicate the agent already sitting there, and would trade
the same answer every time for a longer one.

**Then how does it catch things a model would catch?**
It does not. It catches a different class. A model reads a diff and forms an
opinion about it. These checks run the code and report what happened: the
number of outbound calls against the number the decorator claimed, the
mutations no test noticed, the test that passes against the code from before
the fix. A finding here is a transcript, not a prediction, which is why there
is nothing to argue with and nothing to tune.

**Why check a commit, and not the working tree before one?**
It does both. `test-diff` and `mutate` take `--staged`, and the pre-commit
hook uses it. But the checks that go furthest want a commit, for two reasons.

Uncommitted work is not safe around an agent. A review phase that checks out a
branch, or a sweep that resets a file, erases it with no ground truth left to
recover from. That happened twice while this repository was being built, once
destroying three fixes, and it is why `commit-before-mutation` exists and why
`mutate` and `census` refuse to run on a tree that is not clean.

A commit is also something a report can point at later. The rules here ask a
claim to name evidence that outlives the session, a hash, a path, or a
command. "It worked in my editor" is not that. A fix that lands as its own
commit leaves a trace someone can open next month, and the trail of what a
gate caught and what was done about it is worth more than the individual
catch.

**What if my project is not JavaScript?**
The test-half checks cover ten ecosystems and the rules are configurable.
`census` reads TAP and JUnit XML, which most runners emit. `mutate` covers the
C and JavaScript families, Rust, Ruby, PHP, Go, Java, C#, and now Python too:
its comparison and arithmetic operators are the same characters as the C
family, and its boolean literals and connectives (`True`, `False`, `and`,
`or`) get their own rule, checked against the same tree-sitter mask that
already keeps a docstring, an f-string, and a `#` comment out of reach.
`induce` and `validate-report` care about neither language nor runner.

That tree-sitter mask needs one grammar per language, and none of the seven
ships with the package: `npx adg lang add python` (or `rust`, `ruby`, `php`,
`go`, `java`, `csharp`) fetches the one file it needs into `.adg/grammars/`
in your project, once, at the moment you ask. `adg init` reports which of
these languages it finds tracked in your repository and offers to fetch
them; until one is installed, that file's language falls back to the regex
scanner with a warning, not a block.

**What does it cost to run?**
Nothing, and no account. The cost is time: `mutate` and `census` run your
suite many times over, so they belong in a pre-push hook or in CI, never on
every keystroke. The per-edit hooks are the cheap ones.

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

Node 22.18 or newer. One runtime dependency, web-tree-sitter (MIT, zero
dependencies of its own). Run the test suite with `npm test`. Licensed
under Apache 2.0.

Distilled from building a cross-platform desktop application in Rust and Python.
