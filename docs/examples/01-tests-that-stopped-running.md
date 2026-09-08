# Tests that stopped running

A refund module with four tests, all passing.

```
$ node --test tests/*.test.js
# tests 4
# pass 4
# fail 0
```

An agent is asked to record a timestamp on each refund. It does that, and in
the same commit it tidies the test layout, renaming `tests/refund.test.js` to
`tests/refund.spec.helper.js`.

The suite afterwards:

```
$ node --test tests/*.test.js
# tests 0
# pass 0
# fail 0
```

Nothing failed, because nothing ran. The runner collects `tests/*.test.js` and
the file no longer matches. All four tests are still in the repository, still
full of assertions, and never executed again.

Here is the whole of what a reviewer sees:

```
$ git show --stat --format='' HEAD
 src/refund.js                                   | 2 +-
 tests/{refund.test.js => refund.spec.helper.js} | 0
 2 files changed, 1 insertion(+), 1 deletion(-)
```

Zero lines against the test file. Git is right: not one character of it
changed. The source file did change, so this is not a commit that only touches
tests, and a reviewer scanning for that pattern would see nothing to stop on.

What the tool says:

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

## Why this one is hard to catch

Every other check a project runs says the work is fine. The tests pass,
because there are none to fail. Coverage of the lines that remain is
unchanged. The diff is one line of source and a rename of nothing. A linter
sees valid code. Continuous integration goes green.

The only thing that gives it away is the count of tests dropping, and nobody
reads that number on a passing build.

## What the tool is doing

It reads the diff of the commit, splits it into the source half and the test
half, and asks a separate question of the test half: did anything here get
weaker. A file leaving the naming convention its runner globs on is one of
seven things it names. The others are an assertion removed, an assertion
swapped for one that proves less, an assertion whose expected value changed
while the call stayed the same, a test case removed, a skip added, and a
tolerance or timeout changed.

Rename detection has to be asked for. Without it git reports a rename as one
file added and another deleted, and the rename is never there to find.
