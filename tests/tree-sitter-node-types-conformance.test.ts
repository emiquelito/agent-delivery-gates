// Closes the class, not just the instances.
//
// Two node-type omissions have been found in this project's config by two
// separate rounds of review: Ruby's `bare_string` (a %W[] word's own
// interpolation, masked away as if it were plain text -- see Finding 1 of
// the round this test was added in) and, before that, Rust's doc-comment
// marker nodes. Both were caught by a person reading a grammar's own
// node-types.json by hand, once by an earlier builder finding it by
// chance and once by a reviewer going looking on purpose. A hand-written
// list checked by hand will keep drifting: nothing forced anyone to
// notice a seventh, unlisted node type showing up the day a grammar
// package is upgraded and adds one.
//
// This file reads each grammar's own node-types.json -- the same file
// src/tree-sitter-grammars.ts's own header says every node type name here
// was read out of -- and asserts that src/tree-sitter-grammars.ts's
// config for that grammar accounts for every named node type reachable,
// by node-types.json's own children lists, from that grammar's
// literalTypes or contentTypes. "Accounts for" means one of three things,
// and the test cannot tell which one from the config alone, which is why
// EXCLUSIONS below exists as its own explicit list: a type is in
// literalTypes (a container blanked wholesale, and itself walked further),
// in contentTypes (plain text, blanked and not walked further), or in this
// file's own EXCLUSIONS for that language -- a type considered and left
// out on purpose, because it is a real, code-bearing construct (most
// commonly an interpolation) that the generic walk in
// src/tree-sitter-language-service.ts is supposed to reopen as code by
// leaving it unlisted. A type in none of the three fails the test, the
// same way `bare_string`'s own interpolation child would have failed it
// had this test existed before Finding 1.
//
// What this deliberately does not check: anything about the *rest* of a
// grammar, or about a node type's own grandchildren once that node type is
// itself in EXCLUSIONS. A type in EXCLUSIONS is real code -- an
// interpolation's expression -- and what that expression can contain is
// the entire rest of the language's grammar, unbounded and beside the
// point; the walk already reopens it and recurses through
// src/tree-sitter-language-service.ts's own markNode, exercised by each
// language's differential corpus instead. This test's job stops at naming
// every type that sits *inside* a literal container and deciding what
// becomes of it, not at re-verifying the whole grammar.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { GRAMMAR_SPECS, type GrammarSpec } from "../src/tree-sitter-grammars.ts";
import type { GrammarConfig } from "../src/tree-sitter-language-service.ts";

/** One named node type entry from a grammar's own node-types.json, pared
 * down to what this file reads: its own type name and the named types of
 * its own direct children, if any. node-types.json also carries anonymous
 * (unnamed) type entries under the same "type" string for some grammars
 * (PHP's own `string` keyword token alongside its named `string` node,
 * for instance) -- those are filtered out when this file indexes the
 * file by type name, the same way markNode itself only ever looks at
 * `child.isNamed` children. */
interface NodeTypeEntry {
  readonly type: string;
  readonly named?: boolean;
  readonly children?: { readonly types?: ReadonlyArray<{ readonly type: string; readonly named?: boolean }> };
}

/** Where each grammar package keeps its own node-types.json, relative to
 * the package root resolved from its package.json -- not always
 * "src/node-types.json": tree-sitter-php ships two grammar variants
 * (php_only and the full php dialect that mixes in HTML), each with its
 * own node-types.json, and src/tree-sitter-grammars.ts's php spec loads
 * "tree-sitter-php.wasm", the full dialect, so this reads php/src/
 * node-types.json to match, not php_only's. */
const NODE_TYPES_SUBPATH: Readonly<Record<string, string>> = {
  ".rs": "src/node-types.json",
  ".rb": "src/node-types.json",
  ".php": "php/src/node-types.json",
  ".go": "src/node-types.json",
  ".java": "src/node-types.json",
  ".cs": "src/node-types.json",
};

/**
 * Every named node type this file has confirmed is reachable, through
 * node-types.json's own children lists, from a literal container in that
 * language's config, and that is deliberately left out of both
 * literalTypes and contentTypes -- a real, code-bearing construct the
 * generic walk is supposed to reopen as code by leaving it unlisted, not
 * an oversight. Each entry names the actual finding that put it here, so
 * a future change to this list carries its own reasoning instead of a
 * bare type name:
 *
 *   - ruby "interpolation": `#{...}` inside a string, a heredoc, or (since
 *     Finding 1 of this round) a %W[]/%I[] word/symbol array.
 *   - java "string_interpolation": `\{...}` inside a `STR."..."` string
 *     template (see Finding 5 of this round, and src/tree-sitter-grammars.ts's
 *     corrected comment on the java entry -- this is not "Java has none").
 *   - csharp "interpolation": `{...}` inside a `$"..."` interpolated
 *     string.
 *   - php's five: `$var`, `$obj->prop`, `$arr[key]`, and `${...}`/`{$...}`
 *     forms all parse to one of these five node types inside a
 *     string/encapsed_string/heredoc_body -- "expression" is PHP's own
 *     supertype name covering the general `{$expr}` form, and the other
 *     four are its more specific unwrapped forms ($var, ->member,
 *     [subscript], and a dynamic ($$) variable name).
 */
const EXCLUSIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  ".rs": new Set(),
  ".rb": new Set(["interpolation"]),
  ".php": new Set(["expression", "variable_name", "member_access_expression", "subscript_expression", "dynamic_variable_name"]),
  ".go": new Set(),
  ".java": new Set(["string_interpolation"]),
  ".cs": new Set(["interpolation"]),
};

function loadNodeTypes(packageName: string, subpath: string): readonly NodeTypeEntry[] {
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve(`${packageName}/package.json`);
  const path = join(dirname(packageJsonPath), subpath);
  return JSON.parse(readFileSync(path, "utf8")) as NodeTypeEntry[];
}

/**
 * Every named type reachable, by node-types.json's own children lists,
 * starting from `config`'s literalTypes and contentTypes, that is not
 * itself in literalTypes, contentTypes, or `exclusions`. Empty means the
 * config, plus the exclusions list, accounts for everything this grammar
 * can actually produce inside a literal; a non-empty result names exactly
 * what to go add somewhere.
 *
 * Recursion rule: a type found in literalTypes or contentTypes is walked
 * further (its own children need the same accounting -- this is exactly
 * how Finding 1's bug would have shown up: bare_string was in
 * contentTypes, so its own child `interpolation` had to be accounted for
 * too, and wasn't). A type found in `exclusions` is not walked further:
 * once a node is a real code expression, what it can contain is the rest
 * of the grammar, unbounded, and is not this test's concern (see the file
 * header). A type found in neither is unaccounted, and recursion stops
 * there too -- there is nothing more useful to say about a node this test
 * has already flagged as missing.
 */
function findUnaccountedTypes(
  nodeTypes: readonly NodeTypeEntry[],
  config: GrammarConfig,
  exclusions: ReadonlySet<string>,
): string[] {
  const byType = new Map<string, NodeTypeEntry>();
  for (const entry of nodeTypes) {
    if (entry.named !== true) continue; // an anonymous token sharing a name with a named type, e.g. PHP's own "string" keyword
    byType.set(entry.type, entry);
  }

  const known = new Set([...config.literalTypes, ...config.contentTypes]);
  const queue: string[] = [...config.literalTypes, ...config.contentTypes];
  const seen = new Set<string>();
  const missing = new Set<string>();

  while (queue.length > 0) {
    const t = queue.pop() as string;
    if (seen.has(t)) continue;
    seen.add(t);
    const entry = byType.get(t);
    if (entry === undefined) continue; // named in the config but produces no node here (not this test's concern)
    const children = entry.children?.types ?? [];
    for (const child of children) {
      if (child.named === false) continue;
      if (exclusions.has(child.type)) continue; // real code: what it contains is out of scope, see file header
      if (known.has(child.type)) {
        if (!seen.has(child.type)) queue.push(child.type); // itself a literal container/content type: its own children need the same accounting
        continue;
      }
      missing.add(child.type);
    }
  }

  return [...missing].sort();
}

for (const [ext, spec] of Object.entries(GRAMMAR_SPECS) as Array<[string, GrammarSpec]>) {
  test(`${ext}: src/tree-sitter-grammars.ts's config accounts for every node type ${spec.packageName}'s own node-types.json says can sit inside a literal`, () => {
    const nodeTypes = loadNodeTypes(spec.packageName, NODE_TYPES_SUBPATH[ext]);
    const exclusions = EXCLUSIONS[ext];
    const missing = findUnaccountedTypes(nodeTypes, spec.config, exclusions);
    assert.deepEqual(
      missing,
      [],
      `${ext}: ${spec.packageName}'s node-types.json can produce ${JSON.stringify(missing)} inside a literal, ` +
        "and none of them is in this grammar's literalTypes, contentTypes, or this file's own EXCLUSIONS list. " +
        "Add each one to whichever set is actually correct for it, or to EXCLUSIONS with a comment saying why " +
        "leaving it unlisted (reopened as code) is the right answer.",
    );
  });
}

// Proof this test can fail, not just pass: the same check run against a
// deliberately reintroduced version of Finding 1's bug, where bare_string
// is dropped from ruby's config entirely -- neither literalTypes,
// contentTypes, nor EXCLUSIONS names it. bare_string is itself reachable
// (string_array's own child), so this must report it, and report its own
// child `interpolation` as unaccounted too, since nothing here recurses
// into a type this test has already flagged as missing.
test("findUnaccountedTypes actually fails when a real node type is dropped from the config", () => {
  const rubySpec = GRAMMAR_SPECS[".rb"];
  const nodeTypes = loadNodeTypes(rubySpec.packageName, NODE_TYPES_SUBPATH[".rb"]);
  const brokenConfig: GrammarConfig = {
    literalTypes: new Set([...rubySpec.config.literalTypes].filter((t) => t !== "bare_string")),
    contentTypes: rubySpec.config.contentTypes,
  };
  const missing = findUnaccountedTypes(nodeTypes, brokenConfig, EXCLUSIONS[".rb"]);
  assert.deepEqual(missing, ["bare_string"], "a dropped literal-container type is reported, not silently accepted");
});
