// The part of `init` that goes beyond writing new files: installing the
// package, writing a test command, ignoring node_modules, pointing git at the
// hooks, and staging the result.
//
// These steps edit things a person already owns (package.json, .gitignore,
// git config), so the rule is stricter than for the starter files: nothing
// here replaces a value that is already set. Every step is planned first, as
// plain data, so the plan can be printed in full before any of it runs, and
// a dry run is the same plan with nothing applied. Each step that is skipped
// says why, and says what a person would type to do it themselves.

import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, sep } from "node:path";
import { spawnSync } from "node:child_process";

export interface SetupStep {
  id: "install" | "test-script" | "grammars" | "gitignore" | "hooks-path" | "stage";
  action: "do" | "skip";
  /** What happens (action "do") or what was left alone (action "skip"). */
  summary: string;
  /** For a skip: why. */
  reason?: string;
  /** For a skip a person may still want to do: the command to run. */
  manual?: string;
  /** Step-specific data the applier needs. */
  data?: Record<string, unknown>;
}

export interface SetupOptions {
  targetDir: string;
  packageRoot: string;
  packageVersion: string;
  /** Paths (relative to targetDir) that this run's file step created. */
  createdPaths: string[];
  /** Languages with no usable grammar, from init's own detection. */
  missingGrammars: string[];
  /** false means the person passed --no-install-grammars. */
  grammarsAllowed: boolean;
  /** Overrides the npm spec to install. Used by tests and for local
   * tarballs; undefined means "this package at this version", and only when
   * this process is running from an installed copy. */
  installSpec?: string;
}

function git(targetDir: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { cwd: targetDir, encoding: "utf8" });
  if (r.error) return { ok: false, out: "" };
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
}

export function isGitRepo(targetDir: string): boolean {
  return git(targetDir, ["rev-parse", "--show-toplevel"]).ok;
}

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPackageJson(targetDir: string): PackageJson | undefined {
  try {
    return JSON.parse(readFileSync(join(targetDir, "package.json"), "utf8")) as PackageJson;
  } catch {
    return undefined;
  }
}

function listFiles(targetDir: string): string[] {
  const r = git(targetDir, ["ls-files", "-co", "--exclude-standard"]);
  if (!r.ok) return [];
  return r.out
    .split("\n")
    .filter((f) => f !== "" && !/(^|\/)(node_modules|vendor|target)\//.test(f));
}

export interface TestCommandResult {
  command?: string;
  /** Evidence when a command was chosen, or why none was. */
  reason: string;
}

/** Works out a test command only when the repository plainly has tests AND
 * the runner for them is not a guess. Looks at the repository root only: a
 * nested module could need a different working directory, which a single
 * npm script cannot express honestly. More than one candidate means the
 * answer is not obvious, so none is chosen. */
export function detectTestCommand(targetDir: string): TestCommandResult {
  const files = listFiles(targetDir);
  const has = (re: RegExp): number => files.filter((f) => re.test(f)).length;
  const atRoot = (name: string): boolean => files.includes(name);
  const candidates: Array<{ command: string; reason: string }> = [];

  const goTests = has(/_test\.go$/);
  if (atRoot("go.mod") && goTests > 0) {
    candidates.push({ command: "go test ./...", reason: `go.mod and ${goTests} *_test.go file(s)` });
  }

  if (atRoot("Cargo.toml")) {
    const integration = has(/^tests\/.+\.rs$/);
    let inline = 0;
    for (const f of files.filter((p) => /^src\/.+\.rs$/.test(p))) {
      try {
        if (/#\[(cfg\(test\)|test)\]/.test(readFileSync(join(targetDir, f), "utf8"))) inline++;
      } catch {
        // an unreadable file is not evidence
      }
    }
    if (integration + inline > 0) {
      candidates.push({ command: "cargo test", reason: `Cargo.toml and Rust tests (${integration} in tests/, ${inline} inline)` });
    }
  }

  const pyTests = has(/(^|\/)test_[^/]*\.py$|_test\.py$/);
  let pytestConfigured = atRoot("pytest.ini");
  if (!pytestConfigured && atRoot("pyproject.toml")) {
    try {
      pytestConfigured = /\[tool\.pytest/.test(readFileSync(join(targetDir, "pyproject.toml"), "utf8"));
    } catch {
      // treat as not configured
    }
  }
  if (pytestConfigured && pyTests > 0) {
    candidates.push({ command: "pytest", reason: `pytest configuration and ${pyTests} Python test file(s)` });
  }

  const javaTests = has(/^src\/test\/.+\.(java|kt)$/);
  if (atRoot("pom.xml") && javaTests > 0) {
    candidates.push({
      command: atRoot("mvnw") ? "./mvnw test" : "mvn test",
      reason: `pom.xml and ${javaTests} test source file(s) under src/test`,
    });
  } else if ((atRoot("build.gradle") || atRoot("build.gradle.kts")) && atRoot("gradlew") && javaTests > 0) {
    candidates.push({ command: "./gradlew test", reason: `Gradle wrapper and ${javaTests} test source file(s) under src/test` });
  }

  const csprojs = files.filter((f) => /^[^/]+\.(csproj|sln)$/.test(f));
  if (csprojs.length > 0) {
    const testProject = files.filter((f) => /\.csproj$/.test(f)).some((f) => {
      try {
        return /Microsoft\.NET\.Test\.Sdk/.test(readFileSync(join(targetDir, f), "utf8"));
      } catch {
        return false;
      }
    });
    if (testProject && csprojs.some((f) => f.endsWith(".sln"))) {
      candidates.push({ command: "dotnet test", reason: "a .sln at the root and a test project referencing Microsoft.NET.Test.Sdk" });
    }
  }

  const specs = has(/^spec\/.+_spec\.rb$/);
  if (atRoot("Gemfile") && specs > 0) {
    candidates.push({ command: "bundle exec rspec", reason: `Gemfile and ${specs} RSpec file(s) under spec/` });
  }

  const phpTests = has(/Test\.php$/);
  if (atRoot("composer.json") && (atRoot("phpunit.xml") || atRoot("phpunit.xml.dist")) && phpTests > 0) {
    candidates.push({ command: "vendor/bin/phpunit", reason: `composer.json, a PHPUnit config and ${phpTests} test file(s)` });
  }

  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1) {
    return {
      reason: `more than one test runner is plausible (${candidates.map((c) => c.command).join(", ")}), so no choice is made for you`,
    };
  }
  return { reason: "no test runner could be identified with confidence" };
}

function otherPackageManager(targetDir: string): string | undefined {
  if (existsSync(join(targetDir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(targetDir, "yarn.lock"))) return "yarn";
  if (existsSync(join(targetDir, "bun.lock")) || existsSync(join(targetDir, "bun.lockb"))) return "bun";
  return undefined;
}

export function planSetup(opts: SetupOptions): SetupStep[] {
  const { targetDir, packageRoot, packageVersion } = opts;
  const steps: SetupStep[] = [];
  const repo = isGitRepo(targetDir);
  const pkg = readPackageJson(targetDir);
  const nodeModulesBefore = existsSync(join(targetDir, "node_modules"));
  const installed = existsSync(join(targetDir, "node_modules", "agent-delivery-gates"));
  const declared =
    pkg?.dependencies?.["agent-delivery-gates"] !== undefined ||
    pkg?.devDependencies?.["agent-delivery-gates"] !== undefined;
  const isOwnCheckout = packageRoot === targetDir;

  // 1. install itself
  const runningInstalled = packageRoot.split(sep).includes("node_modules");
  const spec = opts.installSpec ?? (runningInstalled ? `agent-delivery-gates@${packageVersion}` : undefined);
  const manualInstall = `npm install --save-dev agent-delivery-gates`;
  let installPlanned = false;
  if (installed || isOwnCheckout) {
    steps.push({ id: "install", action: "skip", summary: "install agent-delivery-gates", reason: installed ? "already installed in node_modules" : "this is the package's own checkout" });
  } else if (declared) {
    steps.push({ id: "install", action: "skip", summary: "install agent-delivery-gates", reason: "package.json already lists it; run your package manager's install to fetch it" });
  } else if (otherPackageManager(targetDir) !== undefined) {
    const pm = otherPackageManager(targetDir)!;
    steps.push({
      id: "install", action: "skip", summary: "install agent-delivery-gates",
      reason: `this project uses ${pm}, and running npm would create a second lockfile`,
      manual: `${pm} add --dev agent-delivery-gates`,
    });
  } else if (spec === undefined) {
    steps.push({ id: "install", action: "skip", summary: "install agent-delivery-gates", reason: "this run is not from an installed copy, so there is no published version to install", manual: manualInstall });
  } else {
    installPlanned = true;
    steps.push({
      id: "install", action: "do",
      summary: `install ${spec} as a dev dependency (npm install --save-dev ${spec})${pkg === undefined ? "; this also creates package.json and package-lock.json" : ""}`,
      data: { spec },
    });
  }

  // 2. test command
  const willHavePackageJson = pkg !== undefined || installPlanned;
  const detected = detectTestCommand(targetDir);
  const existingTest = pkg?.scripts?.test;
  if (existingTest !== undefined) {
    const placeholder = /no test specified/.test(existingTest);
    steps.push({
      id: "test-script", action: "skip", summary: "set scripts.test in package.json",
      reason: placeholder
        ? `scripts.test is already set (to npm's placeholder, "${existingTest}"); init does not replace a value that is there`
        : `scripts.test is already set ("${existingTest}")`,
      manual: detected.command !== undefined && placeholder ? `npm pkg set "scripts.test=${detected.command}"` : undefined,
    });
  } else if (detected.command === undefined) {
    steps.push({ id: "test-script", action: "skip", summary: "set scripts.test in package.json", reason: detected.reason });
  } else if (!willHavePackageJson) {
    steps.push({
      id: "test-script", action: "skip", summary: "set scripts.test in package.json",
      reason: `no package.json, and the pre-commit hook reads its test command from there (${detected.reason})`,
      manual: `npm pkg set "scripts.test=${detected.command}"`,
    });
  } else {
    steps.push({
      id: "test-script", action: "do",
      summary: `set scripts.test to "${detected.command}" (${detected.reason}; none was configured)`,
      data: { command: detected.command },
    });
  }

  // 3. grammars
  if (opts.missingGrammars.length > 0) {
    if (!opts.grammarsAllowed) {
      steps.push({
        id: "grammars", action: "skip", summary: `fetch tree-sitter grammar(s): ${opts.missingGrammars.join(", ")}`,
        reason: "--no-install-grammars was given",
        manual: opts.missingGrammars.map((n) => `npx adg lang add ${n}`).join("; "),
      });
    } else {
      steps.push({
        id: "grammars", action: "do",
        summary: `fetch the verified tree-sitter grammar(s) into .adg/grammars/: ${opts.missingGrammars.join(", ")} (by hand: ${opts.missingGrammars.map((n) => `npx adg lang add ${n}`).join("; ")})`,
      });
    }
  }

  // 4. gitignore for a node_modules this run is about to create
  if (installPlanned) {
    if (!repo) {
      steps.push({ id: "gitignore", action: "skip", summary: "add node_modules/ to .gitignore", reason: "not a git repository" });
    } else if (nodeModulesBefore) {
      steps.push({ id: "gitignore", action: "skip", summary: "add node_modules/ to .gitignore", reason: "node_modules already existed, so it is not something this run creates" });
    } else if (git(targetDir, ["check-ignore", "-q", "node_modules/agent-delivery-gates/package.json"]).ok) {
      steps.push({ id: "gitignore", action: "skip", summary: "add node_modules/ to .gitignore", reason: "node_modules is already ignored" });
    } else {
      steps.push({ id: "gitignore", action: "do", summary: `add node_modules/ to .gitignore (${existsSync(join(targetDir, ".gitignore")) ? "one line appended" : "file created"}; the install creates node_modules and nothing ignores it)` });
    }
  }

  // 5. hooks path
  const hookFile = join(".githooks", "pre-commit");
  if (!repo) {
    steps.push({ id: "hooks-path", action: "skip", summary: "set core.hooksPath to .githooks", reason: "not a git repository" });
  } else {
    const current = git(targetDir, ["config", "--get", "core.hooksPath"]);
    const hooksDir = git(targetDir, ["rev-parse", "--git-path", "hooks"]);
    const existingHook = hooksDir.ok && existsSync(join(targetDir, hooksDir.out, "pre-commit"));
    if (current.ok && current.out === ".githooks") {
      steps.push({ id: "hooks-path", action: "skip", summary: "set core.hooksPath to .githooks", reason: "already set to .githooks" });
    } else if (current.ok && current.out !== "") {
      steps.push({
        id: "hooks-path", action: "skip", summary: "set core.hooksPath to .githooks",
        reason: `core.hooksPath is already set to "${current.out}"`,
        manual: `copy or call ${hookFile} from the hooks there, or: git config core.hooksPath .githooks`,
      });
    } else if (existingHook) {
      steps.push({
        id: "hooks-path", action: "skip", summary: "set core.hooksPath to .githooks",
        reason: `${join(hooksDir.out, "pre-commit")} exists, and a hooks path would stop git from running it`,
        manual: "git config core.hooksPath .githooks",
      });
    } else {
      steps.push({ id: "hooks-path", action: "do", summary: "set core.hooksPath to .githooks (local git config)" });
    }
  }

  // 6. stage
  if (!repo) {
    steps.push({ id: "stage", action: "skip", summary: "stage the files this run creates", reason: "not a git repository" });
  } else {
    steps.push({
      id: "stage", action: "do",
      summary: "stage what this run created or changed (git add), so the next step is a commit",
      data: { created: opts.createdPaths },
    });
  }
  return steps;
}

export interface StepResult {
  id: SetupStep["id"];
  ok: boolean;
  message: string;
}

function run(cmd: string, args: string[], cwd: string, timeout = 600_000): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout });
  if (r.error) return { ok: false, out: r.error.message };
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

function dirtyPaths(targetDir: string, paths: string[]): Set<string> {
  const dirty = new Set<string>();
  for (const p of paths) {
    const r = git(targetDir, ["status", "--porcelain", "--", p]);
    if (r.ok && r.out !== "") dirty.add(p);
  }
  return dirty;
}

/** Applies the "do" steps other than grammars, which bin/adg.ts runs itself
 * because the fetch is async. Order matters: install first, since the
 * test-script step needs package.json and the ignore step needs to precede
 * staging. A failed step does not stop the later ones that do not depend on
 * it; each result is reported as it is. */
export function applySetup(steps: SetupStep[], targetDir: string, onResult: (r: StepResult) => void): StepResult[] {
  const results: StepResult[] = [];
  const emit = (r: StepResult): void => {
    results.push(r);
    onResult(r);
  };
  const touchedByUs = ["package.json", "package-lock.json", ".gitignore"];
  // A file that already held uncommitted work of the person's must not be
  // swept into the staged set by a step that merely appended to it.
  const dirtyBefore = dirtyPaths(targetDir, touchedByUs);
  const existedBefore = new Set(touchedByUs.filter((p) => existsSync(join(targetDir, p))));
  let installOk = true;

  for (const step of steps) {
    if (step.action !== "do") continue;
    if (step.id === "install") {
      const spec = step.data!.spec as string;
      const r = run("npm", ["install", "--save-dev", "--no-audit", "--no-fund", spec], targetDir);
      installOk = r.ok;
      emit({ id: "install", ok: r.ok, message: r.ok ? `installed ${spec}` : `npm install failed:\n${r.out}` });
    } else if (step.id === "test-script") {
      const command = step.data!.command as string;
      const r = run("npm", ["pkg", "set", `scripts.test=${command}`], targetDir);
      emit({ id: "test-script", ok: r.ok, message: r.ok ? `set scripts.test to "${command}"` : `npm pkg set failed:\n${r.out}` });
    } else if (step.id === "gitignore") {
      const file = join(targetDir, ".gitignore");
      try {
        if (existsSync(file)) {
          const text = readFileSync(file, "utf8");
          appendFileSync(file, `${text === "" || text.endsWith("\n") ? "" : "\n"}node_modules/\n`);
        } else {
          writeFileSync(file, "node_modules/\n");
        }
        emit({ id: "gitignore", ok: true, message: "added node_modules/ to .gitignore" });
      } catch (err) {
        emit({ id: "gitignore", ok: false, message: `could not write .gitignore: ${(err as Error).message}` });
      }
    } else if (step.id === "hooks-path") {
      const r = run("git", ["config", "core.hooksPath", ".githooks"], targetDir);
      emit({ id: "hooks-path", ok: r.ok, message: r.ok ? "set core.hooksPath to .githooks" : `git config failed:\n${r.out}` });
    }
  }

  const stage = steps.find((s) => s.id === "stage" && s.action === "do");
  if (stage !== undefined) {
    const created = (stage.data!.created as string[]).filter((p) => existsSync(join(targetDir, p)));
    const toAdd = [...created];
    const notStaged: string[] = [];
    for (const p of touchedByUs) {
      if (!existsSync(join(targetDir, p))) continue;
      const changedNow = dirtyPaths(targetDir, [p]).has(p);
      if (!changedNow) continue;
      if (existedBefore.has(p) && dirtyBefore.has(p)) notStaged.push(p);
      else toAdd.push(p);
    }
    if (!installOk) {
      // package.json may be half-written; do not stage on top of a failure.
      emit({ id: "stage", ok: false, message: "not staged, because the install failed" });
    } else if (toAdd.length === 0 && notStaged.length === 0) {
      emit({ id: "stage", ok: true, message: "nothing to stage" });
    } else {
      const r = toAdd.length > 0 ? run("git", ["add", "--", ...toAdd], targetDir) : { ok: true, out: "" };
      const skipNote = notStaged.length > 0 ? `; left unstaged because you had uncommitted changes in them: ${notStaged.join(", ")}` : "";
      emit({ id: "stage", ok: r.ok, message: r.ok ? `staged: ${toAdd.join(", ")}${skipNote}` : `git add failed:\n${r.out}` });
    }
  }
  return results;
}
