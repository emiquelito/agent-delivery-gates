# Test-only environment variables

This project ships three: `ADG_TEST_MCP_STALL` in `src/mcp-server.ts`,
and `ADG_TEST_FORCE_GRAMMAR_FAILURE` and `ADG_TEST_FORCE_GRAMMAR_ABSENT`,
both in `src/code-mask.ts`. All three exist because a real subprocess
reached a state a unit test could not otherwise reach without touching the
filesystem or the network in a way a killed test run could leave broken.
This is the rule the next one has to meet.

An `ADG_TEST_*` variable may only select a test-reachable path that already
exists for a real reason: a real load failure, a real stalled response. It
may never add behavior that only exists for testing, and it may never
change what a production run decides, only which route in the existing
decision it takes. `ADG_TEST_FORCE_GRAMMAR_FAILURE` picks the "the package
is present and the load still broke" branch a corrupt install or an ABI
mismatch hits; `ADG_TEST_FORCE_GRAMMAR_ABSENT` picks the separate "the
package was never installed" branch an ordinary `npm install` of this
tool's own devDependencies hits for nearly every adopter (see
src/code-mask.ts's STOP-GAP comment above `grammarAbsentExtensions` for
why those two are no longer the same branch). Neither adds a new branch.

A production code path may branch on an `ADG_TEST_*` variable only to
choose which real, already-existing path to take, at the single point
closest to the external state it stands in for (a package import, a
promise that resolves). Nothing downstream of that point may re-check the
variable: everything after reads the same recorded fact (a Set, a cached
service) a real failure would have left, so a bug in the downstream code
is exercised the same way in a test as it would be for a real user.

What protects a user who sets one by accident: the name. `ADG_TEST_` is a
prefix no production flag in this project uses and no adopter has a
reason to set; the acceptance is that the cost of a name nobody sets by
accident is a variable that is easy to grep for, not a variable proven
impossible to trigger. Beyond the name, nothing about a forced failure is
allowed to look different from a real one: same recorded state, same
downstream message, same exit code. A user who sets one by accident sees
exactly what they would see from the real failure it stands in for, never
something worse and never something silent.

All three conform. `ADG_TEST_MCP_STALL` selects
between two already-real ways a promise can stall a server's close
handler (a live timer, or nothing at all), gated behind a method this
server never advertises and no template ever wires up, so reaching it at
all takes a caller that already knows the name. `ADG_TEST_FORCE_GRAMMAR_FAILURE`
and `ADG_TEST_FORCE_GRAMMAR_ABSENT` are each read once, at the one point
`resolveTreeSitterService` would otherwise call the real loader, and only
to skip straight to the same recording a thrown import already takes --
`grammarGenuineFailures` for the first, `grammarAbsentExtensions` for the
second; every caller downstream, `hadLanguageLoadFailure`,
`hadGenuineGrammarLoadFailure`, and `hadGrammarAbsent` included, reads
whichever recorded fact resulted and cannot tell a forced one from a real
one.
