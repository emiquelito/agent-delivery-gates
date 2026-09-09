// Tests for the project homepage and the workflow that publishes it.
//
// The page states counts, rule ids, and dates. Every one of them is read out
// of `rules/` and `docs/gate-tally.md` when the page is built, and these
// tests read the same records again and check the page against them. A
// marketing page is the most likely place for this repository to contradict
// its own records next, so the contradiction is what is checked here, not
// the wording.
//
// Reading the records again is worth something only if it is read a second
// way. An earlier version of this file copied the generator's own table
// parser line for line, so a bug in that parser was reproduced here and the
// two agreed on the same wrong total. The tally is counted below with a
// single regex over the raw file, with no header search and no stop at the
// first line that is not a row, so the two disagree whenever either one is
// wrong.
//
// The site is generated into a scratch directory for each run instead of
// being read from a committed build. A committed build goes stale the moment
// a record changes, and a stale page passing its own tests is exactly the
// failure this project exists to catch.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  readdirSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  cpSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(ROOT, "site", "build.js");
const WORKFLOW = join(ROOT, ".github", "workflows", "pages.yml");
const SITE_URL = "https://agentgates.dev/";
const SITE_HOST = "agentgates.dev";

// The crawlers the robots file has to name, search engines and AI crawlers
// alike. Named here as well as in the generator so that dropping one from
// the generator fails a test instead of quietly narrowing who may read the
// page.
const REQUIRED_CRAWLERS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-User",
  "anthropic-ai",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "Applebot-Extended",
  "CCBot",
  "Bytespider",
  "Amazonbot",
  "meta-externalagent",
];

// --- building the site once for the whole file -------------------------------

let outDir = "";
let html = "";
let robots = "";
let sitemap = "";

function runBuild(
  buildScript: string,
  out: string,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [buildScript, "--out", out], {
    encoding: "utf8",
    cwd: ROOT,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

before(() => {
  outDir = mkdtempSync(join(tmpdir(), "adg-site-"));
  const result = runBuild(BUILD, join(outDir, "dist"));
  assert.equal(result.status, 0, `the site build failed: ${result.stderr}`);
  html = readFileSync(join(outDir, "dist", "index.html"), "utf8");
  robots = readFileSync(join(outDir, "dist", "robots.txt"), "utf8");
  sitemap = readFileSync(join(outDir, "dist", "sitemap.xml"), "utf8");
});

after(() => {
  if (outDir !== "") rmSync(outDir, { recursive: true, force: true });
});

// --- the records, read a second way -----------------------------------------

interface RuleRecord {
  id: string;
  name: string;
  severity: string;
  enforcement: string;
  emits?: string[];
}

function readRules(): RuleRecord[] {
  const dir = join(ROOT, "rules");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json") && name !== "schema.json")
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as RuleRecord);
}

interface TallyFacts {
  total: number;
  first: string;
  last: string;
  counts: Map<string, number>;
}

/**
 * Counts the tally with one regex over the whole file: every line that opens
 * with a number, a date, and a rule id, wherever in the file it sits.
 *
 * This deliberately shares no code and no algorithm with the generator. The
 * generator finds a header row, walks forward, and stops at the first line
 * that is not a row; this walks nothing and stops nowhere. A gap in the table
 * changes the generator's answer and cannot change this one, which is the
 * whole point of counting it here.
 */
const TALLY_ROW = /^\| *(\d+) *\| *(\d{4}-\d{2}-\d{2}) *\| *([a-z0-9-]+) *\|/gm;

function readTally(ruleIds: string[]): TallyFacts {
  const raw = readFileSync(join(ROOT, "docs", "gate-tally.md"), "utf8");
  const rows = [...raw.matchAll(TALLY_ROW)];
  assert.ok(rows.length > 0, "docs/gate-tally.md holds no row this test can count");

  const counts = new Map<string, number>(ruleIds.map((id) => [id, 0]));
  const dates: string[] = [];
  for (const row of rows) {
    counts.set(row[3], (counts.get(row[3]) ?? 0) + 1);
    dates.push(row[2]);
  }
  dates.sort();

  // The row numbers run 1..n with no gap, which is a second reading of the
  // same total that does not depend on how many rows the regex matched.
  const numbers = rows.map((row) => Number(row[1])).sort((a, b) => a - b);
  assert.deepEqual(
    numbers,
    Array.from({ length: rows.length }, (_, i) => i + 1),
    "the tally row numbers are not 1..n, so one count of this file is wrong",
  );

  return { total: rows.length, first: dates[0], last: dates[dates.length - 1], counts };
}

/** Every `<code>` fragment on the page, unescaped. */
function codeTokens(page: string): string[] {
  return [...page.matchAll(/<code>([^<]*)<\/code>/g)].map((m) =>
    m[1]
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&#39;", "'")
      .replaceAll("&amp;", "&"),
  );
}

// --- the page against the records --------------------------------------------

test("every rule in the catalog appears on the page", () => {
  const rules = readRules();
  for (const rule of rules) {
    assert.ok(
      html.includes(`<code>${rule.id}</code>`),
      `the page never names the rule ${rule.id}`,
    );
    assert.ok(html.includes(rule.name), `the page never names the rule "${rule.name}"`);
  }
});

test("the page names no rule that does not exist", () => {
  const rules = readRules();
  const ids = new Set(rules.map((rule) => rule.id));
  // The rule entries in the catalog are the page's own list of rules.
  const listed = [...html.matchAll(/<h4><code>([^<]+)<\/code><\/h4>/g)].map((m) => m[1]);
  assert.deepEqual(
    [...listed].sort(),
    [...ids].sort(),
    "the catalog on the page and the records in rules/ list different rules",
  );

  // Nothing anywhere else on the page may read as a rule id either. A code
  // fragment made only of lowercase words joined by hyphens is either a rule
  // id, one of the check ids a rule record declares it emits, the package
  // name, or a subcommand the tool really has; anything else is a rule or a
  // command this repository does not have. The subcommands are read out of
  // the command line entry point, so a page naming a command that was never
  // written fails here too.
  const known = new Set<string>([...ids, "agent-delivery-gates"]);
  for (const rule of rules) for (const emitted of rule.emits ?? []) known.add(emitted);
  const cli = readFileSync(join(ROOT, "bin", "adg.ts"), "utf8");
  const subcommands = [...cli.matchAll(/^\s*case "([a-z][a-z0-9-]*)":/gm)].map((m) => m[1]);
  assert.ok(subcommands.includes("init"), "no subcommands were read out of bin/adg.ts");
  for (const name of subcommands) known.add(name);
  for (const token of codeTokens(html)) {
    if (!/^[a-z]+(-[a-z]+)+$/.test(token)) continue;
    assert.ok(
      known.has(token),
      `the page names "${token}", which is not a rule, a check id, or a command`,
    );
  }
});

test("the page's rule count and grouping come from the records", () => {
  const rules = readRules();
  const hooks = rules.filter((rule) => rule.enforcement === "hook").length;
  assert.ok(
    html.includes(`Enforced by a hook (${hooks})`),
    `the page does not say that ${hooks} rules are enforced by a hook`,
  );
  for (const group of ["hook", "prompt", "human_gate"]) {
    const count = rules.filter((rule) => rule.enforcement === group).length;
    if (count === 0) continue;
    // Each rule is listed exactly once, so the entries add up to the catalog.
    assert.ok(count > 0);
  }
  const listed = [...html.matchAll(/<h4><code>([^<]+)<\/code><\/h4>/g)].length;
  assert.equal(listed, rules.length, "the catalog lists a different number of rules than rules/");
});

test("the tally numbers on the page match docs/gate-tally.md", () => {
  const rules = readRules();
  const tally = readTally(rules.map((rule) => rule.id));
  assert.ok(
    html.includes(`${tally.total} entries, dated ${tally.first} to ${tally.last}`),
    `the page does not report ${tally.total} tally entries dated ${tally.first} to ${tally.last}`,
  );
  for (const rule of rules) {
    const count = tally.counts.get(rule.id);
    assert.ok(
      html.includes(
        `<tr><th scope="row"><code>${rule.id}</code></th><td>${count}</td></tr>`,
      ),
      `the page does not report ${count} tally entries for ${rule.id}`,
    );
  }
});

test("the worked examples on the page are the ones in docs/examples", () => {
  const files = readdirSync(join(ROOT, "docs", "examples"))
    .filter((name) => /^\d+-.*\.md$/.test(name))
    .sort();
  const linked = [...html.matchAll(/blob\/main\/docs\/examples\/([^"]+)/g)].map((m) => m[1]);
  assert.deepEqual(linked.sort(), files, "the page links a different set of examples");
});

// --- indexing -----------------------------------------------------------------

test("the page carries the meta tags a crawler reads", () => {
  const required: [string, RegExp][] = [
    ["a title", /<title>[^<]{20,}<\/title>/],
    ["a description", /<meta name="description" content="[^"]{50,}">/],
    ["a canonical link", new RegExp(`<link rel="canonical" href="${SITE_URL}">`)],
    ["an English lang attribute", /<html lang="en">/],
    ["og:type", /<meta property="og:type" content="[^"]+">/],
    ["og:url", /<meta property="og:url" content="[^"]+">/],
    ["og:title", /<meta property="og:title" content="[^"]{20,}">/],
    ["og:description", /<meta property="og:description" content="[^"]{50,}">/],
    ["og:image", /<meta property="og:image" content="https:[^"]+">/],
    ["og:image:alt", /<meta property="og:image:alt" content="[^"]{20,}">/],
    ["twitter:card", /<meta name="twitter:card" content="summary_large_image">/],
    ["twitter:title", /<meta name="twitter:title" content="[^"]{20,}">/],
    ["twitter:description", /<meta name="twitter:description" content="[^"]{50,}">/],
    ["twitter:image", /<meta name="twitter:image" content="https:[^"]+">/],
    ["a viewport", /<meta name="viewport" content="[^"]+">/],
  ];
  for (const [what, pattern] of required) {
    assert.match(html, pattern, `the page has no ${what}`);
  }
});

test("the social image the page points at is really published", () => {
  const match = /<meta property="og:image" content="([^"]+)">/.exec(html);
  assert.ok(match, "the page has no og:image");
  assert.ok(match[1].startsWith(SITE_URL), "og:image is not an absolute URL on this site");
  const file = match[1].slice(SITE_URL.length);
  assert.ok(existsSync(join(outDir, "dist", file)), `the build never wrote ${file}`);
});

test("the JSON-LD block parses and describes this project", () => {
  const match = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match, "the page carries no JSON-LD block");
  const data = JSON.parse(match[1]);
  assert.equal(data["@context"], "https://schema.org");
  const graph = data["@graph"];
  assert.ok(Array.isArray(graph), "the JSON-LD block has no @graph");

  const software = graph.find(
    (node: { "@type": string }) =>
      node["@type"] === "SoftwareSourceCode" || node["@type"] === "SoftwareApplication",
  );
  assert.ok(software, "the JSON-LD names no software entity");
  for (const field of [
    "name",
    "description",
    "codeRepository",
    "programmingLanguage",
    "license",
    "author",
  ]) {
    assert.ok(software[field], `the software entity has no ${field}`);
  }
  assert.equal(software.codeRepository, "https://github.com/emiquelito/agent-delivery-gates");
  assert.equal(software.author["@type"], "Person");

  // A FAQ block is only honest if the page really answers those questions.
  const faq = graph.find((node: { "@type": string }) => node["@type"] === "FAQPage");
  if (faq) {
    for (const entry of faq.mainEntity) {
      assert.equal(entry["@type"], "Question");
      assert.ok(
        html.includes(`<h3>${entry.name.replaceAll("?", "?")}</h3>`) ||
          html.includes(entry.name),
        `the FAQ block asks "${entry.name}", which the page itself never asks`,
      );
      assert.equal(entry.acceptedAnswer["@type"], "Answer");
      assert.ok(entry.acceptedAnswer.text.length > 20, "an FAQ answer is empty");
    }
  }
});

test("robots.txt names every crawler and blocks none of them", () => {
  assert.match(robots, /^User-agent: \*$/m, "robots.txt has no blanket user-agent rule");
  assert.match(robots, /^Allow: \/$/m, "robots.txt allows nothing");
  for (const agent of REQUIRED_CRAWLERS) {
    assert.ok(
      new RegExp(`^User-agent: ${agent}$`, "m").test(robots),
      `robots.txt never names ${agent}`,
    );
  }
  for (const line of robots.split("\n")) {
    const disallow = /^Disallow:\s*(.*)$/.exec(line.trim());
    if (disallow) {
      assert.equal(disallow[1], "", `robots.txt blocks "${disallow[1]}"`);
    }
  }
  assert.ok(robots.includes(`Sitemap: ${SITE_URL}sitemap.xml`), "robots.txt names no sitemap");
});

test("sitemap.xml is well formed and lists the homepage", () => {
  assert.ok(sitemap.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), "no XML declaration");
  assert.ok(
    sitemap.includes('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'),
    "no sitemap urlset",
  );
  assert.ok(sitemap.includes(`<loc>${SITE_URL}</loc>`), "the sitemap does not list the homepage");
  // Well formed enough to check without an XML parser: every tag that opens
  // closes, in order.
  const stack: string[] = [];
  for (const tag of sitemap.matchAll(/<(\/?)([a-zA-Z0-9]+)[^>]*?>/g)) {
    if (tag[0].startsWith("<?")) continue;
    if (tag[1] === "/") {
      assert.equal(stack.pop(), tag[2], `sitemap.xml closes ${tag[2]} out of order`);
    } else if (!tag[0].endsWith("/>")) {
      stack.push(tag[2]);
    }
  }
  assert.deepEqual(stack, [], "sitemap.xml leaves a tag open");
});

test("the page has exactly one h1", () => {
  const headings = html.match(/<h1[\s>]/g) ?? [];
  assert.equal(headings.length, 1, `the page has ${headings.length} h1 elements`);
});

test("the page is readable with no JavaScript and fetches nothing from anyone else", () => {
  // The only script on the page is the structured data block, which is data,
  // not code. Any other script would mean content a crawler that does not run
  // JavaScript cannot read.
  const scripts = [...html.matchAll(/<script([^>]*)>/g)].map((m) => m[1]);
  for (const attrs of scripts) {
    assert.match(attrs, /type="application\/ld\+json"/, `the page runs a script: <script${attrs}>`);
  }
  assert.ok(!/<script[^>]*\ssrc=/.test(html), "the page loads a script from a URL");

  // No stylesheet, font, or image is fetched from a third party. The only
  // absolute URLs allowed are the site itself and links to the repository.
  const allowedHosts = new Set([SITE_HOST, "github.com"]);
  for (const match of html.matchAll(/(?:href|src)="(https?:\/\/[^"]+)"/g)) {
    const host = new URL(match[1]).host;
    assert.ok(allowedHosts.has(host), `the page fetches or links ${host}`);
  }
  for (const banned of ["fonts.googleapis.com", "fonts.gstatic.com", "cdn.", "googletagmanager"]) {
    assert.ok(!html.includes(banned), `the page references ${banned}`);
  }
  // The catalog is in the HTML source, not fetched later.
  assert.ok(html.includes("<h4><code>filesystem-allowlist</code></h4>"));
});

test("the build writes the files GitHub Pages needs", () => {
  for (const name of ["index.html", "robots.txt", "sitemap.xml", ".nojekyll", "social-card.svg"]) {
    assert.ok(existsSync(join(outDir, "dist", name)), `the build never wrote ${name}`);
  }
});

// --- the generator refusing to run ---------------------------------------------

// The page is only worth trusting if the generator stops when its inputs are
// wrong. A build that reads a broken record and prints a page anyway is the
// same failure as a gate that cannot run and reports success.
function scratchProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "adg-site-fail-"));
  mkdirSync(join(dir, "site"), { recursive: true });
  cpSync(join(ROOT, "site", "build.js"), join(dir, "site", "build.js"));
  cpSync(join(ROOT, "site", "static"), join(dir, "site", "static"), { recursive: true });
  cpSync(join(ROOT, "rules"), join(dir, "rules"), { recursive: true });
  mkdirSync(join(dir, "docs"), { recursive: true });
  cpSync(join(ROOT, "docs", "gate-tally.md"), join(dir, "docs", "gate-tally.md"));
  cpSync(join(ROOT, "docs", "examples"), join(dir, "docs", "examples"), { recursive: true });
  // The generator reads the command list out of the command line entry point,
  // so a scratch project without it is not a project the generator can build.
  cpSync(join(ROOT, "bin"), join(dir, "bin"), { recursive: true });
  return dir;
}

test("the generator refuses a tally that names a rule with no record", () => {
  const dir = scratchProject();
  try {
    const path = join(dir, "docs", "gate-tally.md");
    const text = readFileSync(path, "utf8");
    writeFileSync(path, text + "| 999 | 2026-09-08 | no-such-rule | none | invented |\n");
    const result = runBuild(join(dir, "site", "build.js"), join(dir, "dist"));
    assert.equal(result.status, 2, "the build accepted a tally row for a rule that does not exist");
    assert.match(result.stderr, /no-such-rule/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the generator refuses a rule record it cannot read", () => {
  const dir = scratchProject();
  try {
    writeFileSync(join(dir, "rules", "red-before-green.json"), "{ not json");
    const result = runBuild(join(dir, "site", "build.js"), join(dir, "dist"));
    assert.equal(result.status, 2, "the build accepted a rule record that does not parse");
    assert.ok(!existsSync(join(dir, "dist", "index.html")), "a page was written anyway");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the generator refuses a rule record whose enforcement it has no group for", () => {
  const dir = scratchProject();
  try {
    const path = join(dir, "rules", "red-before-green.json");
    const record = JSON.parse(readFileSync(path, "utf8"));
    record.enforcement = "wishful-thinking";
    writeFileSync(path, JSON.stringify(record, null, 2));
    const result = runBuild(join(dir, "site", "build.js"), join(dir, "dist"));
    assert.equal(result.status, 2, "the build silently dropped a rule it had no group for");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the workflow ---------------------------------------------------------------

test("the site is published only over a green run of the gates", () => {
  assert.ok(existsSync(WORKFLOW), ".github/workflows/pages.yml does not exist");
  const yml = readFileSync(WORKFLOW, "utf8");

  // `needs` reaches jobs in the same workflow only, so the gates job it waits
  // on has to be in this file, and it has to run the checks.
  assert.match(yml, /^\s{2}gates:$/m, "the pages workflow has no gates job");
  assert.match(yml, /^\s{4}needs: gates$/m, "no job in the pages workflow waits on the gates");
  for (const step of ["tsc --noEmit", "npm test", "scan-prose.sh --require-rules", "tally-report.ts --check"]) {
    assert.ok(yml.includes(step), `the pages workflow's gates job does not run ${step}`);
  }

  // Only from main. Both the trigger and the job conditions say so, because a
  // manual run can start from any branch.
  assert.match(yml, /branches: \[main\]/, "the workflow does not restrict its push trigger to main");
  const buildIf = /^\s{4}if: github\.ref == 'refs\/heads\/main'$/gm;
  assert.equal(
    (yml.match(buildIf) ?? []).length,
    2,
    "the build and deploy jobs do not both check that this is main",
  );

  // The official Pages flow, with the permissions the token exchange needs.
  for (const action of [
    "actions/configure-pages@v",
    "actions/upload-pages-artifact@v",
    "actions/deploy-pages@v",
  ]) {
    assert.ok(yml.includes(action), `the workflow does not use ${action}`);
  }
  assert.match(yml, /pages: write/, "the workflow cannot write a Pages deployment");
  assert.match(yml, /id-token: write/, "the workflow cannot mint the deployment token");
  assert.match(yml, /name: github-pages/, "the deploy job uses no github-pages environment");
  assert.ok(yml.includes("node site/build.js"), "the workflow never generates the site");

  // Every action is pinned to a version tag or to a full commit SHA. A
  // reference like @main or @master is whatever that branch holds on the day
  // it runs, which is not a pinned action; an @ on its own proves nothing,
  // which is what this assertion used to check.
  for (const use of [...yml.matchAll(/uses: (\S+)/g)].map((m) => m[1])) {
    assert.match(
      use,
      /@(v\d+(\.\d+)*|[0-9a-f]{40})$/,
      `the workflow uses ${use}, which is not pinned to a version tag or a commit SHA`,
    );
  }
});

// --- the package -----------------------------------------------------------------

test("the site stays out of the published package and out of the typecheck", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const files: string[] = pkg.files;
  for (const entry of files) {
    assert.ok(
      !entry.startsWith("site"),
      `the package files allowlist ships "${entry}", and the site is not part of the package`,
    );
  }
  // The site has its own package with no dependencies, and the root package
  // has none either. Nothing on the page may add one.
  const sitePkg = JSON.parse(readFileSync(join(ROOT, "site", "package.json"), "utf8"));
  assert.equal(sitePkg.dependencies, undefined, "the site package took on a dependency");
  assert.equal(sitePkg.devDependencies, undefined, "the site package took on a dev dependency");
  assert.equal(sitePkg.private, true, "the site package is not marked private");
  assert.equal(pkg.dependencies, undefined, "the root package took on a runtime dependency");

  // The root typecheck lists the directories it reads, so site code cannot
  // break it. Keeping that true is the point of the assertion.
  const tsconfig = JSON.parse(
    readFileSync(join(ROOT, "tsconfig.json"), "utf8").replace(/^\s*\/\/.*$/gm, ""),
  );
  const include: string[] = tsconfig.include;
  assert.ok(Array.isArray(include) && include.length > 0, "the root tsconfig has no include list");
  for (const entry of include) {
    assert.ok(!entry.startsWith("site"), `the root typecheck reads ${entry}`);
  }
  // And the generator is JavaScript, so there is nothing there to typecheck.
  assert.ok(existsSync(BUILD), "site/build.js does not exist");
  assert.ok(
    !readdirSync(join(ROOT, "site")).some((name) => name.endsWith(".ts")),
    "the site directory holds TypeScript the root typecheck does not cover",
  );
});

// The custom domain lives in one constant in the generator, and GitHub Pages
// drops a custom domain on any deploy whose output carries no CNAME file. A
// build that quietly loses either would serve the site from somewhere else,
// so both are pinned here.
test("every URL that names this site uses the custom domain", () => {
  // Outbound links to GitHub, schema.org and the licence are not this site.
  // What must never appear is the github.io host the site used to be built
  // for: one left behind would point a canonical or a sitemap entry at a
  // second copy of the page and split it in two for a crawler.
  assert.doesNotMatch(html, /github\.io/, "the page still names the github.io host");
  assert.doesNotMatch(sitemap, /github\.io/, "the sitemap still names the github.io host");
  assert.doesNotMatch(robots, /github\.io/, "robots.txt still names the github.io host");

  const canonical = html.match(/<link rel="canonical" href="([^"]+)">/);
  const ogUrl = html.match(/<meta property="og:url" content="([^"]+)">/);
  const loc = sitemap.match(/<loc>([^<]+)<\/loc>/);
  const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1]);
  const software = ld["@graph"].find((n: { "@type": string }) => n["@type"] === "SoftwareSourceCode");
  for (const [what, value] of [
    ["canonical", canonical?.[1]],
    ["og:url", ogUrl?.[1]],
    ["sitemap loc", loc?.[1]],
    ["JSON-LD url", software.url],
  ] as Array<[string, string | undefined]>) {
    assert.equal(value, SITE_URL, `${what} does not use the custom domain`);
  }
});

test("the build writes a CNAME holding exactly the custom domain", () => {
  const cname = readFileSync(join(outDir, "dist", "CNAME"), "utf8");
  assert.equal(cname.trim(), SITE_HOST);
  assert.equal(cname.split("\n").filter((l) => l.trim() !== "").length, 1);
});

// --- the workflow, checked against what the build actually does ----------------

/** One top-level job block out of the workflow file, by name. */
function jobBlock(yml: string, name: string): string {
  const lines = yml.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.ok(start >= 0, `the pages workflow has no ${name} job`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

// A dependency between two jobs is the only thing making the gates run before
// the site is published, and `needs: gates` appearing somewhere in the file
// says nothing about which job carries it. Pointing deploy straight at the
// gates would publish whatever the last deploy left behind, over a build that
// never ran, and read as a passing workflow.
test("the workflow's job order is gates, then build, then deploy", () => {
  const yml = readFileSync(WORKFLOW, "utf8");
  const gates = jobBlock(yml, "gates");
  const build = jobBlock(yml, "build");
  const deploy = jobBlock(yml, "deploy");

  assert.doesNotMatch(gates, /^ {4}needs:/m, "the gates job waits on something");
  assert.match(build, /^ {4}needs: gates$/m, "the build job does not wait on the gates");
  assert.match(deploy, /^ {4}needs: build$/m, "the deploy job does not wait on the build");
  assert.doesNotMatch(
    deploy,
    /^ {4}needs: gates$/m,
    "the deploy job skips the build and waits on the gates",
  );
});

// The upload step names a directory by hand. Naming one the build never wrote
// uploads an empty artifact and deploys an empty site, with every job green.
test("the artifact uploaded is the directory the build writes", () => {
  const build = jobBlock(readFileSync(WORKFLOW, "utf8"), "build");
  const out = /node site\/build\.js --out (\S+)/.exec(build);
  assert.ok(out, "the build job does not generate the site");
  const uploaded = /uses: actions\/upload-pages-artifact@v\d+\n\s+with:\n\s+path: (\S+)/.exec(build);
  assert.ok(uploaded, "the build job uploads no Pages artifact");
  assert.equal(
    uploaded[1],
    out[1],
    `the build writes ${out[1]} and the upload step publishes ${uploaded[1]}`,
  );
});

// The gates job runs `npm ci`, which runs whatever lifecycle scripts the
// lockfile carries. It has no business holding a token that can publish, so
// the two write scopes belong to the deploy job and nowhere else.
test("only the deploy job holds the Pages write scopes", () => {
  const yml = readFileSync(WORKFLOW, "utf8");
  const header = yml.slice(0, yml.indexOf("\njobs:"));
  assert.match(header, /^permissions:\n  contents: read\n/m, "the workflow default is not read-only");
  assert.doesNotMatch(header, /^\s+pages: write$/m, "pages: write is a workflow-wide default");
  assert.doesNotMatch(header, /^\s+id-token: write$/m, "id-token: write is a workflow-wide default");

  for (const name of ["gates", "build"]) {
    const block = jobBlock(yml, name);
    assert.doesNotMatch(block, /pages: write/, `the ${name} job can write a Pages deployment`);
    assert.doesNotMatch(block, /id-token: write/, `the ${name} job can mint a deployment token`);
  }
  const deploy = jobBlock(yml, "deploy");
  assert.match(deploy, /^ {6}pages: write$/m, "the deploy job cannot write a Pages deployment");
  assert.match(deploy, /^ {6}id-token: write$/m, "the deploy job cannot mint the deployment token");
});

// --- what the page says about the tool ------------------------------------------

/** The subcommands `bin/adg.ts` dispatches, minus the internal entry points. */
function userFacingSubcommands(): string[] {
  const cli = readFileSync(join(ROOT, "bin", "adg.ts"), "utf8");
  const internal = new Set([
    "hook-clean-tree",
    "hook-path-confinement",
    "hook-test-diff",
    "hook-report",
    "cursor-hook",
    "copilot-hook",
  ]);
  const names = [...cli.matchAll(/^\s*case "([a-z][a-z0-9-]*)":/gm)].map((m) => m[1]);
  assert.ok(names.includes("init"), "no subcommands were read out of bin/adg.ts");
  return [...new Set(names)].filter((name) => !internal.has(name));
}

// The page carried two command names for as long as the tool had two. It kept
// carrying them after the tool had ten, because they were typed into the
// template and nothing read the tool.
test("the page names every user-facing subcommand the tool dispatches", () => {
  const tokens = new Set(codeTokens(html).flatMap((token) => token.split(/\s+/)));
  for (const name of userFacingSubcommands()) {
    assert.ok(tokens.has(name), `the page never names the "${name}" command`);
  }
});

// Each rule links at rules/<id>.json. The generator refuses a record whose id
// disagrees with its file name, and that refusal is the only thing keeping
// these links off a 404.
test("every rule record the page links to exists on disk", () => {
  const linked = [...html.matchAll(/blob\/main\/rules\/([^"]+)/g)].map((m) => m[1]);
  assert.ok(linked.length > 0, "the page links no rule record");
  for (const file of linked) {
    assert.ok(existsSync(join(ROOT, "rules", file)), `the page links rules/${file}, which is absent`);
  }
  assert.deepEqual(
    [...new Set(linked)].sort(),
    readRules()
      .map((rule) => `${rule.id}.json`)
      .sort(),
    "the page links a different set of rule records than rules/ holds",
  );
});

// --- escaping --------------------------------------------------------------------

// Record text reaches the page in two kinds of place: between tags, and inside
// an attribute value. Nothing in this repository's records holds markup today,
// so nothing would have noticed the escaping being dropped altogether. This
// pins the behavior that is already correct.
test("record text with markup in it reaches the page escaped", () => {
  const dir = scratchProject();
  try {
    const path = join(dir, "rules", "coverage-as-gap-finder.json");
    const record = JSON.parse(readFileSync(path, "utf8"));
    record.name = `<script>alert(1)</script> & "quoted" 'single'`;
    record.claim_class = `</script> ends a block <b>early</b>`;
    record.severity = `medium" onmouseover="alert(1)`;
    writeFileSync(path, JSON.stringify(record, null, 2));

    const result = runBuild(join(dir, "site", "build.js"), join(dir, "dist"));
    assert.equal(result.status, 0, `the build failed: ${result.stderr}`);
    const page = readFileSync(join(dir, "dist", "index.html"), "utf8");

    for (const raw of [
      "<script>alert(1)</script>",
      `"quoted"`,
      `'single'`,
      "<b>early</b>",
      `medium" onmouseover=`,
    ]) {
      assert.ok(!page.includes(raw), `the page carries ${raw} unescaped`);
    }
    for (const escaped of [
      "&lt;script&gt;alert(1)&lt;/script&gt;",
      "&amp; &quot;quoted&quot; &#39;single&#39;",
      "&lt;/script&gt; ends a block &lt;b&gt;early&lt;/b&gt;",
      `sev-medium&quot; onmouseover=&quot;alert(1)`,
    ]) {
      assert.ok(page.includes(escaped), `the page does not carry ${escaped}`);
    }

    // And the page still has exactly one script element, the data block.
    const scripts = [...page.matchAll(/<script([^>]*)>/g)].map((m) => m[1]);
    assert.equal(scripts.length, 1, "record text opened a second script element");
    assert.match(scripts[0], /type="application\/ld\+json"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// JSON.stringify leaves "<" alone, so a "</script>" inside any string in the
// structured data block would end the block early for an HTML parser while the
// JSON stayed valid. Nothing record-derived reaches that block today. This
// plants the payload in a value that does reach it.
test("a closing script tag inside the JSON-LD block cannot end it", () => {
  const dir = scratchProject();
  try {
    const buildPath = join(dir, "site", "build.js");
    const source = readFileSync(buildPath, "utf8");
    const payload = `Ev</script><script>alert(1)</script>an`;
    const patched = source.replace(
      /const AUTHOR = "[^"]*";/,
      `const AUTHOR = ${JSON.stringify(payload)};`,
    );
    assert.notEqual(patched, source, "the author constant could not be replaced");
    writeFileSync(buildPath, patched);

    const result = runBuild(buildPath, join(dir, "dist"));
    assert.equal(result.status, 0, `the build failed: ${result.stderr}`);
    const page = readFileSync(join(dir, "dist", "index.html"), "utf8");

    const open = `<script type="application/ld+json">`;
    const start = page.indexOf(open);
    assert.ok(start >= 0, "the page carries no JSON-LD block");
    // An HTML parser ends the element at the first "</script>" in the source,
    // so that is where this reads it too.
    const end = page.indexOf("</script>", start);
    const body = page.slice(start + open.length, end);
    assert.ok(!body.includes("</script>"), "the payload closed the data block early");

    const data = JSON.parse(body);
    const software = data["@graph"].find(
      (n: { "@type": string }) => n["@type"] === "SoftwareSourceCode",
    );
    assert.equal(software.author.name, payload, "the block lost the value it was given");
    assert.equal(
      [...page.matchAll(/<script[^>]*>/g)].length,
      1,
      "the payload opened a second script element",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the tally table, read the way GitHub reads it -------------------------------

// GitHub renders "\|" inside a cell as a literal pipe. Splitting on every pipe
// reads such a row as having an extra column and stops the build on a file
// that displays correctly.
test("a tally cell may hold an escaped pipe", () => {
  const dir = scratchProject();
  try {
    const path = join(dir, "docs", "gate-tally.md");
    const text = readFileSync(path, "utf8");
    // The next row number and the total come from the file, never typed in.
    // An earlier version of this test hardcoded both and started failing the
    // day the tally grew past them.
    const numbers = [...text.matchAll(/^\| *(\d+) *\|/gm)].map((m) => Number(m[1]));
    const next = Math.max(...numbers) + 1;
    writeFileSync(
      path,
      text +
        `| ${next} | 2026-09-09 | red-before-green | no test; recorded here only |` +
        " A cell holding a literal \\| pipe, which GitHub renders as one. |\n",
    );
    const result = runBuild(join(dir, "site", "build.js"), join(dir, "dist"));
    assert.equal(result.status, 0, `the build rejected an escaped pipe: ${result.stderr}`);
    const page = readFileSync(join(dir, "dist", "index.html"), "utf8");
    assert.ok(
      page.includes(`${numbers.length + 1} entries`),
      "the build did not count the row with the escaped pipe",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A blank line, an inserted paragraph, or a second table used to end the count
// where it appeared. The build exited 0 and the page published a smaller
// number as though it were the record.
test("the generator refuses a tally table with a gap in it", () => {
  const dir = scratchProject();
  try {
    const path = join(dir, "docs", "gate-tally.md");
    const lines = readFileSync(path, "utf8").split("\n");
    const rows = lines
      .map((line, i) => [line, i] as [string, number])
      .filter(([line]) => /^\| *\d+ *\|/.test(line));
    assert.ok(rows.length > 4, "the tally has too few rows for this test");
    const at = rows[2][1];
    writeFileSync(path, [...lines.slice(0, at), "", ...lines.slice(at)].join("\n"));

    const result = runBuild(join(dir, "site", "build.js"), join(dir, "dist"));
    assert.equal(result.status, 2, "the build published a truncated tally as the whole record");
    assert.match(result.stderr, /never reached/);
    assert.ok(!existsSync(join(dir, "dist", "index.html")), "a page was written anyway");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const NUMBER_WORDS_FOR_TEST = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
  "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
];
function words(count: number): string {
  return count < NUMBER_WORDS_FOR_TEST.length ? NUMBER_WORDS_FOR_TEST[count] : String(count);
}

// --- facts the page states in prose, held to the records ----------------------
//
// A mutation sweep over site/build.js left 22 of 51 mutations alive. Four were
// real: the field check on a rule record, the separator-row test, and the two
// counts the FAQ states in words. Nothing asserted any of them, so the page
// could name the wrong number of hook-enforced rules and every test would
// pass. These read the counts from the records by a route the generator does
// not use, so agreeing with the generator is not enough to pass.

test("the FAQ states the hook-enforced count the records hold", () => {
  const rules = readRules();
  const hookCount = rules.filter((r) => r.enforcement === "hook").length;
  const enforcement = rules;
  assert.ok(hookCount > 0 && hookCount < enforcement.length, "the fixture makes this test vacuous");
  const sentence = `${words(hookCount)} of the ${words(enforcement.length)} are enforced by a hook`;
  assert.ok(
    html.toLowerCase().includes(sentence),
    `the page does not say "${sentence}"`,
  );
});

test("the FAQ states the number of rules sitting at zero", () => {
  const ids = readRules().map((r) => r.id);
  const tally = readTally(ids);
  const zeroed = ids.filter((id) => (tally.counts.get(id) ?? 0) === 0).length;
  assert.ok(
    html.includes(`${words(zeroed).replace(/^./, (c) => c.toUpperCase())} of the rules sit at zero`),
    `the page does not say ${words(zeroed)} rules sit at zero`,
  );
});

test("a rule record missing a required field stops the build", () => {
  for (const field of ["name", "claim_class", "severity", "enforcement"]) {
    const dir = scratchProject();
    try {
      const path = join(dir, "rules", "red-before-green.json");
      const record = JSON.parse(readFileSync(path, "utf8"));
      delete record[field];
      writeFileSync(path, JSON.stringify(record, null, 2));
      const result = runBuild(join(dir, "site", "build.js"), join(dir, "dist"));
      assert.equal(result.status, 2, `a record with no "${field}" built anyway`);
      assert.match(result.stderr, new RegExp(`no usable "${field}"`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("a table whose separator row is not dashes is not read as a table", () => {
  const dir = scratchProject();
  try {
    const path = join(dir, "docs", "gate-tally.md");
    const text = readFileSync(path, "utf8");
    writeFileSync(path, text.replace(/^\|[ :|-]+\|$/m, "| x | x | x | x | x |"));
    const result = runBuild(join(dir, "site", "build.js"), join(dir, "dist"));
    assert.equal(result.status, 2, "a table with no separator row was read as one");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
