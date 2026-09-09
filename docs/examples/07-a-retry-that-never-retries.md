# A retry that never retries

A pull request adds resilience to an HTTP client. Four lines of Python, and
every reviewer approved it.

```python
@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=0.01))
def fetch_quote(vin):
    r = session.get(f"{BASE}/quotes/{vin}", timeout=5)
    return r.json()
```

A retry decorator, three attempts, exponential backoff, and a timeout on the
request. It reads as correct because it is idiomatic. This is close to what
the library's own documentation shows.

It retries zero times.

## What actually happened

`requests` does not raise on a 503. A 503 is a response like any other, and
`session.get` returns it. Tenacity's default condition retries on an
exception, and no exception was raised, so the first call is also the last
one.

The second half is worse than a missing retry. The 503 body is JSON, because
the upstream service explains itself in the body. `.json()` parses it without
complaint and hands back a dictionary. The caller receives an error payload
where it expected a quote, and carries on with it. The outage arrives as a
wrong answer, not as a failure.

## Making the failure happen

Twenty lines of ordinary test tooling. `responses` stubs the transport and
counts what went out.

```python
import responses
import client

VIN = "1HGCM82633A004352"


@responses.activate
def test_retries_three_times_on_503():
    responses.add(
        responses.GET,
        f"{client.BASE}/quotes/{VIN}",
        json={"error": "upstream unavailable"},
        status=503,
    )
    try:
        result = client.fetch_quote(VIN)
    except Exception as exc:
        print("outbound calls:", len(responses.calls))
        print("raised:", type(exc).__name__)
        return
    print("outbound calls:", len(responses.calls))
    print("returned:", result)


test_retries_three_times_on_503()
```

Against the code above:

```
$ python3 test_client.py
outbound calls: 1
returned: {'error': 'upstream unavailable'}
```

One outbound call, against a claim of three. And the caller was handed a
dictionary, so nothing downstream has any way to know the quote is not a
quote.

One line changes it:

```python
    r = session.get(f"{BASE}/quotes/{vin}", timeout=5)
    r.raise_for_status()
    return r.json()
```

The same test, not edited:

```
$ python3 test_client.py
outbound calls: 3
raised: RetryError
```

Three attempts, backoff between them, and a `RetryError` at the end. Now the
decorator does what the pull request said it did.

## What the tools say

Nothing in this repository found this bug. No hook reads Python source and
works out that a retry condition can never fire, and `mutate` does not touch
Python at all, which `src/mutate.ts` states where it lists the extensions it
was written for.

What the catalog does say is in `rules/induced-failure-required.json`. A
report sentence of the form "retry logic verified" is a robustness claim, and
the obligation sits with the author: make the failure happen, watch the
handling fire, and point the claim at evidence someone else can open later.
Here is that report with the claim pointing at the session it was written in:

```
Commit 4f9a1c2, tree clean.

Retry on 503 is handled: three attempts with exponential backoff.
Evidence: confirmed in this session.

## Findings
1. id: F-1, severity: High, description: fetch_quote did not raise on 5xx, disposition: fixed.
No Medium, Low, or Info findings.
```

```
$ npx agent-delivery-gates validate-report --report report-bad.md
evidence-not-durable high 4: this evidence reference points only at context, not at anything that outlives it; point at a git hash (7-40 hex characters), a repo file path, or a test command in backticks
```

Exit code 1. Replacing that one line with the command that produced the run
above:

```
Evidence: `python3 test_client.py`, three outbound calls and a RetryError.
```

```
$ npx agent-delivery-gates validate-report --report report.md
```

No output, exit code 0.

Be clear about what that second run proves. The hook checked that a
robustness claim carries an evidence reference, and that the reference points
at something durable, a commit, a path, or a command, instead of at a
conversation. It did not open the command, run it, or check that the failure
named in the evidence is the failure the claim is about. The rule record says
so in its own words: it "does not read the evidence to confirm the failure
named there is the one the claim is about." The identical report would pass
against the broken client. What the gate buys is that the claim now names
something a reviewer can go and run, and running it takes about a second.

## Why this one is hard to catch

Every signal a reviewer reads is positive. The decorator is there, the
attempt count is there, the backoff is there, the timeout is there. The code
is shorter and calmer than a hand-rolled loop would be, and reviewing a diff
means reading what the code says, which in this case is a description of
behaviour the code does not have.

Tests do not help by default either. A happy-path test passes on both
versions, because both versions return `r.json()` on a 200. Coverage is full:
every line of `fetch_quote` executes on the first call. The problem is a line
that is absent, and a check that reads the lines present has nothing to read.

The only thing that separates the two versions is an induced 503, and the
number to read is not pass or fail. It is the count of outbound calls: one,
where the pull request said three.
