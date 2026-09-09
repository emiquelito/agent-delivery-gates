#!/usr/bin/env node
// CLI entry point for the prose scan. Checks tracked text against a
// configurable set of prose rules: banned words, banned patterns, and (when
// the rules say so) a spaced hyphen standing in for an em dash. The rules
// are not built in here; the pure core in ../src/prose-scan.ts holds the
// matching decisions and this file holds only argument parsing, file
// reading, git, printing, and the exit code.
//
// This is the TypeScript port of scripts/scan-prose.sh, which needs bash 4
// and so refuses to run under the bash 3.2 macOS ships. Node is already a
// hard requirement of this package, so the port removes the second one, and
// with it the BSD-versus-GNU differences the bash had to work around.
//
// Usage:
//   scan-prose.ts                    scan every tracked text file, minus
//                                     whatever the rules exclude
//   scan-prose.ts FILE...            scan exactly these files
//   scan-prose.ts --rules PATH ...   use this rules file instead of the
//                                     usual lookup
//   scan-prose.ts --require-rules    treat "no rules configured" as exit 2
//                                     instead of exit 0
//   scan-prose.ts --write-baseline PATH ...
//                                     run the scan, record every current
//                                     match at PATH, print the count, and
//                                     exit 0 regardless of what was found
//   scan-prose.ts --baseline PATH ... run the scan, forgive a match already
//                                     recorded at PATH, and fail only on a
//                                     match the baseline does not hold
//
// Which rules file is used, first match wins:
//   1. --rules PATH
//   2. ADG_PROSE_RULES in the environment
//   3. .adg/prose-rules.txt in the repository root, if it exists
//   4. nothing: no rules are configured
//
// Exit codes:
//   0  scanned cleanly, nothing matched (or no rules were configured and
//      --require-rules was not given)
//   1  banned prose found
//   2  the scan could not run as asked: bad path, git unavailable, a rules
//      file that does not exist, an include cycle, a rule fragment that
//      cannot be translated, or (with --require-rules) no rules configured
//
// Exit 2 matters: a checker that cannot read its input must never look the
// same as a checker that read the input and found it clean.

import process from "node:process";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import {
  formatBaseline,
  formatReport,
  loadRules,
  parseBaseline,
  ProseScanError,
  rulesAreEmpty,
  scan,
  type Rules,
  type RulesFileSystem,
  type ScanResult,
} from "../src/prose-scan.ts";

function die(message: string): never {
  process.stderr.write(`scan-prose: ${message}\n`);
  process.exit(2);
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

// --- argument parsing --------------------------------------------------------

interface Options {
  rulesPathArg: string;
  requireRules: boolean;
  writeBaselinePath: string;
  baselinePathArg: string;
  files: string[];
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    rulesPathArg: "",
    requireRules: false,
    writeBaselinePath: "",
    baselinePathArg: "",
    files: [],
  };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === "--rules") {
      if (i + 1 >= argv.length) die("--rules requires a path argument");
      options.rulesPathArg = argv[i + 1]!;
      i += 2;
    } else if (arg.startsWith("--rules=")) {
      options.rulesPathArg = arg.slice("--rules=".length);
      i += 1;
    } else if (arg === "--require-rules") {
      options.requireRules = true;
      i += 1;
    } else if (arg === "--write-baseline") {
      if (i + 1 >= argv.length) die("--write-baseline requires a path argument");
      options.writeBaselinePath = argv[i + 1]!;
      i += 2;
    } else if (arg.startsWith("--write-baseline=")) {
      options.writeBaselinePath = arg.slice("--write-baseline=".length);
      i += 1;
    } else if (arg === "--baseline") {
      if (i + 1 >= argv.length) die("--baseline requires a path argument");
      options.baselinePathArg = argv[i + 1]!;
      i += 2;
    } else if (arg.startsWith("--baseline=")) {
      options.baselinePathArg = arg.slice("--baseline=".length);
      i += 1;
    } else if (arg === "--") {
      options.files.push(...argv.slice(i + 1));
      break;
    } else {
      options.files.push(arg);
      i += 1;
    }
  }
  return options;
}

// --- small filesystem questions, each answered the way `test` answers them ----

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function isReadable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

// --- git ----------------------------------------------------------------------

interface GitRun {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function git(args: readonly string[], cwd?: string): GitRun {
  const run = spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.error !== undefined) {
    return { ok: false, stdout: "", stderr: run.error.message };
  }
  return { ok: run.status === 0, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

/** What `$(cat file)` in the bash did to git's error text: drop trailing newlines. */
function withoutTrailingNewlines(s: string): string {
  return s.replace(/\n+$/, "");
}

// --- baseline files -----------------------------------------------------------

function writeBaselineFile(path: string, result: ScanResult): void {
  const text = formatBaseline(result.counts);
  const temp = `${path}.adg-tmp-${process.pid}`;
  try {
    writeFileSync(temp, text);
  } catch {
    try {
      unlinkSync(temp);
    } catch {
      // Nothing to clean up; the write is the thing that failed.
    }
    die(`could not write baseline to '${path}'`);
  }
  try {
    renameSync(temp, path);
  } catch {
    try {
      unlinkSync(temp);
    } catch {
      // Same: the rename is the failure being reported.
    }
    die(`could not write baseline to '${path}'`);
  }
}

// --- rules --------------------------------------------------------------------

const RULES_FS: RulesFileSystem = {
  isFile: isRegularFile,
  realPath: realpathSync,
  dirName: dirname,
  isAbsolute,
  join: (dir, rel) => `${dir}/${rel}`,
  readText: (path) => readFileSync(path, "utf8"),
};

function main(): void {
  const options = parseArgs(process.argv.slice(2));

  if (options.writeBaselinePath !== "" && options.baselinePathArg !== "") {
    die("--write-baseline and --baseline cannot be used together");
  }

  let baseline: Map<string, number> | undefined;
  if (options.baselinePathArg !== "") {
    const path = options.baselinePathArg;
    if (!isRegularFile(path)) die(`baseline file '${path}' does not exist`);
    if (!isReadable(path)) die(`baseline file '${path}' is not readable`);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      die(`baseline file '${path}' is not readable`);
    }
    try {
      baseline = parseBaseline(text, path);
    } catch (err) {
      die(err instanceof ProseScanError ? err.message : String(err));
    }
  }

  // In default (no-argument) mode the file list itself comes from git, so a
  // missing repository is a hard error. Establishing it first keeps a git
  // failure from being quietly swallowed into "no rules configured".
  let root = "";
  const defaultMode = options.files.length === 0;
  if (defaultMode) {
    const top = git(["rev-parse", "--show-toplevel"]);
    if (!top.ok) {
      die(`not a git repository. git said: ${withoutTrailingNewlines(top.stderr)}`);
    }
    root = top.stdout.replace(/\n+$/, "");
  } else {
    const top = git(["rev-parse", "--show-toplevel"]);
    root = top.ok ? top.stdout.replace(/\n+$/, "") : "";
  }

  // Which rules file to use, first match wins. An explicitly named source
  // (--rules or ADG_PROSE_RULES) that does not exist is an error: the caller
  // asked for a specific file. The repository default turning up nothing is
  // not an error; it just means no rules are configured.
  let rulesPath = "";
  let rulesExplicit = false;
  const envRules = process.env.ADG_PROSE_RULES ?? "";
  if (options.rulesPathArg !== "") {
    rulesPath = options.rulesPathArg;
    rulesExplicit = true;
  } else if (envRules !== "") {
    rulesPath = envRules;
    rulesExplicit = true;
  } else if (root !== "") {
    const candidate = `${root}/.adg/prose-rules.txt`;
    if (isRegularFile(candidate)) rulesPath = candidate;
  }

  let rules: Rules = { fragments: [], proseOnly: [], excludes: [] };
  if (rulesPath !== "") {
    if (rulesExplicit && !isRegularFile(rulesPath)) {
      die(`rules file '${rulesPath}' does not exist`);
    }
    try {
      rules = loadRules(rulesPath, RULES_FS);
    } catch (err) {
      die(err instanceof ProseScanError ? err.message : String(err));
    }
  }

  if (rulesAreEmpty(rules)) {
    if (options.requireRules) die("no prose rules are configured; nothing was checked");
    if (options.writeBaselinePath !== "") {
      writeBaselineFile(options.writeBaselinePath, {
        matchLines: [],
        scannedFiles: 0,
        matchedFiles: 0,
        totalMatches: 0,
        forgivenMatches: 0,
        newMatches: 0,
        hadMatch: false,
        counts: new Map(),
      });
      out(`scan-prose: wrote 0 match(es) to ${options.writeBaselinePath}`);
      process.exit(0);
    }
    out("scan-prose: no prose rules are configured; nothing was checked");
    process.exit(0);
  }

  // --- file selection ---------------------------------------------------------

  let files: string[] = [];
  if (!defaultMode) {
    // Explicit arguments: every one must resolve to a readable regular file.
    // A typo or a renamed file is an error, never a silent pass.
    for (const arg of options.files) {
      if (isDirectory(arg)) die(`'${arg}' is a directory, expected a file`);
      else if (isSymlink(arg) && !exists(arg)) die(`'${arg}' is a symlink whose target does not exist`);
      else if (!exists(arg)) die(`'${arg}' does not exist`);
      else if (!isRegularFile(arg)) die(`'${arg}' is not a regular file`);
      else if (!isReadable(arg)) die(`'${arg}' is not readable`);
      files.push(arg);
    }
  } else {
    // No arguments: the list comes from git, null delimited so a path holding
    // a non-ASCII character survives (core.quotepath would otherwise hand back
    // a name that cannot be opened). --others --exclude-standard adds files
    // that are not tracked yet and not ignored, because a new file is exactly
    // when checking it still helps.
    const excludePathspecs = rules.excludes.map((glob) => `:(exclude)${glob}`);
    const listed = git(
      [
        "-C",
        root,
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        "*.md",
        "*.json",
        "*.ts",
        "*.sh",
        ".gitignore",
        ".gitattributes",
        "NOTICE",
        ...excludePathspecs,
      ],
    );
    if (!listed.ok) {
      die(`git ls-files failed. git said: ${withoutTrailingNewlines(listed.stderr)}`);
    }
    files = listed.stdout
      .split("\u0000")
      .filter((rel) => rel.length > 0)
      .map((rel) => `${root}/${rel}`);
    if (files.length === 0) {
      out("scan-prose: nothing tracked to scan");
      process.exit(0);
    }
  }

  // --- the scan ---------------------------------------------------------------

  let result: ScanResult;
  try {
    result = scan({
      rules,
      files,
      readText: (path) => readFileSync(path, "utf8"),
      baseline,
      recordOnly: options.writeBaselinePath !== "",
    });
  } catch (err) {
    die(err instanceof ProseScanError ? err.message : String(err));
  }

  if (options.writeBaselinePath !== "") {
    writeBaselineFile(options.writeBaselinePath, result);
    out(`scan-prose: wrote ${result.totalMatches} match(es) to ${options.writeBaselinePath}`);
    process.exit(0);
  }

  for (const line of result.matchLines) out(line);
  const report = formatReport(
    result,
    baseline === undefined ? undefined : { path: options.baselinePathArg, counts: baseline },
  );
  for (const line of report) out(line);

  process.exit(result.hadMatch ? 1 : 0);
}

main();
