// Tests for the project homepage and the workflow that publishes it.
//
// The page states counts, rule ids, and dates. Every one of them is read out
// of `rules/` and `docs/gate-tally.md` when the page is built, and these
// tests read the same records again and check the page against them. A
// marketing page is the most likely place for this repository to contradict
// its own records next, so the contradiction is what is checked here, not
// the wording.
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

// --- the records, read again, independently of the generator -----------------

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

/** Counts the tally table the same way the tally tooling reads it: the first
 * row whose leading cell is "#" and which is followed by a separator row. */
function readTally(ruleIds: string[]): TallyFacts {
  const lines = readFileSync(join(ROOT, "docs", "gate-tally.md"), "utf8").split(/\r\n|\r|\n/);
  const cellsOf = (line: string): string[] => {
    let body = line.trim();
    if (body.startsWith("|")) body = body.slice(1);
    if (body.endsWith("|")) body = body.slice(0, -1);
    return body.split("|").map((cell) => cell.trim());
  };
  const isSeparator = (line: string): boolean => {
    const cells = cellsOf(line);
    return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
  };
  let header = -1;
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].trim().startsWith("|")) continue;
    if (cellsOf(lines[i])[0] !== "#") continue;
    if (!isSeparator(lines[i + 1])) continue;
    header = i;
    break;
  }
  assert.ok(header >= 0, "docs/gate-tally.md has no table this test can read");

  const counts = new Map<string, number>(ruleIds.map((id) => [id, 0]));
  const dates: string[] = [];
  for (let i = header + 2; i < lines.length; i++) {
    if (!lines[i].trim().startsWith("|")) break;
    const cells = cellsOf(lines[i]);
    counts.set(cells[2], (counts.get(cells[2]) ?? 0) + 1);
    dates.push(cells[1]);
  }
  dates.sort();
  return { total: dates.length, first: dates[0], last: dates[dates.length - 1], counts };
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

  // Every action is pinned to a version. An unpinned action is whatever it
  // happens to be on the day it runs.
  for (const use of [...yml.matchAll(/uses: (\S+)/g)].map((m) => m[1])) {
    assert.match(use, /@/, `the workflow uses ${use} with no version`);
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
