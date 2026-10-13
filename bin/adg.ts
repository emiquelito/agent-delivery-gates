#!/usr/bin/env node
// The one binary this package installs, under two names:
// `agent-delivery-gates` and the short alias `adg`. It is a thin
// dispatcher: everything below `init` runs a real tool that already
// lives in this package (a hook, a script) and hands its exit code back
// unchanged. A wrapper that flattened exit codes would turn a blocking
// gate into a silent pass, so every branch below either exits with the
// wrapped tool's own code or, for an argument error only this dispatcher
// can detect, exits 2 itself.
//
// The package root is found from this file's own location, never from
// process.cwd(): once installed, this file runs from inside
// node_modules, nowhere near whatever directory invoked it.
//
// Node cannot load a .ts file that sits under a node_modules directory:
// its built-in type stripping refuses to run there, by path, regardless
// of any flag. So this file's installed form is a plain-JavaScript build
// of this source, published as dist/bin/adg.js, and every other .ts tool
// this dispatcher reaches (a hook, scripts/tally-report.ts) has a
// dist/ twin for the same reason. This source file stays at bin/adg.ts:
// it is what "npm run build" compiles from, and what a test spawns
// directly when working from a checkout instead of an install, where
// nothing sits under node_modules and the plain .ts runs on its own.
// The one bash script left (scripts/pre-publication-check.sh) carries no
// such restriction and is run from its one real location either way.

import process from "node:process";
import { findPackageRoot } from "../src/package-root.ts";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInit, combineInitExitCode } from "../src/init.ts";
import { createInterface } from "node:readline/promises";
import { findLanguage, fetchGrammar } from "../src/tree-sitter-grammar-store.ts";
import { planSetup, applySetup, type SetupStep } from "../src/init-setup.ts";
import { findMissingGrammars } from "../src/init.ts";

/** Walks upward from `startDir` to find the directory holding this
 * package's own package.json. Used instead of a fixed number of
 * `dirname` calls because this same source runs from two different
 * depths: bin/adg.ts directly from a checkout, and dist/bin/adg.js one
 * level deeper once built. */

const PACKAGE_ROOT = findPackageRoot(import.meta.url);

const USAGE = `Usage: agent-delivery-gates <command> [options]
       adg <command> [options]

Commands:
  init [options]           write starter files into a project
  lang list                list the tree-sitter grammars adg can install
  lang add <language>...   fetch one or more grammars into .adg/grammars/
  validate-report [...]    check a delivery report's claims
  test-diff [...]          separate a diff's source half from its test half
  mutate [...]             break the code in known ways and report what
                           the test suite failed to notice
  census [...]             run the suite at a base commit and at HEAD, and
                           report a test that stopped running or a new test
                           that passes without the change
  induce [...]             run a declared failure injection with the
                           handling in place and again with it taken away,
                           and report a check that passes either way
  tally [...]              read or check the gate tally log
  scan-prose [...]         scan text against configured prose rules
  check                    run the pre-publication checks
  mcp                      start the MCP server on stdio; advisory, an
                           agent calls its tools when it chooses to

Hook entry points, for a settings file or another agent's hook config:
  hook-clean-tree          block an edit while the tree is dirty
  hook-path-confinement    block a path outside the allowed roots
  hook-test-diff           report test changes apart from source changes
  hook-report              check a delivery report when a session stops
  cursor-hook <gate>       the same gates, in Cursor's hook contract; gate
                           is one of clean-tree, path-confinement,
                           test-diff, report
  copilot-hook <gate>      the same gates, in GitHub Copilot's hook
                           contract; gate is one of clean-tree,
                           path-confinement, test-diff, report

  --help, -h               print this message and exit 0
  --version, -v            print the installed version and exit 0

Each command passes its own arguments straight through to the tool it
wraps and exits with that tool's own exit code. Run any command with
--help for its own usage.
`;

const INIT_USAGE = `Usage: agent-delivery-gates init [--dry-run] [--force] [--prose-preset NAME] [--baseline] [--dir PATH] [--yes] [--no-setup] [--install-grammars | --no-install-grammars]

Writes starter files into a project: a git pre-commit hook, AGENTS.md,
and an empty gate tally log. It only ever creates a file that does not
exist yet.

Then it prints a setup plan for the steps that change something you may
already own, and applies it only with your say-so: install this package as a
dev dependency, write scripts.test when the repository plainly has tests and
no test script, fetch tree-sitter grammars, ignore a node_modules this run
created, set core.hooksPath, and stage what was created. A value that is
already set is never replaced; the plan lists it as skipped, with the reason.

  --dry-run             print what would happen, change nothing
  --yes, -y             apply the setup plan without asking. Without it, a
                         real terminal is asked once; with no terminal (an
                         agent session, CI) the plan is printed and NOT
                         applied
  --no-setup            write the starter files only; skip the setup plan
  --force               overwrite a file that already exists
  --prose-preset NAME   write .adg/prose-rules.txt including this preset
                         (from this package's presets/ directory); without
                         this flag, no prose rules file is written and the
                         prose gate stays off
  --baseline            also record every prose match the project already
                         has, to .adg/prose-baseline.txt, so turning the
                         gate on does not fail on everything it already
                         had; only does anything alongside --prose-preset
  --dir PATH            target this directory instead of the current one
  --install-grammars    install a missing tree-sitter grammar for a
                         language init found in this repository, without
                         asking; --no-install-grammars declines without
                         asking. With neither given, init asks on a real
                         terminal and otherwise only prints the commands
  --help                print this message and exit 0

Exit codes:
  0  every file was created, or already existed and was reported as such,
     and every grammar install actually attempted (if any) succeeded
  1  the files above were handled fine, but at least one grammar install
     was attempted and failed -- see the FAILED lines above
  2  the run could not proceed: an unreadable target, a missing template,
     or a bad argument
`;

function readVersion(): string {
  const pkgPath = join(PACKAGE_ROOT, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
  return pkg.version ?? "0.0.0";
}

/** Runs a wrapped tool as a real subprocess and returns with its own exit
 * code, never this dispatcher's. stdio is inherited so the wrapped tool's
 * own stdout/stderr/exit-code contract reaches the caller unchanged. */
function runWrapped(command: string, args: string[]): never {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) {
    process.stderr.write(`agent-delivery-gates: could not run '${command}' (${result.error.message})\n`);
    process.exit(2);
  }
  // A process killed by a signal has no exit code. Treat that as a
  // failure instead of silently exiting 0.
  process.exit(result.status ?? 1);
}

/** Runs a .ts tool that lives in this package. Prefers its compiled
 * dist/ twin when one has been built: that is the only form that can run
 * once this package sits under a node_modules directory. Falls back to
 * the .ts source directly, which is what makes this work from a plain
 * checkout with no build step, where nothing is under node_modules and
 * the restriction that twin exists for never applies. */
function nodeTool(relTsPath: string, args: string[]): never {
  const distPath = join(PACKAGE_ROOT, "dist", relTsPath.replace(/\.ts$/, ".js"));
  const target = existsSync(distPath) ? distPath : join(PACKAGE_ROOT, relTsPath);
  runWrapped(process.execPath, [target, ...args]);
}

function shellTool(relPath: string, args: string[]): never {
  runWrapped("bash", [join(PACKAGE_ROOT, relPath), ...args]);
}

interface ParsedInitArgs {
  dryRun: boolean;
  force: boolean;
  prosePreset?: string;
  baseline: boolean;
  dir?: string;
  help: boolean;
  /** undefined means "not decided on the command line": the grammar step is
   * part of the setup plan and follows --yes or the prompt. */
  installGrammars?: boolean;
  yes: boolean;
  noSetup: boolean;
}

function parseInitArgs(argv: string[]): ParsedInitArgs {
  const result: ParsedInitArgs = { dryRun: false, force: false, baseline: false, help: false, yes: false, noSetup: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        result.help = true;
        break;
      case "--dry-run":
        result.dryRun = true;
        break;
      case "--force":
        result.force = true;
        break;
      case "--baseline":
        result.baseline = true;
        break;
      case "--yes":
      case "-y":
        result.yes = true;
        break;
      case "--no-setup":
        result.noSetup = true;
        break;
      case "--install-grammars":
        result.installGrammars = true;
        break;
      case "--no-install-grammars":
        result.installGrammars = false;
        break;
      case "--prose-preset":
        result.prosePreset = argv[++i];
        if (result.prosePreset === undefined) {
          process.stderr.write("agent-delivery-gates init: --prose-preset needs a name\n");
          process.exit(2);
        }
        break;
      case "--dir":
        result.dir = argv[++i];
        if (result.dir === undefined) {
          process.stderr.write("agent-delivery-gates init: --dir needs a path\n");
          process.exit(2);
        }
        break;
      default:
        process.stderr.write(`agent-delivery-gates init: unknown argument '${arg}'\n`);
        process.exit(2);
    }
  }
  return result;
}

async function fetchGrammars(languageNames: readonly string[], targetDir: string): Promise<boolean> {
  let allOk = true;
  for (const name of languageNames) {
    const entry = findLanguage(name);
    if (entry === undefined) continue; // names came from the same table findLanguage reads
    const result = await fetchGrammar(entry, targetDir);
    process.stdout.write(`${result.ok ? "" : "FAILED: "}${result.message}\n`);
    if (!result.ok) allOk = false;
  }
  return allOk;
}

function printPlan(steps: SetupStep[], heading: string): void {
  process.stdout.write(`\n${heading}\n`);
  for (const step of steps) {
    if (step.action === "do") {
      process.stdout.write(`  will:    ${step.summary}\n`);
    } else {
      process.stdout.write(`  skipped: ${step.summary}: ${step.reason}\n`);
      if (step.manual !== undefined) process.stdout.write(`           yours to do: ${step.manual}\n`);
    }
  }
}

async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

async function runInitCommand(argv: string[]): Promise<never> {
  const args = parseInitArgs(argv);
  if (args.help) {
    process.stdout.write(INIT_USAGE);
    process.exit(0);
  }

  const targetDir = args.dir !== undefined ? resolve(process.cwd(), args.dir) : process.cwd();

  const outcome = runInit({
    targetDir,
    packageRoot: PACKAGE_ROOT,
    dryRun: args.dryRun,
    force: args.force,
    prosePreset: args.prosePreset,
    baseline: args.baseline,
    omitManualSetupHints: !args.noSetup,
  });

  for (const line of outcome.lines) {
    process.stdout.write(`${line}\n`);
  }
  if (outcome.exitCode !== 0 || args.noSetup) {
    process.exit(outcome.exitCode);
  }

  // The setup plan. Everything above only created files that did not exist;
  // everything below can change a file, a config value or the network, so it
  // is printed in full first and applied only when the person agreed.
  const steps = planSetup({
    targetDir,
    packageRoot: PACKAGE_ROOT,
    packageVersion: readVersion(),
    createdPaths: outcome.createdPaths,
    missingGrammars: findMissingGrammars(targetDir),
    grammarsAllowed: args.installGrammars !== false,
    installSpec: process.env.ADG_INIT_INSTALL_SPEC,
  });
  const doSteps = steps.filter((s) => s.action === "do");

  if (args.dryRun) {
    printPlan(steps, "Setup plan (dry run: nothing below was done):");
    process.exit(outcome.exitCode);
  }

  printPlan(steps, "Setup plan:");
  if (doSteps.length === 0) process.exit(outcome.exitCode);

  // --install-grammars alone keeps its older meaning: consent to the
  // grammar step and nothing else.
  const grammarsOnly = args.installGrammars === true && !args.yes;
  let approved = args.yes;
  if (!approved && !grammarsOnly) {
    if (process.stdin.isTTY === true && process.stdout.isTTY === true) {
      approved = await askYesNo("\nApply the steps marked 'will'? [y/N] ");
    }
  }
  let toRun = steps;
  if (!approved) {
    toRun = grammarsOnly ? steps.filter((s) => s.id === "grammars") : [];
    if (toRun.length === 0) {
      process.stdout.write(
        "\nNOT APPLIED: nothing in the setup plan was done. Re-run with --yes to apply it, or do the steps yourself.\n" +
          "The starter files and the hook file exist, but no gate is active until the plan is applied.\n",
      );
      process.exit(outcome.exitCode);
    }
  }

  process.stdout.write("\nApplying:\n");
  let allOk = true;
  const nonGrammar = toRun.filter((s) => s.id !== "grammars");
  // Install and the other non-grammar steps first: an install can bring
  // grammars with it, so which grammars are still missing is asked after.
  const results = applySetup(nonGrammar, targetDir, (r) => {
    process.stdout.write(`  ${r.ok ? "done" : "FAILED"}: ${r.message}\n`);
  });
  if (results.some((r) => !r.ok)) allOk = false;
  if (toRun.some((s) => s.id === "grammars" && s.action === "do")) {
    const still = findMissingGrammars(targetDir);
    if (still.length > 0) {
      const ok = await fetchGrammars(still, targetDir);
      if (!ok) allOk = false;
    }
    // The fetch cache carries its own .gitignore, which ignores everything
    // else in it, so staging that one file is what keeps the wasm out of a
    // later `git add -A`.
    const cacheIgnore = join(".adg", "grammars", ".gitignore");
    if (toRun.some((s) => s.id === "stage" && s.action === "do") && existsSync(join(targetDir, cacheIgnore))) {
      const r = spawnSync("git", ["add", "--", cacheIgnore], { cwd: targetDir, encoding: "utf8" });
      process.stdout.write(r.status === 0 ? `  done: staged: ${cacheIgnore}\n` : `  FAILED: could not stage ${cacheIgnore}\n`);
    }
  }
  process.exit(combineInitExitCode(outcome.exitCode, allOk));
}

function main(): void {
  const argv = process.argv.slice(2);
  const first = argv[0];

  if (first === undefined || first === "--help" || first === "-h") {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  if (first === "--version" || first === "-v") {
    process.stdout.write(`${readVersion()}\n`);
    process.exit(0);
  }

  const rest = argv.slice(1);

  switch (first) {
    case "init":
      void runInitCommand(rest);
      break;
    case "lang":
      nodeTool("hooks/lang.ts", rest);
      break;
    case "validate-report":
      nodeTool("hooks/delivery-report-validator.ts", rest);
      break;
    case "test-diff":
      nodeTool("hooks/test-diff-separator.ts", rest);
      break;
    case "mutate":
      nodeTool("hooks/mutate.ts", rest);
      break;
    case "census":
      nodeTool("hooks/census.ts", rest);
      break;
    case "induce":
      nodeTool("hooks/induce.ts", rest);
      break;
    case "tally":
      nodeTool("scripts/tally-report.ts", rest);
      break;
    case "scan-prose":
      nodeTool("hooks/scan-prose.ts", rest);
      break;
    case "check":
      shellTool("scripts/pre-publication-check.sh", rest);
      break;
    case "mcp":
      nodeTool("hooks/mcp-server.ts", rest);
      break;
    // The hook entry points, so a settings file can name a subcommand instead
    // of a path computed into node_modules. That path breaks under
    // workspaces, pnpm, and a global install.
    case "hook-clean-tree":
      nodeTool("hooks/pre-mutation-clean-tree.ts", rest);
      break;
    case "hook-path-confinement":
      nodeTool("hooks/path-confinement.ts", rest);
      break;
    case "hook-test-diff":
      nodeTool("hooks/test-diff-post-tool-hook.ts", rest);
      break;
    case "hook-report":
      nodeTool("hooks/delivery-report-stop-hook.ts", rest);
      break;
    case "cursor-hook":
      nodeTool("hooks/cursor-hook.ts", rest);
      break;
    case "copilot-hook":
      nodeTool("hooks/copilot-hook.ts", rest);
      break;
    default:
      process.stderr.write(`agent-delivery-gates: unknown command '${first}'\n\n`);
      process.stderr.write(USAGE);
      process.exit(2);
  }
}

main();
