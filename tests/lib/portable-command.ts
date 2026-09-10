// Small helpers for building --command / --inject / --neutralize values
// that run the same way on every platform spawnCommand runs on.
//
// spawnCommand (src/spawn-command.ts) runs whatever string a test passes
// through the current platform's own shell, with `shell: true`. sh and
// cmd.exe do not agree on much: cmd.exe has no `[ ]`, no `kill`, no
// `printf`, no pipes into `yes`/`head`, and it does not strip single
// quotes as a string delimiter the way sh does -- it treats them as plain
// characters. `node` is the one program guaranteed identical on every
// runner this suite targets, so every command built here is a `node -e`
// script instead of a shell script.
//
// The one rule that keeps a script built here portable: it must not need
// a double quote of its own, because the whole script is wrapped in
// double quotes -- the only quote character both sh and cmd.exe agree
// delimits a string. Every JS string literal a script needs is written
// with a single quote instead.

/** Wraps a JavaScript snippet as `node -e "<js>"`, a --command / --inject
 * / --neutralize value that runs the same way under sh and cmd.exe.
 * Throws if `js` contains a double quote, which is exactly the mistake
 * this helper exists to catch: a script with one runs fine under sh and
 * breaks under cmd.exe, so its absence is checked here instead of
 * trusted to every call site. */
export function nodeCommand(js: string): string {
  if (js.includes('"')) {
    throw new Error(`nodeCommand: script must avoid double quotes, or it will not run under cmd.exe: ${js}`);
  }
  return `node -e "${js}"`;
}

/** JS for: does `path` exist in the current directory? A portable stand-in
 * for `[ -f path ]`. `path` must not itself contain a single quote. */
export function existsExpr(path: string): string {
  return `require('fs').existsSync('${path}')`;
}

/** JS for: write `text` to stdout exactly as given, with a `\n` written as
 * a literal newline escape. A portable stand-in for `printf`. */
export function writeExpr(text: string): string {
  const escaped = text.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n");
  return `process.stdout.write('${escaped}')`;
}

/** JS statement: run `shellCommand` through this platform's own shell (the
 * same way spawnCommand itself runs any command) and exit with its
 * status. Used to keep one branch of a conditional test command running
 * the real suite command unchanged, instead of rewriting it too. */
export function runAndExit(shellCommand: string): string {
  const escaped = shellCommand.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return (
    `process.exit(require('child_process').spawnSync('${escaped}',{shell:true,stdio:'inherit'}).status ?? 1)`
  );
}

/** JS statements: read an integer counter from the file named by the
 * environment variable `envVar` (0 if the file is missing or unreadable),
 * write back the count plus one, and bind that new count to `n` for the
 * rest of the script. A portable stand-in for the
 * `n=$(cat "$VAR" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$VAR"`
 * idiom a command used to count how many times it had already run. */
export function bumpCounter(envVar: string): string {
  return (
    `const fs=require('fs');` +
    `const p=process.env.${envVar};` +
    `let n=0;try{n=parseInt(fs.readFileSync(p,'utf8'),10)||0}catch(e){}` +
    `n+=1;fs.writeFileSync(p,String(n));`
  );
}
