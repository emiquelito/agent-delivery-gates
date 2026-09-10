// Tests for scripts/build.ts, the cross-platform replacement for
// `rm -rf dist && tsc ... && chmod +x dist/bin/adg.js`. That old script only
// ran under a POSIX shell; npm runs scripts through cmd.exe on Windows,
// where neither rm nor chmod exists, and the script is wired to `prepare`,
// which npm runs on `npm install`/`npm ci` in a git checkout.
//
// Every test builds a small standalone fixture project -- its own
// tsconfig.build.json and a couple of .ts sources -- and runs the real
// scripts/build.ts against it as a subprocess, the same way the rest of
// this suite tests a CLI: behavior, not the source string. The fixture
// gets its own copy of scripts/build.ts, read fresh from this repository's
// copy on every run, so a change to the real script is what this test
// exercises, not a frozen duplicate that could drift out of sync with it.
// node_modules/typescript is not reinstalled into every fixture; it is
// symlinked from this repository's own install, which the build needs
// anyway.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  statSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const REAL_BUILD_SCRIPT = readFileSync(join(ROOT, "scripts", "build.ts"), "utf8");

/** A minimal project scripts/build.ts can build: a copy of the real build
 * script, one small source file, a tsconfig.build.json that emits it, and a
 * symlink to this repository's own node_modules/typescript so the fixture
 * does not need its own install. */
function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "adg-build-script-test-"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  writeFileSync(join(dir, "scripts", "build.ts"), REAL_BUILD_SCRIPT);
  writeFileSync(
    join(dir, "bin", "adg.ts"),
    "export function greet(name: string): string {\n  return `hello, ${name}`;\n}\n",
  );
  writeFileSync(
    join(dir, "tsconfig.build.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2023",
          lib: ["ES2023"],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          allowImportingTsExtensions: true,
          rewriteRelativeImportExtensions: true,
          noEmit: false,
          declaration: false,
          outDir: "dist",
          rootDir: ".",
        },
        include: ["bin/**/*.ts"],
      },
      null,
      2,
    ),
  );
  symlinkSync(join(ROOT, "node_modules", "typescript"), join(dir, "node_modules", "typescript"), "junction");
  return dir;
}

function runBuild(dir: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(dir, "scripts", "build.ts")], {
    cwd: dir,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function withFixture(fn: (dir: string) => void): void {
  const dir = makeFixture();
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a clean build produces the compiled output", () => {
  withFixture((dir) => {
    const result = runBuild(dir);
    assert.equal(result.status, 0, `build failed: ${result.stdout}${result.stderr}`);
    const outPath = join(dir, "dist", "bin", "adg.js");
    assert.ok(existsSync(outPath), `${outPath} was not produced`);
    const compiled = readFileSync(outPath, "utf8");
    assert.match(compiled, /hello, \$\{name\}/);
  });
});

test("a build with stale content already in dist/ removes it before compiling", () => {
  withFixture((dir) => {
    mkdirSync(join(dir, "dist", "leftover-dir"), { recursive: true });
    writeFileSync(join(dir, "dist", "leftover-file.txt"), "stale from a previous build");
    const result = runBuild(dir);
    assert.equal(result.status, 0, `build failed: ${result.stdout}${result.stderr}`);
    assert.equal(existsSync(join(dir, "dist", "leftover-file.txt")), false, "stale file survived the build");
    assert.equal(existsSync(join(dir, "dist", "leftover-dir")), false, "stale directory survived the build");
    assert.ok(existsSync(join(dir, "dist", "bin", "adg.js")), "the real output is missing");
  });
});

test("on POSIX, dist/bin/adg.js comes out executable", { skip: process.platform === "win32" }, () => {
  withFixture((dir) => {
    const result = runBuild(dir);
    assert.equal(result.status, 0, `build failed: ${result.stdout}${result.stderr}`);
    const mode = statSync(join(dir, "dist", "bin", "adg.js")).mode & 0o777;
    assert.equal(mode & 0o100, 0o100, `owner-execute bit not set: mode ${mode.toString(8)}`);
  });
});

test("a failing tsc makes the build exit non-zero and print the error", () => {
  withFixture((dir) => {
    writeFileSync(join(dir, "bin", "adg.ts"), "this is not valid typescript !!! @@@\n");
    const result = runBuild(dir);
    assert.notEqual(result.status, 0, "a syntax error in the source should fail the build");
    assert.match(result.stdout + result.stderr, /error TS/);
  });
});
