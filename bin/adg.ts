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
// The bash scripts (scripts/scan-prose.sh, scripts/pre-publication-check.sh)
// carry no such restriction and are run from their one real location
// either way.

import process from "node:process";
import { findPackageRoot } from "../src/package-root.ts";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInit } from "../src/init.ts";

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
  validate-report [...]    check a delivery report's claims
  test-diff [...]          separate a diff's source half from its test half
  mutate [...]             break the code in known ways and report what
                           the test suite failed to notice
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

const INIT_USAGE = `Usage: agent-delivery-gates init [--dry-run] [--force] [--prose-preset NAME] [--baseline] [--dir PATH]

Writes starter files into a project: a git pre-commit hook, AGENTS.md,
and an empty gate tally log. It only ever creates a file that does not
exist yet.

  --dry-run             print what would happen, change nothing
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
  --help                print this message and exit 0

Exit codes:
  0  every file was created, or already existed and was reported as such
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
}

function parseInitArgs(argv: string[]): ParsedInitArgs {
  const result: ParsedInitArgs = { dryRun: false, force: false, baseline: false, help: false };
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

function runInitCommand(argv: string[]): never {
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
  });

  for (const line of outcome.lines) {
    process.stdout.write(`${line}\n`);
  }
  process.exit(outcome.exitCode);
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
      runInitCommand(rest);
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
    case "tally":
      nodeTool("scripts/tally-report.ts", rest);
      break;
    case "scan-prose":
      shellTool("scripts/scan-prose.sh", rest);
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
