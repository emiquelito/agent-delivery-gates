# A report claiming more than it proved

`report.md`, written by the agent at the end of a session:

```
Commit abc1234f.

Failures in the retry path are handled.
Errors during upload are recovered without data loss.

## Findings
1. id: F-1, severity: High, description: retry loop lacked a max attempt cap, disposition: fixed.
```

It names a commit, but never says the tree is clean. It says two things
are "handled" and "recovered" with no evidence reference near either
sentence. Its findings section holds one High and nothing else, with no
line saying that was the whole list.

```
$ npx agent-delivery-gates validate-report --report report.md
missing-commit-line high 1: no line states a commit hash together with a clean tree; add a line with a 7-40 character hex hash and wording that the tree is clean, on that line or the next
unproven-robustness-claim critical 3: a robustness claim has no evidence reference on this line or within the next three non-blank lines; add an 'Evidence:' reference on this line or just below it, naming what proves it
unproven-robustness-claim critical 4: a robustness claim has no evidence reference on this line or within the next three non-blank lines; add an 'Evidence:' reference on this line or just below it, naming what proves it
finding-list-incomplete high 6: the findings section lists no Low or Info entry and never states that there were none; add the missing entries or an explicit statement such as 'no Low or Info findings'
```

Exit code 1. Every line number in that output points at a real line in
`report.md` above; nothing here is guessed at from the summary.
