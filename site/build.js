#!/usr/bin/env node
// Builds the project homepage from the records in this repository.
//
// Every number, id, and name on the page comes from `rules/*.json`,
// `docs/gate-tally.md`, and `docs/examples/*.md`, read at build time.
// Nothing factual is typed into the template, because a page that repeats
// a count by hand goes stale the moment the count moves, and this
// repository has already caught its own catalog contradicting its own code
// more than once.
//
// Plain JavaScript on purpose: no dependency, and no TypeScript file that
// the root typecheck would have to know about. The root tsconfig lists its
// own directories explicitly and this one is not among them.
//
// Usage:
//   node build.js [--out PATH]
//
// Exit codes:
//   0  the site was written
//   2  the build could not run as asked: a missing input, an unreadable
//      file, or a tally table that would not parse
//
// Exit 2 matters here for the same reason it matters in the gates: a build
// that could not read its inputs must never look like a build that read
// them and found nothing to say.

import { readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

// The site is served from its own domain, not from the github.io path.
// Every absolute URL on the page, in the sitemap and in the robots file is
// built from this one constant, and CNAME below carries the same hostname.
// GitHub Pages drops a custom domain on any deploy whose output has no
// CNAME file, so the file is written on every build, never checked in once
// and forgotten.
const SITE_URL = "https://agentgates.dev/";
const SITE_HOST = new URL(SITE_URL).hostname;
const REPO_URL = "https://github.com/emiquelito/agent-delivery-gates";
const BLOB_URL = REPO_URL + "/blob/main/";
const AUTHOR = "Evandro Miquelito";
const PACKAGE_NAME = "agent-delivery-gates";
const SOCIAL_IMAGE = "social-card.svg";

const TAGLINE =
  "Delivery gates for AI coding agents, because green tests are not proof.";
// The same sentences the repository and the published package carry, so a
// reader arriving from either one lands on words they have already read.
const HEADLINE = [
  "Breaks your code on purpose and reports the breaks no test noticed.",
  "Runs a change's new tests against the code from before it.",
  "Induces the failure your report says is handled.",
  "Git hook, CI step or MCP server. No API key, zero dependencies.",
];
const DESCRIPTION =
  "Proof obligations for an AI coding agent's delivery report. A green test run and a green run over" +
  " checks that cannot fail look the same from outside, and only one of them means anything." +
  " Runs as a git hook, in CI, or as a local MCP server, with no runtime dependencies.";

// GitHub's own mark, inline because this page fetches nothing from another
// host. A logo on a button that goes to GitHub is a signpost and not
// decoration, which is why this is the one piece of artwork here.
const GITHUB_MARK =
  '<svg class="ghmark" viewBox="0 0 16 16" width="20" height="20" aria-hidden="true" focusable="false">' +
  '<path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38' +
  ' 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53' +
  '.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95' +
  ' 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27' +
  '1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95' +
  '.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/>' +
  "</svg>";

function fail(message) {
  process.stderr.write(`site build: ${message}\n`);
  process.exit(2);
}

function readFile(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return fail(`could not read ${path}: ${detail}`);
  }
}

// --- inputs ------------------------------------------------------------------

/** Every rule record, minus the schema, sorted by id. */
function readRules() {
  const dir = join(ROOT, "rules");
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return fail(`could not list ${dir}: ${detail}`);
  }
  const rules = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json") || name === "schema.json") continue;
    const path = join(dir, name);
    let record;
    try {
      record = JSON.parse(readFile(path));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return fail(`could not parse ${path}: ${detail}`);
    }
    for (const field of ["id", "name", "claim_class", "severity", "enforcement"]) {
      if (typeof record[field] !== "string" || record[field] === "") {
        return fail(`${path} has no usable "${field}" field`);
      }
    }
    if (record.id !== name.replace(/\.json$/, "")) {
      return fail(`${path} declares id "${record.id}", which does not match its file name`);
    }
    rules.push(record);
  }
  if (rules.length === 0) fail(`no rule records found in ${dir}`);
  return rules;
}

/**
 * One markdown table row split into trimmed cells.
 *
 * A cell may hold a pipe of its own if it is written `\|`, which is what
 * GitHub renders as a literal pipe inside a cell. Splitting on every pipe
 * would read that one row as having an extra column and stop the build on a
 * file GitHub displays correctly, so the split skips an escaped pipe and the
 * cell keeps the pipe without its backslash.
 */
function splitRow(line) {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);
  return body.split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll("\\|", "|"));
}

function isSeparatorRow(line) {
  const cells = splitRow(line);
  // The length guard cannot fire today: String.split always returns at least
  // one element, so splitRow never gives back an empty array. It is kept
  // because every() on an empty array is true, and a future splitRow that
  // could return one would read any line as a separator. A mutation sweep
  // found this guard unreachable, which is a mutation that survives without
  // naming a gap.
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

/**
 * Reads the tally table: how many rejections were logged, over what dates,
 * and how many per rule. The header row is found the same way the tally
 * tooling finds it, by a first cell of "#" followed by a separator row, so
 * the prose above the table is never mistaken for data.
 *
 * Counting stops at the first line that is not a table row, which is right
 * for a table that ends, and silently wrong for a table with a gap in it: a
 * blank line, a paragraph, or a second table would end the count early and
 * publish a smaller number as though it were the record. So every row
 * anywhere in the file whose first cell is a number is collected first, and
 * a row that the count did not reach stops the build.
 */
function readTally(ruleIds) {
  const path = join(ROOT, "docs", "gate-tally.md");
  const lines = readFile(path).split(/\r\n|\r|\n/);
  let headerIndex = -1;
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].trim().startsWith("|")) continue;
    if (splitRow(lines[i])[0] !== "#") continue;
    if (!isSeparatorRow(lines[i + 1])) continue;
    headerIndex = i;
    break;
  }
  if (headerIndex < 0) fail(`no tally table found in ${path}`);

  // Every numbered row in the file, wherever it sits.
  const numbered = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith("|")) continue;
    if (/^\d+$/.test(splitRow(lines[i])[0])) numbered.add(i);
  }

  const counts = new Map(ruleIds.map((id) => [id, 0]));
  const dates = [];
  const counted = new Set();
  let total = 0;
  for (let i = headerIndex + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith("|")) break;
    const cells = splitRow(line);
    if (cells.length !== 5) fail(`${path} line ${i + 1} has ${cells.length} columns, expected 5`);
    const [, date, rule] = cells;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`${path} line ${i + 1} has no usable date`);
    if (!counts.has(rule)) fail(`${path} line ${i + 1} names rule "${rule}", which has no record`);
    counts.set(rule, counts.get(rule) + 1);
    dates.push(date);
    counted.add(i);
    total += 1;
  }
  const missed = [...numbered].filter((i) => !counted.has(i));
  if (missed.length > 0) {
    fail(
      `${path} has ${missed.length} numbered row(s) the count never reached, first at line ` +
        `${missed[0] + 1}: the table is broken in two and the total would be wrong`,
    );
  }
  if (total === 0) fail(`${path} holds a table with no entries`);
  dates.sort();
  return { total, first: dates[0], last: dates[dates.length - 1], counts };
}

/** The worked examples, by file name order, titled from their own headings. */
function readExamples() {
  const dir = join(ROOT, "docs", "examples");
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return fail(`could not list ${dir}: ${detail}`);
  }
  const examples = [];
  for (const name of names.sort()) {
    if (!/^\d+-.*\.md$/.test(name)) continue;
    const text = readFile(join(dir, name));
    const heading = text.split(/\r\n|\r|\n/).find((line) => line.startsWith("# "));
    if (heading === undefined) fail(`docs/examples/${name} has no top-level heading to title it`);
    examples.push({ file: `docs/examples/${name}`, title: heading.slice(2).trim() });
  }
  if (examples.length === 0) fail(`no worked examples found in ${dir}`);
  return examples;
}

// The entry points `bin/adg.ts` dispatches that no person ever types. Each
// one is invoked by an agent runtime or by a git hook, through the config
// files `init` writes, and reads a payload on stdin. Listing them as commands
// would tell a reader to run something that does nothing useful by hand, so
// the page names the user-facing subcommands only.
const INTERNAL_SUBCOMMANDS = new Set([
  "hook-clean-tree",
  "hook-path-confinement",
  "hook-test-diff",
  "hook-report",
  "cursor-hook",
  "copilot-hook",
]);

// `init` sets a project up and `mcp` starts the server; both are described in
// their own words on the page, so the sentence listing the checks leaves them
// out. They stay in the user-facing list all the same.
const SETUP_SUBCOMMANDS = new Set(["init", "mcp"]);

/**
 * The subcommands the command line entry point dispatches, read out of the
 * source instead of typed here. A command list typed into a page is a count
 * by hand under another name: this page carried two commands for weeks after
 * the tool had eight.
 */
function readSubcommands() {
  const path = join(ROOT, "bin", "adg.ts");
  const source = readFile(path);
  const names = [];
  for (const match of source.matchAll(/^\s*case "([a-z][a-z0-9-]*)":/gm)) {
    if (!names.includes(match[1])) names.push(match[1]);
  }
  if (!names.includes("init")) fail(`no subcommands could be read out of ${path}`);
  const userFacing = names.filter((name) => !INTERNAL_SUBCOMMANDS.has(name));
  const checks = userFacing.filter((name) => !SETUP_SUBCOMMANDS.has(name));
  if (checks.length === 0) fail(`${path} dispatches no user-facing check command`);
  return { userFacing, checks };
}

// --- rendering ---------------------------------------------------------------

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeXml(text) {
  return String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** English for a small count, so a sentence reads as a sentence. */
const NUMBER_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
  "nineteen", "twenty",
];

function words(count) {
  return count < NUMBER_WORDS.length ? NUMBER_WORDS[count] : String(count);
}

const ENFORCEMENT_GROUPS = [
  {
    key: "hook",
    heading: "Enforced by a hook",
    blurb: "Checked mechanically on a relevant tool call or on every commit.",
  },
  {
    key: "prompt",
    heading: "Carried by prompt instructions",
    blurb:
      "No mechanical check today. These depend on the agent following the instruction and on a" +
      " person reading the report afterward.",
  },
  {
    key: "human_gate",
    heading: "Needs a human gate",
    blurb: "No script can confirm these from the outside. They can be arranged for and then checked.",
  },
];

function ruleRow(rule, count) {
  const emits = Array.isArray(rule.emits) ? rule.emits : [];
  const emitted =
    emits.length > 0
      ? `<p class="emits">Emits ${emits.map((id) => `<code>${escapeHtml(id)}</code>`).join(", ")}</p>`
      : "";
  return `        <li>
          <h4><code>${escapeHtml(rule.id)}</code></h4>
          <p class="rule-name">${escapeHtml(rule.name)}</p>
          <p>${escapeHtml(rule.claim_class)}</p>
          <p class="meta"><span class="tag sev-${escapeHtml(rule.severity)}">severity: ${escapeHtml(rule.severity)}</span>
            <span class="tag">tally entries: ${count}</span>
            <a href="${BLOB_URL}rules/${escapeHtml(rule.id)}.json">the <code>${escapeHtml(rule.id)}</code> record</a></p>
          ${emitted}
        </li>`;
}

function renderCatalog(rules, tally) {
  const sections = [];
  for (const group of ENFORCEMENT_GROUPS) {
    const members = rules.filter((rule) => rule.enforcement === group.key);
    if (members.length === 0) continue;
    const items = members.map((rule) => ruleRow(rule, tally.counts.get(rule.id))).join("\n");
    sections.push(`      <h3>${escapeHtml(group.heading)} (${members.length})</h3>
      <p>${escapeHtml(group.blurb)}</p>
      <ul class="rules">
${items}
      </ul>`);
  }
  const other = rules.filter((rule) => !ENFORCEMENT_GROUPS.some((g) => g.key === rule.enforcement));
  if (other.length > 0) {
    fail(`rule records use an enforcement value this page has no group for: ${other.map((r) => r.enforcement).join(", ")}`);
  }
  return sections.join("\n\n");
}

function renderTallyTable(rules, tally) {
  const ordered = [...rules].sort((a, b) => {
    const diff = tally.counts.get(b.id) - tally.counts.get(a.id);
    return diff !== 0 ? diff : a.id.localeCompare(b.id);
  });
  const rows = ordered
    .map(
      (rule) =>
        `          <tr><th scope="row"><code>${escapeHtml(rule.id)}</code></th><td>${tally.counts.get(rule.id)}</td></tr>`,
    )
    .join("\n");
  return `      <table>
        <caption>Gate rejections logged per rule, from <code>docs/gate-tally.md</code></caption>
        <thead>
          <tr><th scope="col">Rule</th><th scope="col">Entries</th></tr>
        </thead>
        <tbody>
${rows}
        </tbody>
      </table>`;
}

// The questions here are answered on the page itself, in the same words, and
// each one has been asked about this project. None was invented to fill out
// the structured data block.
function faqEntries(rules, tally) {
  const hookCount = rules.filter((rule) => rule.enforcement === "hook").length;
  const zeroed = rules.filter((rule) => tally.counts.get(rule.id) === 0).length;
  return [
    {
      q: "Does this need an AI agent to run?",
      a:
        "No. The command line tools are ordinary programs with exit codes. The same checks run from a" +
        " git pre-commit hook, from CI, or by hand, with no agent involved.",
    },
    {
      q: "Does anything leave the machine?",
      a:
        "No. The MCP server is a local subprocess on stdio, not a hosted service. Nothing about a" +
        " project's code or reports leaves the machine, and there is no analytics or telemetry.",
    },
    {
      q: `How many of the ${words(rules.length)} rules are checked mechanically?`,
      a:
        `${words(hookCount).replace(/^./, (c) => c.toUpperCase())} of the ${words(rules.length)} are enforced by a hook that runs on a tool call or a commit.` +
        " Two commands go further than that grouping suggests: census runs a change's new tests" +
        " against the code from before the change, which is the mechanical half of red-before-green," +
        " and induce runs a declared failure with the handling in place and again with it taken" +
        " away, which is what induced-failure-required asks for. The rest are carried by prompt" +
        " instructions or need a person, and the catalog says which is which.",
    },
    {
      q: "What does a rule with zero tally entries mean?",
      a:
        `A zero does not mean a rule was unnecessary. ${words(zeroed).replace(/^./, (c) => c.toUpperCase())} of the rules sit at zero. It means the work stayed clean` +
        " on that rule for the life of this build, or nothing looked closely enough to catch anything" +
        " on it yet, and the count alone cannot tell you which.",
    },
  ];
}

/**
 * The three questions, one per command, each carrying a line the command
 * really prints. The output lines are quoted, not invented, and each one says
 * where it was taken from, because a page that invents a line of output is
 * doing the thing this project exists to catch.
 *
 * `tests/site.test.ts` holds each line to its source: the mutate line has to
 * appear verbatim in a worked example under `docs/examples/`, and the census
 * and induce lines have to be built out of strings their formatters hold.
 */
const CARDS = [
  {
    command: "adg mutate",
    question: "Would your tests notice if the code broke?",
    blurb:
      "It breaks the code in known ways, runs the suite against every break, and reports the breaks" +
      " no test failed on.",
    // docs/examples/06-a-feature-with-nothing-holding-it.md, the summary line
    // of a real `mutate` run, printed by the formatter in src/mutate.ts.
    output: "killed 2, survived 3, timeout 0, skipped 0",
  },
  {
    command: "adg census",
    question: "Did your new test ever actually fail?",
    blurb:
      "It runs the tests a change added against the code from before the change. One that passes there" +
      " would have passed without the fix.",
    // src/census.ts: the finding kind and the title its text report prints
    // beside it, "  <kind>: <title>".
    output: "not-red-before-green: passing against the base source",
  },
  {
    command: "adg induce",
    question: "Does your error handling actually run?",
    blurb:
      "It runs a failure you declare twice, once with the handling in place and once with it taken" +
      " away, and fails the claim when the check passes both times.",
    // src/induce.ts: the verdict counts its text report prints as a header.
    output: "proven 0, handler-did-not-fire 0, check-does-not-measure 1, could-not-run 0",
  },
];

function renderCards() {
  return CARDS.map(
    (card) => `      <article class="card">
        <p class="card-cmd"><code>${escapeHtml(card.command)}</code></p>
        <h3>${escapeHtml(card.question)}</h3>
        <p>${escapeHtml(card.blurb)}</p>
        <pre><code>${escapeHtml(card.output)}</code></pre>
      </article>`,
  ).join("\n");
}

function renderPage(rules, tally, examples, commands) {
  const faq = faqEntries(rules, tally);
  const checkList = commands.checks.map((name) => `<code>${escapeHtml(name)}</code>`).join(", ");
  const title = `${PACKAGE_NAME}: proof obligations for an AI coding agent's delivery report`;
  const socialUrl = SITE_URL + SOCIAL_IMAGE;
  const socialAlt =
    "A terminal showing seven passing tests, beside the note that every check got better while the" +
    " money is no longer checked by anything.";

  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "SoftwareSourceCode",
        "@id": SITE_URL + "#software",
        name: PACKAGE_NAME,
        alternateName: "Agent delivery gates",
        description: DESCRIPTION,
        url: SITE_URL,
        codeRepository: REPO_URL,
        programmingLanguage: ["TypeScript", "JavaScript", "Shell"],
        runtimePlatform: "Node.js 22.18 or newer",
        license: "https://www.apache.org/licenses/LICENSE-2.0",
        author: { "@type": "Person", name: AUTHOR },
        maintainer: { "@type": "Person", name: AUTHOR },
        image: socialUrl,
        keywords: [
          "AI coding agent",
          "delivery gate",
          "code review",
          "git hooks",
          "test integrity",
          "MCP server",
        ],
        // No applicationCategory or operatingSystem here. Both are properties
        // of SoftwareApplication, and this node is SoftwareSourceCode, which
        // is a CreativeWork and not a SoftwareApplication.
        isAccessibleForFree: true,
      },
      {
        "@type": "FAQPage",
        "@id": SITE_URL + "#faq",
        mainEntity: faq.map((item) => ({
          "@type": "Question",
          name: item.q,
          acceptedAnswer: { "@type": "Answer", text: item.a },
        })),
      },
    ],
  };

  // JSON.stringify leaves "<" alone, so a "</script>" inside any string would
  // end the block early for an HTML parser while the JSON itself stays valid.
  // Escaping every "<" as a \\u003c sequence is still the same JSON to a JSON
  // parser and
  // carries nothing an HTML parser can act on. Nothing read out of the records
  // reaches this block today, which is why this is a guard and not a fix.
  const jsonLdText = JSON.stringify(jsonLd, null, 2).replaceAll("<", "\\u003c");

  const exampleItems = examples
    .map(
      (example) =>
        `          <li><a href="${BLOB_URL}${escapeHtml(example.file)}">${escapeHtml(example.title)}</a></li>`,
    )
    .join("\n");

  const faqItems = faq
    .map(
      (item) => `        <div class="qa">
          <h3>${escapeHtml(item.q)}</h3>
          <p>${escapeHtml(item.a)}</p>
        </div>`,
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(DESCRIPTION)}">
<link rel="canonical" href="${SITE_URL}">
<meta name="author" content="${escapeHtml(AUTHOR)}">
<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">
<meta name="color-scheme" content="light dark">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${escapeHtml(PACKAGE_NAME)}">
<meta property="og:url" content="${SITE_URL}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(DESCRIPTION)}">
<!-- The social image is an SVG. Producing a PNG here would mean adding an
     image library, and this build has no dependencies by design; the same
     rule that keeps the published package free of them applies to the page
     that describes it. Crawlers read the SVG, but most social previewers,
     X, Facebook, LinkedIn and Slack among them, reject SVG for a card image,
     so the realistic outcome is a link with no preview image on any of them
     while the card type still says summary_large_image. That is the trade
     accepted here, not a small gap. -->
<meta property="og:image" content="${socialUrl}">
<meta property="og:image:type" content="image/svg+xml">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${escapeHtml(socialAlt)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(DESCRIPTION)}">
<meta name="twitter:image" content="${socialUrl}">
<meta name="twitter:image:alt" content="${escapeHtml(socialAlt)}">
<meta name="theme-color" content="#0b7261" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%230b7261'/%3E%3Cpath d='M4 8.5l2.5 2.5L12 5.5' stroke='%239bf4da' stroke-width='2' fill='none'/%3E%3C/svg%3E">
<style>
:root {
  color-scheme: dark light;
  /* Dark is the default here, on the green ground the Rust site carries.
     Every colour below was measured against that ground: body text, muted
     text, links and the tick all clear 4.5:1, and the two panel greens sit
     far enough off it to read as panels. */
  --bg: #0b7261;
  --fg: #eefbf6;
  --muted: #cbebe0;
  --rule: #6fc0af;
  --code-bg: #064c40;
  --card-bg: #095f51;
  --link: #c7f9e5;
  --accent: #9bf4da;
  --warn: #ffdcc4;
}
/* Every token above is redefined here, none of them dropped. A token defined
   in one scheme only reads as the other scheme's value, which is the kind of
   contrast failure nobody sees until someone else opens the page. Light is
   the override now: a reader who has asked their system for light gets it. */
@media (prefers-color-scheme: light) {
  :root {
    --bg: #ffffff;
    --fg: #1b1f24;
    --muted: #5b6672;
    --rule: #d9dee4;
    --code-bg: #f4f6f8;
    --card-bg: #fbfcfd;
    --link: #137752;
    --accent: #137752;
    --warn: #b04f36;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 1.125rem;
  line-height: 1.65;
}
/* The column is the measure. Prose fills it edge to edge, so every block on
   the page shares one left margin and one right margin and the whole thing is
   centred by construction. The earlier attempt capped each block instead and
   left them all hugging the left of a much wider column. */
.wrap { max-width: 50rem; margin: 0 auto; padding: 3.5rem 1.1rem 6rem; }
header { border-bottom: 3px solid var(--accent); padding-bottom: 2rem; }
h1 { font-size: clamp(2.5rem, 6vw, 4rem); line-height: 1.05; margin: 0 0 1.2rem; letter-spacing: -.02em; }
h2 { font-size: clamp(1.75rem, 3.2vw, 2.4rem); line-height: 1.2; letter-spacing: -.01em; margin: 0 0 1.4rem; }
h3 { font-size: 1.3rem; line-height: 1.3; margin: 2.4rem 0 .6rem; }
h4 { font-size: 1.05rem; margin: 0 0 .3rem; }
p { margin: 0 0 1.2rem; }
a { color: var(--link); }
a:hover { text-decoration: none; }
.lede { color: var(--fg); font-size: clamp(1.2rem, 2.1vw, 1.45rem); line-height: 1.45; }
nav ul { list-style: none; display: flex; flex-wrap: wrap; gap: .6rem 1.6rem; padding: 0; margin: 2rem 0 0; }
nav a { font-size: 1rem; }
main > article > section { padding: 5rem 0 0; }
main > article > section + section { border-top: 1px solid var(--rule); margin-top: 5rem; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .88em; }
code { background: var(--code-bg); padding: .1em .3em; border-radius: 3px; }
pre { background: var(--code-bg); padding: 1rem 1.2rem; border-radius: 6px; overflow-x: auto; border: 1px solid var(--rule); line-height: 1.5; }
pre code { background: none; padding: 0; }
ul.plain, ul.rules { list-style: none; padding: 0; }
ul.plain > li { margin: 0 0 .7rem; }
ul.rules > li { border: 1px solid var(--rule); border-radius: 6px; padding: 1rem 1.2rem; margin: 0 0 .8rem; background: var(--card-bg); }
ul.rules p { margin: 0 0 .4rem; }
.rule-name { font-weight: 600; }
.meta { color: var(--muted); font-size: .88rem; display: flex; flex-wrap: wrap; gap: .5rem; align-items: baseline; }
.emits { color: var(--muted); font-size: .88rem; }
.tag { border: 1px solid var(--rule); border-radius: 999px; padding: .05rem .55rem; }
.sev-critical { border-color: var(--warn); color: var(--warn); }
/* The three cards. Wider than the prose column, and one across on a phone.
   The left margin centres the row on the page without a transform, so it
   stays put with images off and with JavaScript off. */
.headline {
  font-size: clamp(1.2rem, 2.1vw, 1.45rem);
  color: var(--fg);
  line-height: 1.5;
  margin: 1.6rem 0 0;
  padding: 0;
  list-style: none;
}
.headline li { position: relative; padding-left: 1.9rem; margin: 0 0 .7rem; }
/* The tick is drawn by the stylesheet and carries no meaning of its own: the
   sentence beside it says everything, so a reader who never sees the mark
   loses nothing. */
.headline li::before {
  content: "\\2713";
  position: absolute;
  left: 0;
  top: 0;
  color: var(--accent);
  font-weight: 700;
}
.cta { margin: 2rem 0 0; }
.button {
  display: inline-flex;
  align-items: center;
  gap: .6rem;
  padding: .8rem 1.4rem;
  border: 1px solid var(--rule);
  border-radius: 8px;
  background: var(--card-bg);
  color: var(--fg);
  font-size: 1.05rem;
  font-weight: 600;
  text-decoration: none;
}
.button:hover, .button:focus-visible { border-color: var(--accent); }
.ghmark { flex: 0 0 auto; }
.cards {
  display: grid;
  /* minmax(0, ...) and not 1fr: a grid item's automatic minimum size is
     its content, so one long unwrappable line of output pushes its own
     track wider than the track was asked to be and the whole row spills
     past the page. */
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1.6rem;
  width: min(76rem, calc(100vw - 2.2rem));
  margin-left: calc(50% - min(38rem, calc(50vw - 1.1rem)));
  /* The row breaks out of the prose column, so the paragraph under it
     needs room of its own to read as a new thought and not as a caption
     on the cards. */
  margin-bottom: 3.5rem;
}
.card {
  border: 1px solid var(--rule);
  border-top: 3px solid var(--accent);
  border-radius: 6px;
  background: var(--card-bg);
  padding: 1.4rem 1.4rem 1.6rem;
  display: flex;
  flex-direction: column;
}
.card h3 { margin: .8rem 0 .6rem; font-size: 1.35rem; }
.card p { margin: 0 0 1rem; }
.card-cmd { font-size: .95rem; color: var(--muted); }
.card pre { margin: auto 0 0; font-size: .82em; overflow-x: auto;
  white-space: pre-wrap; overflow-wrap: anywhere; }
/* The output lines are real command output and are not reflowed, so a
   narrow card scrolls its own line instead of stretching to hold it. */
@media (max-width: 60rem) {
  .cards { grid-template-columns: 1fr; width: auto; margin-left: 0; }
}
table { border-collapse: collapse; width: 100%; margin: 0 0 1.2rem; font-size: .95rem; }
caption { text-align: left; color: var(--muted); font-size: .9rem; padding-bottom: .6rem; }
th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid var(--rule); vertical-align: top; }
td:last-child, th:last-child { text-align: left; }
.scroller { overflow-x: auto; }
.qa h3 { margin-bottom: .3rem; }
footer { margin-top: 5rem; padding-top: 1.5rem; border-top: 1px solid var(--rule); color: var(--muted); font-size: .95rem; }
img { max-width: 100%; height: auto; }
@media (max-width: 34rem) {
  body { font-size: 1.0625rem; }
  .wrap { padding-top: 2.5rem; }
  main > article > section { padding-top: 3.5rem; }
  main > article > section + section { margin-top: 3.5rem; }
}
</style>
<script type="application/ld+json">
${jsonLdText}
</script>
</head>
<body>
<div class="wrap">
<header>
  <h1>${escapeHtml(PACKAGE_NAME)}</h1>
  <p class="lede">${escapeHtml(TAGLINE)}</p>
  <ul class="headline">${HEADLINE.map((line) => `\n    <li>${escapeHtml(line)}</li>`).join("")}
  </ul>
  <p class="cta"><a class="button" href="${REPO_URL}">${GITHUB_MARK}<span>View on GitHub</span></a></p>
  <nav aria-label="Sections of this page">
    <ul>
      <li><a href="#green-run">A green run that proves nothing</a></li>
      <li><a href="#three-questions">Three questions</a></li>
      <li><a href="#examples">Worked examples</a></li>
      <li><a href="#tally">What the gates caught here</a></li>
      <li><a href="#install">Install</a></li>
      <li><a href="#where-it-runs">Where it runs</a></li>
      <li><a href="#rules">The ${escapeHtml(words(rules.length))} rules</a></li>
      <li><a href="#questions">Questions</a></li>
      <li><a href="${REPO_URL}">Source on GitHub</a></li>
    </ul>
  </nav>
</header>

<main>
  <article>
    <section id="green-run">
      <h2>A green run that proves nothing</h2>
      <p>A shopping cart with four passing tests. An agent is asked to add promo
        codes. It does, and it adds three tests for the new behaviour.</p>
      <pre><code>$ node --test tests/*.test.js
# tests 7
# pass 7
# fail 0</code></pre>
      <p>Four tests became seven. Nothing failed. The feature works. A customer whose
        cart comes to exactly 50 has just started paying for shipping, and the test
        that would have said so was edited, in the same commit, until it could no
        longer fail.</p>
      <p>Every check a project normally runs got better here, which is the point. A
        green run and a green run over checks that cannot fail look the same from
        outside, and only one of them means anything.</p>
    </section>

    <section id="three-questions">
      <h2>Three questions a green run cannot answer</h2>
      <p>Each one is a command with an exit code, and each answers by running
        something and reporting what happened, never by reading a diff and forming
        an opinion about it.</p>
      <div class="cards">
${renderCards()}
      </div>
      <p>A fourth question is what the agent then writes about the work. A rule system
        checks the code an agent wrote, and runtime guardrails check its inputs and
        tool calls while it works; neither checks the account of the work once the
        work is done. That is
        <a href="#rules">${escapeHtml(words(rules.length))} proof obligations</a> for a delivery report,
        ${escapeHtml(words(rules.filter((rule) => rule.enforcement === "hook").length))} of them checked by a hook on every commit, running the same way in
        Claude Code, Cursor, Codex, GitHub Copilot, CI, or a plain pre-commit hook
        with no agent at all, and an MCP server for an agent that would rather ask
        than be stopped.</p>
    </section>

    <section id="examples">
      <h2>${escapeHtml(words(examples.length).replace(/^./, (c) => c.toUpperCase()))} worked examples</h2>
      <p>Hardest first. Each one run for real, with the exact output it produced.
        They open in the repository on GitHub.</p>
      <ul class="plain">
${exampleItems}
      </ul>
    </section>

    <section id="tally">
      <h2>What the gates caught here</h2>
      <p>This repository ran its own gates while it was being built, and logged what
        they caught in <a href="${BLOB_URL}docs/gate-tally.md">the gate tally</a> as the
        work went: ${tally.total} entries, dated ${escapeHtml(tally.first)} to ${escapeHtml(tally.last)}. Each entry is dated
        and says where to see the result, so any row can be opened instead of taken
        on trust. It is a receipt, not a claim.</p>
      <div class="scroller">
${renderTallyTable(rules, tally)}
      </div>
      <p>A zero does not mean a rule was unnecessary. It means the work stayed clean
        on that rule for the life of this build, or nothing looked closely enough to
        catch anything on it yet, and the count alone cannot tell you which.</p>
    </section>

    <section id="install">
      <h2>Install</h2>
      <pre><code>npm install --save-dev ${escapeHtml(PACKAGE_NAME)}
npx adg init
git config core.hooksPath .githooks</code></pre>
      <p><code>init</code> writes a git pre-commit hook, <code>AGENTS.md</code>, an empty
        gate tally log, a CI workflow, and the hook and MCP configs for the agents
        listed below, and only ever creates a file that does not already exist.
        <code>--dry-run</code> prints what would happen without writing anything,
        <code>--force</code> overwrites a file that already exists, and
        <code>--dir PATH</code> targets a directory other than the current one.</p>
      <p>Every check is a command of its own, read here out of the command line
        entry point: ${checkList}. Each is an ordinary program with an exit code,
        so it runs from any pre-commit hook or CI job.
        <code>agent-delivery-gates mcp</code> starts a local MCP server on stdio: a
        client starts it, writes to its stdin and reads its stdout, and nothing about
        a project's code or reports leaves the machine.</p>
      <p>Node 22.18 or newer. No runtime dependencies. Licensed under Apache 2.0.</p>
    </section>

    <section id="where-it-runs">
      <h2>Where it runs</h2>
      <div class="scroller">
        <table>
          <caption>The wiring each agent uses</caption>
          <thead>
            <tr><th scope="col">Agent</th><th scope="col">Wiring</th></tr>
          </thead>
          <tbody>
            <tr><th scope="row">Claude Code</th><td>a plugin that wires its own hooks in with no <code>init</code> step needed, or the lines <code>init</code> prints for <code>.claude/settings.json</code></td></tr>
            <tr><th scope="row">Cursor</th><td><code>.cursor/hooks.json</code>, written by <code>init</code></td></tr>
            <tr><th scope="row">Codex</th><td><code>.codex/hooks.json</code>, written by <code>init</code></td></tr>
            <tr><th scope="row">GitHub Copilot</th><td><code>.github/hooks/agent-delivery-gates.json</code>, written by <code>init</code></td></tr>
            <tr><th scope="row">CI, no agent</th><td><code>.github/workflows/agent-delivery-gates.yml</code>, written by <code>init</code></td></tr>
            <tr><th scope="row">Command line, no agent</th><td>${checkList}, run directly or from any pre-commit hook</td></tr>
          </tbody>
        </table>
      </div>
      <p>The Codex, Cursor, and Copilot hook configs use each platform's tool names
        as best guesses. Only the Claude Code plugin has run against the real tool,
        so the other three configs have not been loaded and confirmed by the coding
        tool they target.</p>
    </section>

    <section id="rules">
      <h2>The ${escapeHtml(words(rules.length))} rules</h2>
      <p>All ${escapeHtml(words(rules.length))} are recorded in
        <a href="${REPO_URL}/tree/main/rules">the <code>rules</code> directory</a>, one JSON file per
        rule. Everything below is read out of those files at build time, so this page
        cannot describe a rule the records do not carry. Grouped by each record's own
        <code>enforcement</code> field.</p>

${renderCatalog(rules, tally)}
    </section>

    <section id="questions">
      <h2>Questions</h2>
${faqItems}
    </section>
  </article>
</main>

<footer>
  <p><a href="${REPO_URL}">${escapeHtml(PACKAGE_NAME)} on GitHub</a>. Apache 2.0. No analytics, no
    trackers, no third-party requests from this page.</p>
  <p>This page is generated from the rule records and the gate tally in the
    repository, so its numbers move when the records move.</p>
</footer>
</div>
</body>
</html>
`;
}

// Allow everything by default, then name the search and AI crawlers one by
// one. The blanket rule already permits them; naming them leaves no room to
// read the file as an opt-out.
const CRAWLERS = [
  "Googlebot",
  "Bingbot",
  "DuckDuckBot",
  "Applebot",
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

function renderRobots() {
  const blocks = ["User-agent: *", "Allow: /", ""];
  for (const agent of CRAWLERS) {
    blocks.push(`User-agent: ${agent}`, "Allow: /", "");
  }
  blocks.push(`Sitemap: ${SITE_URL}sitemap.xml`, "");
  return [
    "# Every crawler is welcome here, search engines and AI crawlers alike.",
    "# The blanket rule below already allows them; each one is named after it",
    "# so the intent cannot be misread as an opt-out.",
    "",
    ...blocks,
  ].join("\n");
}

function renderSitemap(lastmod) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${escapeXml(SITE_URL)}</loc>
    <lastmod>${escapeXml(lastmod)}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
`;
}

// --- build -------------------------------------------------------------------

function parseArgs(argv) {
  let out = join(HERE, "dist");
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") {
      const value = argv[++i];
      if (value === undefined) fail("--out needs a path argument");
      out = resolve(value);
    } else if (argv[i] === "--help" || argv[i] === "-h") {
      process.stdout.write("Usage: node build.js [--out PATH]\n");
      process.exit(0);
    } else {
      fail(`unknown argument '${argv[i]}'`);
    }
  }
  return out;
}

function main() {
  const outDir = parseArgs(process.argv.slice(2));
  const rules = readRules();
  const tally = readTally(rules.map((rule) => rule.id));
  const examples = readExamples();
  const commands = readSubcommands();

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const written = [];
  function write(name, contents) {
    const path = join(outDir, name);
    writeFileSync(path, contents, "utf8");
    written.push([name, Buffer.byteLength(contents, "utf8")]);
  }

  write("index.html", renderPage(rules, tally, examples, commands));
  write("robots.txt", renderRobots());
  // The tally's last entry dates the content, which keeps a rebuild of
  // unchanged inputs byte for byte identical to the one before it.
  write("sitemap.xml", renderSitemap(tally.last));
  // GitHub Pages runs Jekyll over a directory unless this file is present.
  write(".nojekyll", "");
  write("CNAME", SITE_HOST + "\n");
  copyFileSync(join(HERE, "static", SOCIAL_IMAGE), join(outDir, SOCIAL_IMAGE));
  written.push([SOCIAL_IMAGE, readFileSync(join(HERE, "static", SOCIAL_IMAGE)).length]);

  process.stdout.write(`site build: ${outDir}\n`);
  process.stdout.write(
    `site build: ${rules.length} rules, ${tally.total} tally entries (${tally.first} to ${tally.last}), ${examples.length} worked examples, ${commands.checks.length} check commands\n`,
  );
  for (const [name, size] of written) {
    process.stdout.write(`site build:   ${name} (${size} bytes)\n`);
  }
}

main();
