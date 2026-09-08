# An edit blocked mid-review

`commit-before-mutation` exists because a reviewer's checkout once wiped
uncommitted work with nothing left to reconstruct against. The hook that
enforces it, `hooks/pre-mutation-clean-tree.ts`, only turns on once a
phase is set: writing `review` into `.claude/adg-phase` turns it on for
that session. The file is listed in `.gitignore`, so setting it is local
to one checkout and never reaches anyone else's session or gets carried
into history.

With the phase set to `review` and `pricing.js` modified but not
committed, an edit call is blocked before it runs:

```
pre-mutation-clean-tree: the working tree is not clean.
Commit the work before this phase mutates anything: a reviewer's checkout can destroy uncommitted work with no ground truth left.
Dirty paths (porcelain status code, then path):
   M pricing.js
```

Exit code 2. Committing `pricing.js` first, so the tree is clean when a
reviewer starts breaking and restoring code, is what lets the hook stand
down and the review proceed.
