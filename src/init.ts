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

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

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
}

export interface InitOutcome {
  exitCode: number;
  lines: string[];
}

interface TemplateAction {
  relPath: string;
  templateName: string;
}

const TEMPLATE_ACTIONS: TemplateAction[] = [
  { relPath: join(".githooks", "pre-commit"), templateName: "pre-commit" },
  { relPath: "AGENTS.md", templateName: "AGENTS.md" },
  { relPath: join("docs", "gate-tally.md"), templateName: "gate-tally.md" },
];

const PROSE_RULES_REL_PATH = join(".adg", "prose-rules.txt");

interface WriteCtx {
  dryRun: boolean;
  force: boolean;
  lines: string[];
}

/** Writes one file under targetDir, or, in dry-run mode, only reports what
 * it would have done. Never touches a file that already exists unless
 * force is set. */
function writeOrPlan(targetDir: string, relPath: string, getContent: () => string, ctx: WriteCtx): void {
  const target = resolve(targetDir, relPath);
  // Every relPath passed in above is a fixed literal, never built from
  // user input, so this can only trip if that ever changes. Kept as a
  // real check and not only a comment: a target directory is exactly the
  // kind of thing this tool must never write outside of.
  if (target !== targetDir && !target.startsWith(targetDir + sep)) {
    throw new Error(`refusing to write outside the target directory: '${target}'`);
  }

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
  ctx.lines.push(`${exists ? "overwrote" : "created"}: ${relPath}`);
}

function fail(message: string): InitOutcome {
  return { exitCode: 2, lines: [`init: ${message}`] };
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
  const { targetDir, packageRoot, dryRun, force, prosePreset } = options;

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
  const resolvedActions: { relPath: string; templatePath: string }[] = [];
  for (const action of TEMPLATE_ACTIONS) {
    const templatePath = join(packageRoot, "templates", action.templateName);
    if (!existsSync(templatePath)) {
      return fail(`template '${templatePath}' is missing from the installed package`);
    }
    resolvedActions.push({ relPath: action.relPath, templatePath });
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
    writeOrPlan(targetDir, action.relPath, () => readFileSync(action.templatePath, "utf8"), ctx);
  }

  if (prosePresetPath !== undefined) {
    const content = `include: ${prosePresetPath}\n`;
    writeOrPlan(targetDir, PROSE_RULES_REL_PATH, () => content, ctx);
  }

  lines.push("");
  lines.push("Next steps:");
  lines.push("");
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

  return { exitCode: 0, lines };
}
