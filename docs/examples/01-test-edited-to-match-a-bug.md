# A test edited to match a bug

A shopping cart is supposed to apply a bulk discount, and never got the
feature. The test that checks it is red, correctly:

```
$ node --test tests/*.test.js
# tests 2
# pass 1
# fail 1
# skipped 0
```

An agent asked to fix the failing test makes it pass by editing what the
test expects, from 108 to 120, so the assertion now agrees with the
missing feature instead of the feature agreeing with the assertion.

```
$ node --test tests/*.test.js
# tests 2
# pass 2
# fail 0
# skipped 0
```

Fully green, nothing skipped. What a reviewer sees in the diff:

```
$ git show --stat --format='' HEAD
 tests/cart.test.js | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
```

One file, one line. What the tool says:

```
$ npx agent-delivery-gates test-diff --rev HEAD
Source diff:
  (no source files changed)

Test diff:
  tests/cart.test.js  +1 -1

Signals (1):
  assertion-weakened high tests/cart.test.js: an assertion kept its form while the value it expects changed; confirm the test was not edited to match the behavior
    assert.equal(total([{ price: 60, qty: 2 }]), 108);  ->  assert.equal(total([{ price: 60, qty: 2 }]), 120);
```

Exit code 1. No source file changed at all, which is the detail a
one-line diff hides: the fix did not touch `cart.js`, it touched the
number the test compares against.
