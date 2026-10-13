// Tells a mutation that never compiled apart from one the suite caught.
//
// A kill is a claim that the test suite noticed the change. A mutation the
// compiler rejected proves nothing about the tests: no test ran. So when
// the command's own output shows a compiler's failure, the verdict is
// "build-failed", which is unmeasured (exit 3), not "killed".
//
// Detection is from output and so is language-specific. The rule is to be
// conservative in the direction that does not lie: only a marker a
// toolchain itself prints, seen in real output, counts, and a run that
// also shows a test failing is left as a kill, because a real kill must
// never be demoted on a guess. Anything not recognised stays "killed",
// exactly as before this check existed.
//
// COVERED (each pattern taken from real output):
//   Go     `go test`: a line `FAIL<tab>pkg [build failed]`. Skipped when
//          the output also has a `--- FAIL:` line, since another package
//          in the same run then really failed a test.
//   Rust   `cargo test` / `cargo build`: a line `error: could not compile
//          `crate` ...`. Skipped when `test result: FAILED` is present.
//   TypeScript  `tsc` run inside the command: `file.ts(1,5): error TS2322:`
//          or a bare `error TS5023:`. Not guarded against test failures: a
//          suite whose own output quotes tsc diagnostics could be
//          misclassified.
//
// NOT COVERED, so a build failure there is still counted as a kill:
//   C and C++ (gcc, clang, make, cmake), Java (javac, Maven, Gradle),
//   Kotlin, Scala, C#/.NET, Swift, Zig, Haskell, OCaml, Go commands that
//   are not `go test` (a plain `go build` prints no marker, only
//   `# pkg`), Go `[setup failed]`, and any other compiled language or
//   wrapper script that hides the compiler's output. Interpreted languages
//   (Python, JavaScript without tsc, Ruby, PHP) have no compile step to
//   detect; a syntax error there is indistinguishable from a failing test.

const GO_BUILD_FAILED = /^FAIL\t\S+ \[build failed\]\s*$/m;
const GO_TEST_FAILED = /^\s*--- FAIL: /m;
const RUST_COULD_NOT_COMPILE = /^error: could not compile /m;
const RUST_TEST_FAILED = /^test result: FAILED\./m;
const TSC_DIAGNOSTIC = /(?:^|\n)(?:[^\n]*\(\d+,\d+\): )?error TS\d+: /;

/** True only when the output shows a compiler rejecting the code. */
export function isBuildFailure(output: string): boolean {
  if (GO_BUILD_FAILED.test(output) && !GO_TEST_FAILED.test(output)) return true;
  if (RUST_COULD_NOT_COMPILE.test(output) && !RUST_TEST_FAILED.test(output)) return true;
  if (TSC_DIAGNOSTIC.test(output)) return true;
  return false;
}
