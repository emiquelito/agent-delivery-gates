# Adopting the gates on a repository that already exists

An existing project, with its own prose already in `README.md` and a
comment nobody has gotten around to rewriting. Running `init` writes the configuration for every agent it supports and
touches nothing that is already there:

```
$ npx agent-delivery-gates init
created: .githooks/pre-commit
created: AGENTS.md
created: docs/gate-tally.md
created: .github/workflows/agent-delivery-gates.yml
created: .cursor/hooks.json
created: .codex/hooks.json
created: .github/hooks/agent-delivery-gates.json
created: .mcp.json
created: .cursor/mcp.json
created: .vscode/mcp.json
created: .windsurf/mcp.json
created: .adg/prose-rules.txt
created: .adg/prose-baseline.txt (2 match(es) recorded)

The prose gate stays off until a project says what it wants checked. The word
list is a project's own, never this one's. A team writes theirs into
`.adg/prose-rules.txt`:

```
# Words this team does not want in its own documentation.
\bbest-in-class\b
\bworld-class\b
\bbulletproof\b
\bfuture-proof\b
```

Two of those are already in the repository, in prose nobody is going to
rewrite today. Recording them takes one command:

```
$ npx agent-delivery-gates scan-prose --write-baseline .adg/prose-baseline.txt
scan-prose: wrote 2 match(es) to .adg/prose-baseline.txt
```

From here a commit that adds nothing new passes, and the two already there are
left alone:

```
$ npx agent-delivery-gates scan-prose --require-rules --baseline .adg/prose-baseline.txt
scan-prose: scanned 2 file(s), 0 contained matches
scan-prose: baseline .adg/prose-baseline.txt: 2 found, 2 forgiven, 0 new
scan-prose: 0 baseline entries not seen this run (fixed; safe to delete from .adg/prose-baseline.txt)
```

Exit code 0. Adding a new one stops the commit:

```
$ npx agent-delivery-gates scan-prose --require-rules --baseline .adg/prose-baseline.txt
README.md:5:Our new dashboard is world-class.
scan-prose: scanned 2 file(s), 1 contained matches
scan-prose: baseline .adg/prose-baseline.txt: 3 found, 2 forgiven, 1 new
scan-prose: 0 baseline entries not seen this run (fixed; safe to delete from .adg/prose-baseline.txt)
```

Exit code 1. The baseline is meant to shrink. The last line counts entries
that were recorded and are no longer there, so a team can delete them as the
old prose gets rewritten.

This is why the gate ships with no word list at all. A project that says
nothing gets nothing checked, and a message saying so.
