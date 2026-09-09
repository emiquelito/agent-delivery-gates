// Tests for src/prose-scan.ts, the pure core of the prose scan. Everything
// here runs in process against the exported functions: no spawning, no temp
// repositories, no files at all. The rules loader takes its file access as an
// argument, so an include tree, a cycle, and an unreadable file are all built
// from a plain map here.
//
// The behaviour a caller sees is covered in tests/prose-scan-cli.test.ts.
// This file covers the decisions underneath it, one at a time, so a failure
// names the decision that broke instead of the whole command.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BASELINE_SEPARATOR,
  PatternError,
  ProseScanError,
  SUPPORTED_POSIX_CLASSES,
  baselineEntriesNotSeen,
  baselineKey,
  buildPatternSource,
  emptyRules,
  exitCodeFor,
  fencedLineNumbers,
  formatBaseline,
  formatReport,
  isProseFile,
  loadRules,
  parseBaseline,
  rulesAreEmpty,
  scan,
  splitLines,
  translateEre,
  trimText,
  type Rules,
  type RulesFileSystem,
} from "../src/prose-scan.ts";

const BANNED_WORD = "seam" + "lessly";

// --- POSIX extended regex, translated for JavaScript -------------------------

test("every supported POSIX class is named in the exported list", () => {
  assert.deepEqual([...SUPPORTED_POSIX_CLASSES].sort(), [
    "alnum",
    "alpha",
    "digit",
    "lower",
    "punct",
    "space",
    "upper",
  ]);
});

const CLASS_CASES: ReadonlyArray<[string, string, readonly string[], readonly string[]]> = [
  ["alpha", "[[:alpha:]]", ["a", "Z"], ["1", " ", "-"]],
  ["digit", "[[:digit:]]", ["0", "9"], ["a", " "]],
  ["alnum", "[[:alnum:]]", ["a", "Z", "7"], [" ", "-"]],
  ["upper", "[[:upper:]]", ["A"], ["1", " "]],
  ["lower", "[[:lower:]]", ["a"], ["1", " "]],
  ["space", "[[:space:]]", [" ", "\t", "\n", "\v", "\f", "\r"], ["a", "\u00a0", "\u2003"]],
  ["punct", "[[:punct:]]", ["!", "/", ":", "@", "[", "`", "{", "~", "\\", "]", "-"], ["a", "0", " "]],
];

for (const [name, fragment, hits, misses] of CLASS_CASES) {
  test(`[:${name}:] translates to a class matching what POSIX says it matches`, () => {
    const re = new RegExp(translateEre(fragment));
    for (const hit of hits) assert.equal(re.test(hit), true, `${JSON.stringify(hit)} should match [:${name}:]`);
    for (const miss of misses) {
      assert.equal(re.test(miss), false, `${JSON.stringify(miss)} should not match [:${name}:]`);
    }
  });
}

test("a POSIX class inside a wider bracket expression keeps the rest of the expression", () => {
  const re = new RegExp(translateEre("x[[:digit:]q-s_]y"));
  for (const hit of ["x4y", "xqy", "xry", "x_y"]) assert.equal(re.test(hit), true, hit);
  for (const miss of ["xzy", "xay", "x y"]) assert.equal(re.test(miss), false, miss);
});

test("two POSIX classes in one bracket expression are both translated", () => {
  const re = new RegExp(translateEre("[[:upper:][:digit:]]"));
  assert.equal(re.test("Q"), true);
  assert.equal(re.test("4"), true);
  assert.equal(re.test("q"), false);
});

test("a negated bracket expression keeps its negation", () => {
  const re = new RegExp(translateEre("[^[:space:]]"));
  assert.equal(re.test("x"), true);
  assert.equal(re.test(" "), false);
});

test("a closing bracket in first position stays a literal one", () => {
  const re = new RegExp(translateEre("[]x]"));
  assert.equal(re.test("]"), true);
  assert.equal(re.test("x"), true);
  assert.equal(re.test("y"), false);
});

test("a backslash inside a bracket expression is the ordinary character POSIX says it is", () => {
  const re = new RegExp(translateEre("[\\x]"));
  assert.equal(re.test("\\"), true);
  assert.equal(re.test("x"), true);
  assert.equal(re.test("n"), false);
});

test("the spaced hyphen fragment this repository uses translates and still matches", () => {
  const re = new RegExp(translateEre("[[:alpha:]] - [[:alpha:]]"), "i");
  assert.equal(re.test("the gate fired - the build stopped"), true);
  assert.equal(re.test("total - count"), true);
  assert.equal(re.test("a -b"), false);
});

test("an ordinary fragment passes through unchanged", () => {
  assert.equal(translateEre("\\bwidget\\b"), "\\bwidget\\b");
  assert.equal(translateEre("^a+(b|c)?$"), "^a+(b|c)?$");
});

const REFUSED: ReadonlyArray<[string, string, RegExp]> = [
  ["an untranslatable POSIX class", "[[:xdigit:]]", /\[:xdigit:\]/],
  ["a misspelled POSIX class", "[[:alfa:]]", /\[:alfa:\]/],
  ["a POSIX class this scan does not carry", "[[:blank:]]", /\[:blank:\]/],
  ["a collating element", "[[.hyphen.]]", /collating element/],
  ["an equivalence class", "[[=a=]]", /equivalence class/],
  ["a GNU-only start-of-word anchor", "\\<widget", /GNU-only anchor/],
  ["a GNU-only end-of-word anchor", "widget\\>", /GNU-only anchor/],
  ["a GNU-only buffer anchor", "\\`start", /GNU-only anchor/],
  ["an unterminated bracket expression", "[abc", /never closes/],
  ["a trailing backslash", "widget\\", /ends with a backslash/],
];

for (const [what, fragment, reason] of REFUSED) {
  test(`${what} is refused, loudly, naming the fragment`, () => {
    assert.throws(
      () => translateEre(fragment),
      (err: unknown) => {
        assert.ok(err instanceof PatternError, "a refusal must be a PatternError");
        assert.ok(err instanceof ProseScanError, "a refusal must be reportable as exit 2");
        assert.equal(err.fragment, fragment);
        assert.match(err.message, reason);
        assert.match(err.message, /cannot use the rule fragment/);
        return true;
      },
    );
  });
}

test("fragments are joined with a pipe, and an empty list yields an empty source", () => {
  assert.equal(buildPatternSource(["\\ba\\b", "\\bb\\b"]), "\\ba\\b|\\bb\\b");
  assert.equal(buildPatternSource([]), "");
});

// --- prose versus source ------------------------------------------------------

test("the extension test folds case and covers every source extension", () => {
  for (const path of ["a.ts", "a.TS", "dir/a.tsx", "a.JS", "a.mjs", "a.CJS", "a.sh", "a.Sh"]) {
    assert.equal(isProseFile(path), false, path);
  }
  for (const path of ["a.md", "a.MD", "a.json", "a.txt", "NOTICE", "dir/.gitignore", "a.tsx.md"]) {
    assert.equal(isProseFile(path), true, path);
  }
});

// --- fenced code blocks -------------------------------------------------------

test("a fence marks its own lines and everything between them", () => {
  const text = ["before", "```", "inside", "```", "after", ""].join("\n");
  assert.deepEqual([...fencedLineNumbers(text)].sort((a, b) => a - b), [2, 3, 4]);
});

test("an indented fence still opens a block", () => {
  const text = ["  ```sh", "inside", "\t```", "after", ""].join("\n");
  assert.deepEqual([...fencedLineNumbers(text)].sort((a, b) => a - b), [1, 2, 3]);
});

test("a fence left open runs to the end of the file", () => {
  const text = ["```", "one", "two", ""].join("\n");
  assert.deepEqual([...fencedLineNumbers(text)].sort((a, b) => a - b), [1, 2, 3]);
});

test("a file with no fence has no fenced lines", () => {
  assert.equal(fencedLineNumbers("one\ntwo\n").size, 0);
});

// --- lines and trimming -------------------------------------------------------

test("a trailing newline ends the last line and does not begin an empty one", () => {
  assert.deepEqual(splitLines("a\nb\n"), ["a", "b"]);
  assert.deepEqual(splitLines("a\nb"), ["a", "b"]);
  assert.deepEqual(splitLines(""), []);
  assert.deepEqual(splitLines("\n"), [""]);
});

test("trimming takes the edges and leaves the middle alone", () => {
  assert.equal(trimText("  a\tb  "), "a\tb");
  assert.equal(trimText("\t \r"), "");
  assert.equal(trimText("a"), "a");
});

// --- rules loading ------------------------------------------------------------

function fsFrom(files: Record<string, string>): RulesFileSystem {
  return {
    isFile: (path) => Object.prototype.hasOwnProperty.call(files, path),
    realPath: (path) => path,
    dirName: (path) => path.slice(0, path.lastIndexOf("/")) || "/",
    isAbsolute: (path) => path.startsWith("/"),
    join: (dir, rel) => `${dir}/${rel}`,
    readText: (path) => {
      const text = files[path];
      if (text === undefined) throw new Error("no such file");
      return text;
    },
  };
}

test("a rules file sorts its lines into fragments, prose-only fragments, and excludes", () => {
  const rules = loadRules(
    "/r/rules.txt",
    fsFrom({
      "/r/rules.txt": [
        "# a comment",
        "   ",
        "\\bwidget\\b",
        "   \\bgadget\\b",
        "prose-only: [[:alpha:]] - [[:alpha:]]",
        "exclude: dist/*",
        "   # an indented comment",
        "",
      ].join("\n"),
    }),
  );
  assert.deepEqual(rules.fragments, ["\\bwidget\\b", "\\bgadget\\b"]);
  assert.deepEqual(rules.proseOnly, ["[[:alpha:]] - [[:alpha:]]"]);
  assert.deepEqual(rules.excludes, ["dist/*"]);
});

test("an include is resolved against the including file's own directory", () => {
  const rules = loadRules(
    "/r/root.txt",
    fsFrom({
      "/r/root.txt": "include: nested/mid.txt\n\\btop\\b\n",
      "/r/nested/mid.txt": "include: leaf.txt\n",
      "/r/nested/leaf.txt": "\\bleaf\\b\n",
    }),
  );
  assert.deepEqual(rules.fragments, ["\\bleaf\\b", "\\btop\\b"]);
});

test("an absolute include path is used as it stands", () => {
  const rules = loadRules(
    "/r/root.txt",
    fsFrom({ "/r/root.txt": "include: /other/leaf.txt\n", "/other/leaf.txt": "\\bleaf\\b\n" }),
  );
  assert.deepEqual(rules.fragments, ["\\bleaf\\b"]);
});

test("an include cycle is refused instead of recursing forever", () => {
  assert.throws(
    () =>
      loadRules(
        "/r/a.txt",
        fsFrom({ "/r/a.txt": "include: b.txt\n", "/r/b.txt": "include: a.txt\n" }),
      ),
    (err: unknown) => {
      assert.ok(err instanceof ProseScanError);
      assert.match(err.message, /include cycle/);
      return true;
    },
  );
});

test("a rules file that includes itself is refused", () => {
  assert.throws(
    () => loadRules("/r/a.txt", fsFrom({ "/r/a.txt": "include: a.txt\n" })),
    /include cycle/,
  );
});

test("the same file included down two branches is not a cycle", () => {
  const rules = loadRules(
    "/r/root.txt",
    fsFrom({
      "/r/root.txt": "include: one.txt\ninclude: two.txt\n",
      "/r/one.txt": "include: leaf.txt\n",
      "/r/two.txt": "include: leaf.txt\n",
      "/r/leaf.txt": "\\bleaf\\b\n",
    }),
  );
  assert.deepEqual(rules.fragments, ["\\bleaf\\b", "\\bleaf\\b"]);
});

test("a missing rules file is refused by name", () => {
  assert.throws(() => loadRules("/r/absent.txt", fsFrom({})), /rules file '\/r\/absent.txt' does not exist/);
});

test("a rules file with nothing but comments counts as no rules", () => {
  const rules = loadRules("/r/a.txt", fsFrom({ "/r/a.txt": "# one\n\n   \n" }));
  assert.equal(rulesAreEmpty(rules), true);
  assert.equal(rulesAreEmpty(emptyRules()), true);
});

test("a rules file holding only an exclude still counts as no rules", () => {
  const rules = loadRules("/r/a.txt", fsFrom({ "/r/a.txt": "exclude: dist/*\n" }));
  assert.equal(rulesAreEmpty(rules), true);
});

test("a prose-only fragment alone counts as rules", () => {
  const rules = loadRules("/r/a.txt", fsFrom({ "/r/a.txt": "prose-only: \\bwidget\\b\n" }));
  assert.equal(rulesAreEmpty(rules), false);
});

// --- baselines ----------------------------------------------------------------

test("a baseline entry is keyed on the file and the trimmed text, never the line number", () => {
  assert.equal(baselineKey("p.md", "a widget"), `p.md${BASELINE_SEPARATOR}a widget`);
});

test("a baseline round-trips through its file format", () => {
  const counts = new Map([
    [baselineKey("b.md", "a widget"), 3],
    [baselineKey("a.md", "z widget"), 1],
    [baselineKey("a.md", "a widget"), 2],
  ]);
  const text = formatBaseline(counts);
  assert.match(text, /^# Prose scan baseline/);
  const entries = text.split("\n").filter((l) => l !== "" && !l.startsWith("#"));
  assert.deepEqual(entries, ["2\ta.md\ta widget", "1\ta.md\tz widget", "3\tb.md\ta widget"]);
  assert.deepEqual(parseBaseline(text, "base.txt"), counts);
});

test("a comment and a blank line in a baseline are ignored", () => {
  const parsed = parseBaseline("# header\n\n   \n2\tp.md\ta widget\n", "base.txt");
  assert.deepEqual(parsed, new Map([[baselineKey("p.md", "a widget"), 2]]));
});

test("a baseline entry whose count is not a number is refused by line", () => {
  assert.throws(
    () => parseBaseline("two\tp.md\ta widget\n", "base.txt"),
    /baseline file 'base.txt' has a malformed entry: 'two\tp.md\ta widget'/,
  );
});

test("a baseline entry keeps a tab inside the matching text", () => {
  const parsed = parseBaseline("1\tp.md\ta\twidget\n", "base.txt");
  assert.deepEqual(parsed, new Map([[baselineKey("p.md", "a\twidget"), 1]]));
});

test("baseline entries not seen this run are counted", () => {
  const baseline = new Map([
    [baselineKey("p.md", "a widget"), 1],
    [baselineKey("p.md", "gone widget"), 1],
  ]);
  const counts = new Map([[baselineKey("p.md", "a widget"), 1]]);
  assert.equal(baselineEntriesNotSeen(baseline, counts), 1);
});

// --- the scan -----------------------------------------------------------------

function rulesOf(fragments: string[], proseOnly: string[] = [], excludes: string[] = []): Rules {
  return { fragments, proseOnly, excludes };
}

function readerFor(files: Record<string, string>): (path: string) => string {
  return (path) => {
    const text = files[path];
    if (text === undefined) throw new Error("no such file");
    return text;
  };
}

test("a match is reported as file, line number, and the line as it stands", () => {
  const result = scan({
    rules: rulesOf(["\\bwidget\\b"]),
    files: ["p.md"],
    readText: readerFor({ "p.md": "clean\n  a widget here\n" }),
  });
  assert.deepEqual(result.matchLines, ["p.md:2:  a widget here"]);
  assert.equal(result.matchedFiles, 1);
  assert.equal(result.scannedFiles, 1);
  assert.equal(result.totalMatches, 1);
  assert.equal(result.newMatches, 1);
  assert.equal(exitCodeFor(result), 1);
});

test("matching folds case, as grep -i did", () => {
  const result = scan({
    rules: rulesOf([`\\b${BANNED_WORD}\\b`]),
    files: ["p.md"],
    readText: readerFor({ "p.md": `${BANNED_WORD.toUpperCase()} it works\n` }),
  });
  assert.equal(result.newMatches, 1);
});

test("a prose-only fragment applies to prose and not to source", () => {
  const rules = rulesOf([], ["\\bwidget\\b"]);
  const prose = scan({ rules, files: ["p.md"], readText: readerFor({ "p.md": "a widget\n" }) });
  assert.equal(prose.newMatches, 1);
  const source = scan({ rules, files: ["p.ts"], readText: readerFor({ "p.ts": "a widget\n" }) });
  assert.equal(source.newMatches, 0);
  assert.equal(exitCodeFor(source), 0);
});

test("a source file with an empty pattern is skipped, not matched on every line", () => {
  // An empty extended regex matches every line, so an empty pattern is never
  // a no-op to hand to a matcher. This is the fault that made every source
  // file fail when the word list moved out into a rules file.
  const result = scan({
    rules: rulesOf([], ["\\bwidget\\b"]),
    files: ["a.ts", "b.ts"],
    readText: readerFor({ "a.ts": "one\ntwo\n", "b.ts": "three\n" }),
  });
  assert.deepEqual(result.matchLines, []);
  assert.equal(result.matchedFiles, 0);
  assert.equal(result.scannedFiles, 2);
});

test("a typographic prose-only rule stops at a fence and a word ban carries through it", () => {
  const text = ["```", `total: a - b and ${BANNED_WORD}`, "```", "prose a - b", ""].join("\n");
  const result = scan({
    rules: rulesOf([`\\b${BANNED_WORD}\\b`], ["[[:alpha:]] - [[:alpha:]]"]),
    files: ["doc.md"],
    readText: readerFor({ "doc.md": text }),
  });
  assert.deepEqual(result.matchLines, [
    `doc.md:2:total: a - b and ${BANNED_WORD}`,
    "doc.md:4:prose a - b",
  ]);
});

test("with every fragment prose-only, nothing at all fires inside a fence", () => {
  const text = ["```", "total: a - b", "```", ""].join("\n");
  const result = scan({
    rules: rulesOf([], ["[[:alpha:]] - [[:alpha:]]"]),
    files: ["doc.md"],
    readText: readerFor({ "doc.md": text }),
  });
  assert.deepEqual(result.matchLines, []);
  assert.equal(exitCodeFor(result), 0);
});

test("the fence rule does not apply to a source file", () => {
  const text = ["// ```", "const widget = 1;", "// ```", ""].join("\n");
  const result = scan({
    rules: rulesOf(["\\bwidget\\b"]),
    files: ["p.ts"],
    readText: readerFor({ "p.ts": text }),
  });
  assert.equal(result.newMatches, 1);
});

test("a NUL byte does not hide the line it sits on", () => {
  const result = scan({
    rules: rulesOf([`\\b${BANNED_WORD}\\b`]),
    files: ["doc.md"],
    readText: readerFor({ "doc.md": `a \u0000 byte, then ${BANNED_WORD} after it\n` }),
  });
  assert.equal(result.newMatches, 1);
  assert.deepEqual(result.matchLines, [`doc.md:1:a  byte, then ${BANNED_WORD} after it`]);
});

test("a file that cannot be read stops the run instead of counting as clean", () => {
  assert.throws(
    () =>
      scan({
        rules: rulesOf(["\\bwidget\\b"]),
        files: ["absent.md"],
        readText: readerFor({}),
      }),
    (err: unknown) => {
      assert.ok(err instanceof ProseScanError);
      assert.match(err.message, /error reading 'absent.md'/);
      return true;
    },
  );
});

test("occurrences of one text in one file are counted, not merged", () => {
  const result = scan({
    rules: rulesOf(["\\bwidget\\b"]),
    files: ["p.md"],
    readText: readerFor({ "p.md": "a widget\na widget\n   a widget   \n" }),
  });
  assert.equal(result.totalMatches, 3);
  assert.deepEqual(result.counts, new Map([[baselineKey("p.md", "a widget"), 3]]));
});

test("a baseline forgives up to the recorded count and no further", () => {
  const baseline = new Map([[baselineKey("p.md", "a widget"), 3]]);
  const three = scan({
    rules: rulesOf(["\\bwidget\\b"]),
    files: ["p.md"],
    readText: readerFor({ "p.md": "a widget\na widget\na widget\n" }),
    baseline,
  });
  assert.equal(three.forgivenMatches, 3);
  assert.equal(three.newMatches, 0);
  assert.equal(exitCodeFor(three), 0);

  const four = scan({
    rules: rulesOf(["\\bwidget\\b"]),
    files: ["p.md"],
    readText: readerFor({ "p.md": "a widget\na widget\na widget\na widget\n" }),
    baseline,
  });
  assert.equal(four.forgivenMatches, 3);
  assert.equal(four.newMatches, 1);
  assert.deepEqual(four.matchLines, ["p.md:4:a widget"]);
  assert.equal(exitCodeFor(four), 1);
});

test("the same text in a different file is a different key and is not forgiven", () => {
  const result = scan({
    rules: rulesOf(["\\bwidget\\b"]),
    files: ["other.md"],
    readText: readerFor({ "other.md": "a widget\n" }),
    baseline: new Map([[baselineKey("p.md", "a widget"), 1]]),
  });
  assert.equal(result.newMatches, 1);
  assert.equal(exitCodeFor(result), 1);
});

test("recordOnly counts every match, reports none, and never fails", () => {
  const result = scan({
    rules: rulesOf(["\\bwidget\\b"]),
    files: ["p.md"],
    readText: readerFor({ "p.md": "a widget\na widget\n" }),
    recordOnly: true,
  });
  assert.equal(result.totalMatches, 2);
  assert.deepEqual(result.matchLines, []);
  assert.equal(result.hadMatch, false);
  assert.equal(exitCodeFor(result), 0);
});

test("a rule fragment that cannot be translated stops the scan", () => {
  assert.throws(
    () =>
      scan({
        rules: rulesOf(["[[:xdigit:]]"]),
        files: ["p.md"],
        readText: readerFor({ "p.md": "abc\n" }),
      }),
    PatternError,
  );
});

// --- the report ---------------------------------------------------------------

test("the report says what was scanned, and with a baseline what it forgave", () => {
  const result = scan({
    rules: rulesOf(["\\bwidget\\b"]),
    files: ["p.md"],
    readText: readerFor({ "p.md": "a widget\nanother widget\n" }),
    baseline: new Map([[baselineKey("p.md", "a widget"), 1], [baselineKey("p.md", "gone"), 4]]),
  });
  assert.deepEqual(formatReport(result), ["scan-prose: scanned 1 file(s), 1 contained matches"]);
  assert.deepEqual(
    formatReport(result, { path: "base.txt", counts: new Map([[baselineKey("p.md", "gone"), 4]]) }),
    [
      "scan-prose: scanned 1 file(s), 1 contained matches",
      "scan-prose: baseline base.txt: 2 found, 1 forgiven, 1 new",
      "scan-prose: 1 baseline entries not seen this run (fixed; safe to delete from base.txt)",
    ],
  );
});

test("a clean scan is exit 0 and a match is exit 1", () => {
  const clean = scan({
    rules: rulesOf(["\\bwidget\\b"]),
    files: ["p.md"],
    readText: readerFor({ "p.md": "nothing here\n" }),
  });
  assert.equal(exitCodeFor(clean), 0);
  assert.deepEqual(formatReport(clean), ["scan-prose: scanned 1 file(s), 0 contained matches"]);
});
