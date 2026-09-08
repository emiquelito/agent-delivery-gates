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

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

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
  // git ignores a hook that is not executable, and says so only in a hint.
  // A gate that looks installed and does nothing is the worst outcome here.
  if (executable) chmodSync(target, 0o755);
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
      const scanScript = join(packageRoot, "scripts", "scan-prose.sh");
      const rulesTarget = resolve(targetDir, PROSE_RULES_REL_PATH);
      const baselineTarget = resolve(targetDir, PROSE_BASELINE_REL_PATH);
      const result = spawnSync(
        "bash",
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

  return { exitCode: 0, lines };
}
