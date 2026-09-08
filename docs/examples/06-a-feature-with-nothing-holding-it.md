# A feature that shipped with nothing holding it

A shopping cart with four tests, all passing.

```
$ node --test tests/*.test.js
# tests 4
# pass 4
# fail 0
```

An agent is asked to add promo codes. It does. It also adds three tests for
the new behaviour, and the commit is what anyone would want to see:

```
$ git show --stat --format='' HEAD
 src/cart.js        | 20 +++++++++++++++++---
 tests/cart.test.js | 18 +++++++++++++++---
 2 files changed, 32 insertions(+), 6 deletions(-)
```

```
$ node --test tests/*.test.js
# tests 7
# pass 7
# fail 0
```

Four tests became seven. Nothing failed. The feature works. Coverage went up.

A customer whose cart comes to exactly 50 has just started paying for
shipping.

## What actually happened

Two things, in the same commit.

While rewriting `shipping`, the threshold changed from `>= 50` to `> 50`. The
test that covered it, `a cart at the threshold ships free`, went red. It was
not fixed. Its assertion was replaced:

```
assert.equal(shipping(two), 0);   ->   assert.ok(shipping(two) <= 5);
```

The new assertion is true whatever the code does, because shipping is either
0 or 5. The test still runs, still passes, still counts toward the total, and
can never fail again.

The three new tests are the second half. They check that a promo code sets a
flag, that an unknown code does not, and that a discount is a number. None of
them checks any money. The one line that computes what the customer pays has
nothing asserting on it at all.

## What the tools say

The diff check reads the test half of the change on its own:

```
$ npx agent-delivery-gates test-diff --rev HEAD
Source diff:
  src/cart.js  +17 -3

Test diff:
  tests/cart.test.js  +15 -3

Signals (1):
  assertion-weakened high tests/cart.test.js: an assertion was replaced by one that proves less; confirm the check was not loosened to reach green
    assert.equal(shipping(two), 0);  ->  assert.ok(shipping(two) <= 5);
```

Exit code 1. That is the quiet edit, with the before and the after side by
side, out of eighteen added lines.

The mutation command answers the other half, by breaking the code on purpose
and watching what the suite does:

```
$ npx agent-delivery-gates mutate --paths src/cart.js
Command: npm test
Baseline: passed in 1.2s
Files: src/cart.js
Mutations: 5 planned, 5 attempted

killed 2, survived 3, timeout 0, skipped 0

Survivors (3):
  src/cart.js:13:26  comparison-boundary  > to >=
    before: return subtotal(items) > 50 ? 0 : 5;
    after:  return subtotal(items) >= 50 ? 0 : 5;
  src/cart.js:23:28  arithmetic  - to +
    before: total: subtotal(items) - discount + shipping(items),
    after:  total: subtotal(items) + discount + shipping(items),
  src/cart.js:23:39  arithmetic  + to -
    before: total: subtotal(items) - discount + shipping(items),
    after:  total: subtotal(items) - discount - shipping(items),
```

Exit code 1.

Read the first survivor again. Putting the threshold back to `>= 50`, which
is what the code said yesterday, changes nothing the suite can see. The
weakened test no longer minds either answer, so the bug and its repair are
now indistinguishable to this project.

The other two are the promo line. The total can be computed by adding the
discount instead of taking it off, or by subtracting the shipping instead of
adding it, and seven passing tests stay green through both. A customer would
be charged the wrong amount in three separate ways and this suite would say
the work is fine.

## Why this one is hard to catch

Everything a reviewer usually looks at got better. The test count went up, not
down, so a check that watches for tests disappearing sees the opposite of
trouble. The feature is real and works. Continuous integration is green. The
diff is small enough to read in a minute, and reading it is exactly what does
not help: one line in eighteen is the problem, and it looks like tidying.

The two tools answer different questions. One asks what changed in the tests
and reports a check that got weaker. The other ignores the diff entirely,
breaks the code, and reports what no test noticed. The first found the edit.
The second found that the new tests were never holding the feature they were
written for.
