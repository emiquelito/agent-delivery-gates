// Core logic for `agent-delivery-gates init`. Every path this needs comes
// in as an argument instead of being derived from the current working
// directory or from where this module happens to live on disk, so it can
// be driven the same way whether it is running from a checkout or from an
// installed package.
//
// The whole design is one rule: init only ever creates a file that does
// not already exist. Nothing here edits a file in place, and nothing here
// touches .claude/settings.json at all; the lines a person would add
// there are printed, never written.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveWithinRoot, realPath } from "./path-allowlist.ts";
import {
  LANGUAGES,
  localWasmPath,
  verifyLocalGrammarDigest,
  type LanguageEntry,
} from "./tree-sitter-grammar-store.ts";

export interface InitOptions {
  /** Directory init writes into. Must already be an absolute path. */
  targetDir: string;
  /** The installed package's own root. Must already be an absolute path. */
  packageRoot: string;
  dryRun: boolean;
  force: boolean;
  /** Name of a preset file under presets/, e.g. "house-style". Undefined
   * means no prose rules file is written at all, which is the default:
   * the prose gate stays off until a preset is named. */
  prosePreset?: string;
  /** Records the project's current prose matches to .adg/prose-baseline.txt
   * so an existing project can turn the prose gate on without failing on
   * everything it already has. Only does anything alongside prosePreset;
   * on its own it is an argument error. */
  baseline?: boolean;
}

export interface InitOutcome {
  exitCode: number;
  lines: string[];
  /** Names (from src/tree-sitter-grammar-store.ts's LANGUAGES) of every
   * language init found tracked files for in this repository, with no
   * grammar it can currently trust: neither node_modules nor this
   * project's own `.adg/grammars/` has anything for it (missing), or
   * `.adg/grammars/` has a file that fails digest verification (corrupt --
   * see grammarState's own doc comment for why that is folded in here
   * instead of dropped: the fix bin/adg.ts offers, a fresh verified
   * fetch, is the same for both). Empty on a dry run, since nothing
   * checked here writes anything either way. bin/adg.ts reads this to
   * decide whether to ask about installing them; runInit itself never
   * downloads anything; see fetchGrammar in src/tree-sitter-grammar-store.ts. */
  missingGrammarLanguages: string[];
}

interface TemplateAction {
  relPath: string;
  templateName: string;
  /** git ignores a hook that is not executable, and only hints about it. */
  executable?: boolean;
}

const TEMPLATE_ACTIONS: TemplateAction[] = [
  { relPath: join(".githooks", "pre-commit"), templateName: "pre-commit", executable: true },
  { relPath: "AGENTS.md", templateName: "AGENTS.md" },
  { relPath: join("docs", "gate-tally.md"), templateName: "gate-tally.md" },
  {
    relPath: join(".github", "workflows", "agent-delivery-gates.yml"),
    templateName: "github-workflow.yml",
  },
];

const PROSE_RULES_REL_PATH = join(".adg", "prose-rules.txt");
const PROSE_BASELINE_REL_PATH = join(".adg", "prose-baseline.txt");
const CURSOR_HOOKS_REL_PATH = join(".cursor", "hooks.json");
const CODEX_HOOKS_REL_PATH = join(".codex", "hooks.json");
const COPILOT_HOOKS_REL_PATH = join(".github", "hooks", "agent-delivery-gates.json");

// MCP client config files. Each one carries this server's standard stdio
// entry, either verbatim (templates/mcp.json, the "mcpServers" form most
// clients use) or in VS Code's own form (templates/vscode-mcp.json, whose
// top-level key is "servers" instead; confirmed against VS Code's own MCP
// documentation, not guessed). Codex's config is TOML in the user's home
// directory, not a file in this repository, so it gets no entry here: its
// equivalent is only printed, in runInit below.
const MCP_CLIENT_CONFIGS: Array<{ relPath: string; templateName: string }> = [
  { relPath: ".mcp.json", templateName: "mcp.json" },
  { relPath: join(".cursor", "mcp.json"), templateName: "mcp.json" },
  { relPath: join(".vscode", "mcp.json"), templateName: "vscode-mcp.json" },
  { relPath: join(".windsurf", "mcp.json"), templateName: "mcp.json" },
];

interface WriteCtx {
  dryRun: boolean;
  force: boolean;
  lines: string[];
}

/** Writes one file under targetDir, or, in dry-run mode, only reports what
 * it would have done. Never touches a file that already exists unless
 * force is set. */
function writeOrPlan(
  targetDir: string,
  relPath: string,
  getContent: () => string,
  ctx: WriteCtx,
  executable = false,
): void {
  // Every relPath passed in above is a fixed literal, never built from
  // user input, so this can only trip if that ever changes. Kept as a
  // real check and not only a comment: a target directory is exactly the
  // kind of thing this tool must never write outside of.
  //
  // Both sides are compared as real paths. init writes files that do not
  // exist yet, so the candidate is resolved as far as its nearest existing
  // ancestor and the remainder reattached; a target directory reached
  // through a symlink, which is every scratch directory under /tmp on
  // macOS, then still reads as containing its own files, while a parent
  // that links out of the target directory still reads as outside it.
  const found = resolveWithinRoot(targetDir, relPath, realPath, targetDir);
  if (!found.contained) {
    throw new Error(`refusing to write outside the target directory: '${found.realPath}'`);
  }
  const target = found.realPath;

  const exists = existsSync(target);
  if (exists && !ctx.force) {
    ctx.lines.push(`exists, skipped: ${relPath}`);
    return;
  }

  if (ctx.dryRun) {
    ctx.lines.push(`${exists ? "would overwrite" : "would create"}: ${relPath}`);
    return;
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, getContent());
  // git ignores a hook that is not executable, and says so only in a hint.
  // A gate that looks installed and does nothing is the worst outcome here.
  if (executable) chmodSync(target, 0o755);
  ctx.lines.push(`${exists ? "overwrote" : "created"}: ${relPath}`);
}

function fail(message: string): InitOutcome {
  return { exitCode: 2, lines: [`init: ${message}`], missingGrammarLanguages: [] };
}

/** Every tracked file's extension in `targetDir`, matched against
 * src/tree-sitter-grammar-store.ts's LANGUAGES table. Empty, quietly, when
 * `targetDir` is not a git repository at all (an empty scratch directory,
 * most commonly in this project's own tests) or `git` itself is not on
 * PATH: init already writes useful files with no repository behind it, and
 * a language detection step failing to find any languages is not a reason
 * to fail the whole command. */
function detectRepoLanguages(targetDir: string): LanguageEntry[] {
  let result;
  try {
    result = spawnSync("git", ["ls-files"], { cwd: targetDir, encoding: "utf8" });
  } catch {
    return [];
  }
  if (result.error || result.status !== 0) return [];
  const found = new Map<string, LanguageEntry>();
  for (const line of result.stdout.split("\n")) {
    if (line.trim() === "") continue;
    const lower = line.toLowerCase();
    const dot = lower.lastIndexOf(".");
    if (dot === -1) continue;
    const ext = lower.slice(dot);
    const entry = LANGUAGES.find((lang) => lang.ext === ext);
    if (entry !== undefined) found.set(entry.name, entry);
  }
  return [...found.values()];
}

/** Whether `entry`'s grammar is reachable for `targetDir`, and if not, why.
 *
 * "ok": this project's own local store already holds a wasm file that
 * verifies against its pinned digest, or the grammar package sits in
 * `targetDir`'s own node_modules (an adopter who `npm install`ed it
 * directly, or this repository's own checkout, trusted the same way
 * src/tree-sitter-language-service.ts's resolveWasmPath trusts it -- a
 * package manager's own install, not a file that could have been placed
 * there some other way). Not a guarantee the load will actually succeed --
 * that is resolveWasmPath's job, at the moment a file of that language is
 * actually scanned -- only that init has nothing useful left to offer for
 * this language.
 *
 * "corrupt": a file already sits at `.adg/grammars/<name>.wasm`, but it
 * fails verifyLocalGrammarDigest's check against the pinned sha256 for its
 * package and version. This is deliberately not folded into "missing"
 * silently, even though both end up asking for the same fix (`npx adg lang
 * add <name>`, which overwrites whatever is there with a freshly verified
 * download): a file that was never installed and a file that is sitting
 * there under a name that does not match its own contents are different
 * facts, worth telling a person apart, even when the remedy happens to be
 * identical. See verifyLocalGrammarDigest's own doc comment in
 * src/tree-sitter-grammar-store.ts for the full reasoning, including why
 * this is also not the same thing this project already calls "installed
 * and broken" (src/code-mask.ts's grammarGenuineFailures).
 *
 * "missing": neither the local store nor node_modules has anything for
 * this language at all.
 */
function grammarState(targetDir: string, entry: LanguageEntry): "ok" | "corrupt" | "missing" {
  const local = localWasmPath(targetDir, entry.wasmFileName);
  if (existsSync(local)) {
    try {
      verifyLocalGrammarDigest(entry.wasmFileName, local);
      return "ok";
    } catch {
      return "corrupt";
    }
  }
  return existsSync(join(targetDir, "node_modules", entry.packageName)) ? "ok" : "missing";
}

/** The four hook wiring lines for the standalone `.claude/settings.json`
 * route, one per hook, resolved relative to the target directory so they
 * work no matter where the package is actually installed.
 *
 * These point at the compiled dist/hooks/*.js twin when the installed
 * package carries one, and at the .ts source otherwise. Node refuses to
 * load a .ts file from inside a node_modules directory at all, by path,
 * so a hook wired up against a real install has to run the compiled
 * form; a checkout with no build step has no node_modules in the way and
 * runs the .ts source directly. */
/**
 * Hook commands for the standalone route. The npx form is first because it
 * resolves the package however it was installed, and a path computed into
 * node_modules breaks under workspaces, pnpm, and a global install. It costs
 * roughly a tenth of a second per call, so the direct path is offered too for
 * anyone who minds that on every edit.
 */
function standaloneSettingsLines(targetDir: string, packageRoot: string): string[] {
  const hooks: Array<[string, string]> = [
    ["PreToolUse (Edit|Write|MultiEdit|NotebookEdit)", "pre-mutation-clean-tree"],
    ["PreToolUse (Read|Write|Edit|MultiEdit|NotebookEdit)", "path-confinement"],
    ["PostToolUse (Bash)", "test-diff-post-tool-hook"],
    ["Stop", "delivery-report-stop-hook"],
  ];
  const subcommand: Record<string, string> = {
    "pre-mutation-clean-tree": "hook-clean-tree",
    "path-confinement": "hook-path-confinement",
    "test-diff-post-tool-hook": "hook-test-diff",
    "delivery-report-stop-hook": "hook-report",
  };
  const lines = hooks.map(
    ([event, name]) => `${event}: npx --no-install adg ${subcommand[name]} || exit 2`,
  );

  const distHooksDir = join(packageRoot, "dist", "hooks");
  const useDist = existsSync(distHooksDir);
  const hooksDir = relative(targetDir, useDist ? distHooksDir : join(packageRoot, "hooks"));
  const ext = useDist ? "js" : "ts";
  lines.push("");
  lines.push("Faster, but tied to how the package happens to be installed:");
  for (const [event, name] of hooks) {
    lines.push(`${event}: node "$CLAUDE_PROJECT_DIR/${hooksDir}/${name}.${ext}" || exit 2`);
  }
  return lines;
}

function suggestedNpmScripts(): string[] {
  return [
    `"gates:check": "agent-delivery-gates check"`,
    `"gates:scan-prose": "agent-delivery-gates scan-prose"`,
    `"gates:tally": "agent-delivery-gates tally --check"`,
  ];
}

export function runInit(options: InitOptions): InitOutcome {
  const { targetDir, packageRoot, dryRun, force, prosePreset, baseline } = options;

  if (baseline === true && prosePreset === undefined) {
    return fail("--baseline only makes sense together with --prose-preset; on its own there are no rules to baseline against");
  }

  let stat;
  try {
    stat = statSync(targetDir);
  } catch (err) {
    return fail(`cannot read target directory '${targetDir}' (${(err as Error).message})`);
  }
  if (!stat.isDirectory()) {
    return fail(`target '${targetDir}' is not a directory`);
  }

  // Every template is resolved and checked before anything is written.
  // A missing template means the run cannot proceed at all; failing here
  // keeps a bad install from producing a half-finished setup on disk.
  const resolvedActions: { relPath: string; templatePath: string; executable: boolean }[] = [];
  for (const action of TEMPLATE_ACTIONS) {
    const templatePath = join(packageRoot, "templates", action.templateName);
    if (!existsSync(templatePath)) {
      return fail(`template '${templatePath}' is missing from the installed package`);
    }
    resolvedActions.push({ relPath: action.relPath, templatePath, executable: action.executable === true });
  }

  let prosePresetPath: string | undefined;
  if (prosePreset !== undefined) {
    if (prosePreset.trim() === "") {
      return fail("--prose-preset needs a preset name");
    }
    prosePresetPath = join(packageRoot, "presets", `${prosePreset}.txt`);
    if (!existsSync(prosePresetPath)) {
      return fail(`unknown prose preset '${prosePreset}': no file at '${prosePresetPath}'`);
    }
  }

  const lines: string[] = [];
  const ctx: WriteCtx = { dryRun, force, lines };

  for (const action of resolvedActions) {
    writeOrPlan(
      targetDir,
      action.relPath,
      () => readFileSync(action.templatePath, "utf8"),
      ctx,
      action.executable,
    );
  }

  // .cursor/hooks.json is Cursor's own hook config, not this project's.
  // Unlike every file above, it is never silently skipped-and-reported the
  // same way: an existing one may already carry entries wiring up other
  // tools, and overwriting it would drop them with no way back. So this
  // never touches a file that is already there, --force included, and
  // instead prints the template's content for a person to merge by hand.
  const cursorHooksTemplatePath = join(packageRoot, "templates", "cursor-hooks.json");
  if (!existsSync(cursorHooksTemplatePath)) {
    return fail(`template '${cursorHooksTemplatePath}' is missing from the installed package`);
  }
  const cursorHooksContent = readFileSync(cursorHooksTemplatePath, "utf8");
  const cursorHooksTarget = resolve(targetDir, CURSOR_HOOKS_REL_PATH);
  if (existsSync(cursorHooksTarget)) {
    lines.push(`exists, not written: ${CURSOR_HOOKS_REL_PATH}`);
    lines.push("init does not edit an existing .cursor/hooks.json. Merge these entries into it yourself:");
    lines.push(cursorHooksContent.trimEnd());
  } else if (dryRun) {
    lines.push(`would create: ${CURSOR_HOOKS_REL_PATH}`);
  } else {
    mkdirSync(dirname(cursorHooksTarget), { recursive: true });
    writeFileSync(cursorHooksTarget, cursorHooksContent);
    lines.push(`created: ${CURSOR_HOOKS_REL_PATH}`);
  }

  // .codex/hooks.json gets the same treatment as .cursor/hooks.json above,
  // for the same reason: it is Codex's own hook config, an existing one may
  // already wire up other tools, and overwriting it would drop those with
  // no way back. Never touched once it exists, --force included; its
  // content is printed for a person to merge by hand instead.
  const codexHooksTemplatePath = join(packageRoot, "templates", "codex-hooks.json");
  if (!existsSync(codexHooksTemplatePath)) {
    return fail(`template '${codexHooksTemplatePath}' is missing from the installed package`);
  }
  const codexHooksContent = readFileSync(codexHooksTemplatePath, "utf8");
  const codexHooksTarget = resolve(targetDir, CODEX_HOOKS_REL_PATH);
  if (existsSync(codexHooksTarget)) {
    lines.push(`exists, not written: ${CODEX_HOOKS_REL_PATH}`);
    lines.push("init does not edit an existing .codex/hooks.json. Merge these entries into it yourself:");
    lines.push(codexHooksContent.trimEnd());
  } else if (dryRun) {
    lines.push(`would create: ${CODEX_HOOKS_REL_PATH}`);
  } else {
    mkdirSync(dirname(codexHooksTarget), { recursive: true });
    writeFileSync(codexHooksTarget, codexHooksContent);
    lines.push(`created: ${CODEX_HOOKS_REL_PATH}`);
  }

  // .github/hooks/agent-delivery-gates.json gets the same treatment as
  // .cursor/hooks.json and .codex/hooks.json above: it is Copilot's own
  // hook config, an existing one may already wire up other tools, and
  // overwriting it would drop those with no way back. Never touched once
  // it exists, --force included; its content is printed for a person to
  // merge by hand instead.
  const copilotHooksTemplatePath = join(packageRoot, "templates", "copilot-hooks.json");
  if (!existsSync(copilotHooksTemplatePath)) {
    return fail(`template '${copilotHooksTemplatePath}' is missing from the installed package`);
  }
  const copilotHooksContent = readFileSync(copilotHooksTemplatePath, "utf8");
  const copilotHooksTarget = resolve(targetDir, COPILOT_HOOKS_REL_PATH);
  if (existsSync(copilotHooksTarget)) {
    lines.push(`exists, not written: ${COPILOT_HOOKS_REL_PATH}`);
    lines.push("init does not edit an existing .github/hooks/agent-delivery-gates.json. Merge these entries into it yourself:");
    lines.push(copilotHooksContent.trimEnd());
  } else if (dryRun) {
    lines.push(`would create: ${COPILOT_HOOKS_REL_PATH}`);
  } else {
    mkdirSync(dirname(copilotHooksTarget), { recursive: true });
    writeFileSync(copilotHooksTarget, copilotHooksContent);
    lines.push(`created: ${COPILOT_HOOKS_REL_PATH}`);
  }

  // Each MCP client config gets the same treatment as the hook configs
  // above: an existing file may already wire up other servers, so it is
  // never touched, --force included, and the block is printed instead for
  // a person to merge by hand.
  for (const { relPath, templateName } of MCP_CLIENT_CONFIGS) {
    const templatePath = join(packageRoot, "templates", templateName);
    if (!existsSync(templatePath)) {
      return fail(`template '${templatePath}' is missing from the installed package`);
    }
    const content = readFileSync(templatePath, "utf8");
    const target = resolve(targetDir, relPath);
    if (existsSync(target)) {
      lines.push(`exists, not written: ${relPath}`);
      lines.push(`init does not edit an existing ${relPath}. Merge this block into it yourself:`);
      lines.push(content.trimEnd());
    } else if (dryRun) {
      lines.push(`would create: ${relPath}`);
    } else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
      lines.push(`created: ${relPath}`);
    }
  }

  // Codex keeps its MCP config in TOML, in the user's home directory, not
  // in this repository. There is nothing here for init to write, so the
  // equivalent is only printed, the same way the standalone
  // .claude/settings.json lines are printed further down.
  lines.push("");
  lines.push("Codex's MCP config is TOML in your home directory, not a file in this repo,");
  lines.push("so init writes nothing there. Add this to ~/.codex/config.toml yourself:");
  lines.push("  [mcp_servers.agent-delivery-gates]");
  lines.push('  command = "npx"');
  lines.push('  args = ["--no-install", "agent-delivery-gates", "mcp"]');

  let proseRulesCreatedThisRun = false;
  if (prosePresetPath !== undefined) {
    const rulesTarget = resolve(targetDir, PROSE_RULES_REL_PATH);
    const existedBefore = existsSync(rulesTarget);
    const content = `include: ${prosePresetPath}\n`;
    writeOrPlan(targetDir, PROSE_RULES_REL_PATH, () => content, ctx);
    // Only a fresh file is safe to roll back on failure below; an existing
    // file --force overwrote already held content that was not ours to
    // discard a second time.
    proseRulesCreatedThisRun = !dryRun && !existedBefore;
  }

  if (prosePresetPath !== undefined && baseline === true) {
    if (dryRun) {
      lines.push(`would create: ${PROSE_BASELINE_REL_PATH}`);
    } else {
      // The scan is a Node program. dist/ first, for the reason spelled out
      // in bin/adg.ts: once this package is installed it sits under
      // node_modules, where Node refuses to strip types from a .ts file, so
      // the built twin is the only form that runs. The .ts source is what a
      // plain checkout has, and nothing there is under node_modules.
      const builtScanner = join(packageRoot, "dist", "hooks", "scan-prose.js");
      const scanScript = existsSync(builtScanner)
        ? builtScanner
        : join(packageRoot, "hooks", "scan-prose.ts");
      const rulesTarget = resolve(targetDir, PROSE_RULES_REL_PATH);
      const baselineTarget = resolve(targetDir, PROSE_BASELINE_REL_PATH);
      const result = spawnSync(
        process.execPath,
        [scanScript, "--rules", rulesTarget, "--write-baseline", baselineTarget],
        { cwd: targetDir, encoding: "utf8" },
      );
      // --write-baseline never fails on what it finds; a non-zero exit here
      // means the scan itself could not run (e.g. not a git repository). A
      // rules file with no baseline behind it would fail every commit, so
      // roll back a rules file this run wrote before reporting the error.
      if (result.error || result.status !== 0) {
        if (proseRulesCreatedThisRun) {
          try {
            unlinkSync(rulesTarget);
          } catch {
            // best effort: the failure below is reported regardless
          }
        }
        const detail = result.error
          ? result.error.message
          : (result.stderr || result.stdout || "").trim() || `exit code ${result.status}`;
        return fail(`could not write the prose baseline (${detail})`);
      }
      const recorded = /wrote (\d+) match/.exec(result.stdout ?? "");
      const countNote = recorded ? ` (${recorded[1]} match(es) recorded)` : "";
      lines.push(`created: ${PROSE_BASELINE_REL_PATH}${countNote}`);
    }
  }

  // Language detection and reporting only, on a dry run too, so a dry run
  // still shows what init would tell a real run about. Nothing here
  // downloads anything: dryRun aside, that decision belongs to bin/adg.ts,
  // which asks before it acts (see maybeInstallGrammars there).
  const detectedLanguages = detectRepoLanguages(targetDir);
  const languageStates = detectedLanguages.map((entry) => ({ entry, state: grammarState(targetDir, entry) }));
  const corruptGrammarLanguages = languageStates.filter((s) => s.state === "corrupt").map((s) => s.entry);
  const absentGrammarLanguages = languageStates.filter((s) => s.state === "missing").map((s) => s.entry);
  // corrupt and absent both need the same fix (fetch a freshly verified
  // copy), so both feed the one install-command block below and the one
  // list bin/adg.ts's maybeInstallGrammars reads -- but corrupt gets its
  // own line above it, since "a file is there and it is wrong" is not the
  // same fact as "nothing is there yet", even though the remedy is
  // identical. See grammarState's own doc comment for why.
  const grammarsToInstall = [...corruptGrammarLanguages, ...absentGrammarLanguages];
  if (detectedLanguages.length > 0) {
    lines.push("");
    lines.push(`Languages found in this repository: ${detectedLanguages.map((entry) => entry.name).join(", ")}.`);
  }
  if (corruptGrammarLanguages.length > 0) {
    lines.push(
      `Local grammar file(s) failed digest verification: ${corruptGrammarLanguages.map((entry) => entry.name).join(", ")}. ` +
        "A file already exists in .adg/grammars/ for these, but its sha256 does not match the pinned digest for its " +
        "package and version -- not the same thing as never having installed one. It may be left over from before " +
        "this check existed, or it may have been placed there some other way. Refused, not trusted; treated the same " +
        "as missing below.",
    );
  }
  if (grammarsToInstall.length > 0) {
    lines.push(
      `No tree-sitter grammar resolvable yet for: ${grammarsToInstall.map((entry) => entry.name).join(", ")}. ` +
        "Until one is installed, mutate and test-diff fall back to the regex scanner for these files, with a warning.",
    );
    lines.push("Install with:");
    for (const entry of grammarsToInstall) {
      lines.push(`  npx adg lang add ${entry.name}`);
    }
  }
  if (detectedLanguages.length > 0) {
    lines.push(
      ".adg/grammars/ is a fetch cache, not source: adg lang add and adg init write a .gitignore into it so an " +
        "ordinary `git add` does not sweep an unverified file into a commit. Do not commit anything in that " +
        "directory by hand.",
    );
  }

  lines.push("");
  lines.push("Next steps:");
  lines.push("");
  // A one-off npx run leaves nothing installed, so the hook it writes cannot
  // find the tool later. Better to say so here than to let the first commit
  // discover it.
  if (!existsSync(join(targetDir, "node_modules", "agent-delivery-gates"))) {
    lines.push("This project does not have agent-delivery-gates installed, so the hook");
    lines.push("written above cannot run yet. Install it first:");
    lines.push("  npm install --save-dev agent-delivery-gates");
    lines.push("");
  }
  lines.push("Enable the git hook (run this yourself; init never touches git config):");
  lines.push("  git config core.hooksPath .githooks");
  lines.push("");
  lines.push("For the standalone route, add these to .claude/settings.json:");
  for (const settingsLine of standaloneSettingsLines(targetDir, packageRoot)) {
    lines.push(`  ${settingsLine}`);
  }
  lines.push("The Claude Code plugin route needs none of this: it wires the hooks in on its own.");
  lines.push("");
  lines.push("npm scripts you may want to add to package.json (not written for you):");
  for (const scriptLine of suggestedNpmScripts()) {
    lines.push(`  ${scriptLine}`);
  }

  return {
    exitCode: 0,
    lines,
    missingGrammarLanguages: dryRun ? [] : grammarsToInstall.map((entry) => entry.name),
  };
}

/**
 * Folds whether an attempted grammar install succeeded into `init`'s own
 * exit code. `runInit` above decides `baseExitCode` before any fetch is
 * even considered -- writing the starter files and finding missing
 * grammars never touches the network -- so this is the one place the two
 * facts meet.
 *
 * `baseExitCode` wins whenever it is already non-zero: a setup problem
 * (an unreadable target, a bad argument) is a different, earlier kind of
 * failure than a grammar that could not be fetched, and should not be
 * masked by it or vice versa.
 *
 * Otherwise, `grammarsOk` decides between 0 and 1. `grammarsOk` is `true`
 * both when every attempted install succeeded and when nothing was
 * attempted at all (declined, or nothing was missing) -- see
 * bin/adg.ts's maybeInstallGrammars for that decision. A partial failure
 * (one language installs, another does not) is folded into the same 1 as
 * a total failure, not a separate code: a caller checking this exit code
 * asked for every detected language's grammar, and "some of what was
 * asked for did not happen" is not success, whether that is one language
 * out of two or two out of two. The FAILED lines already printed are
 * where the distinction actually lives, for a person reading them; the
 * exit code only needs to answer "did everything I asked for happen,
 * yes or no."
 *
 * Before this existed, `bin/adg.ts` computed `outcome.exitCode` and threw
 * away whatever `maybeInstallGrammars` reported, so `adg init
 * --install-grammars` exited 0 even when every fetch failed.
 */
export function combineInitExitCode(baseExitCode: number, grammarsOk: boolean): number {
  if (baseExitCode !== 0) return baseExitCode;
  return grammarsOk ? 0 : 1;
}
