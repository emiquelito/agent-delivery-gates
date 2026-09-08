# Worked examples

Each file below is one scenario, run for real, with the exact commands and
the exact output they produced. Nothing here is paraphrased.

1. [A test edited to match a bug](01-test-edited-to-match-a-bug.md). A
   fix reaches green by changing what the test expects, not the code.
   `agent-delivery-gates test-diff` names it.
2. [A report claiming more than it proved](02-report-claiming-more-than-it-proved.md).
   `agent-delivery-gates validate-report` against a report that says
   "handled" and "recovered" with nothing behind either claim.
3. [An edit blocked mid-review](03-edit-blocked-mid-review.md). The
   clean-tree hook refuses to let a review phase mutate a dirty tree.
4. [Adopting the gates on a repository that already exists](04-adopting-on-an-existing-repository.md).
   `agent-delivery-gates init` with a baseline, then a clean commit and a
   caught one.

See the [README](../../README.md) for what these tools are and how they get
wired into a project.
