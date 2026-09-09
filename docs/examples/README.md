# Worked examples

Each file below is one scenario, run for real, with the exact commands and
the exact output they produced. Nothing here is paraphrased.

1. [Tests that stopped running](01-tests-that-stopped-running.md). A test
   file renamed so the runner no longer collects it. Four tests gone, suite
   green, zero lines changed in the diff.
2. [A test edited to match a bug](02-test-edited-to-match-a-bug.md). A
   fix reaches green by changing what the test expects, not the code.
   `agent-delivery-gates test-diff` names it.
3. [A report claiming more than it proved](03-report-claiming-more-than-it-proved.md).
   `agent-delivery-gates validate-report` against a report that says
   "handled" and "recovered" with nothing behind either claim.
4. [An edit blocked mid-review](04-edit-blocked-mid-review.md). The
   clean-tree hook refuses to let a review phase mutate a dirty tree.
5. [Adopting the gates on a repository that already exists](05-adopting-on-an-existing-repository.md).
   `agent-delivery-gates init` with a baseline, then a clean commit and a
   caught one.
6. [A feature that shipped with nothing holding it](06-a-feature-with-nothing-holding-it.md).
   Four tests become seven, all passing, and a customer starts paying for
   shipping. `test-diff` finds the weakened assertion, `mutate` finds that
   the new tests never held the feature.
7. [A retry that never retries](07-a-retry-that-never-retries.md). An
   idiomatic retry decorator that makes one call instead of three, and hands
   a 503 body to the caller as though it were data. An induced 503 is what
   tells the two versions apart.

See the [README](../../README.md) for what these tools are and how they get
wired into a project.
