// Resolves and validates test-diff-separator's configuration. This is where
// file reading happens; src/test-diff-separator.ts stays pure and takes a
// fully resolved RuleSet as an argument.
//
// Path resolution, first match wins: an explicit --config path, then
// ADG_TEST_DIFF_CONFIG in the environment, then .adg/test-diff.json at the
// repository root, then the built-in defaults with no file at all.
//
// A config document is a JSON object whose keys are the six rule buckets
// (testPaths, assertions, testCases, skips, tolerance, timeout). Each bucket
// is an object carrying "add" (always allowed) and, for the four
// classification buckets, "replace". An unknown top-level key, an unknown
// key inside a bucket, a value of the wrong type, a file that is not valid
// JSON, or a fragment that is not a valid regex: all of these are errors.
// None of them fall back to the defaults silently, because a config that
// failed to load and a config that loaded and asked for the defaults must
// never look the same.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_RULES, REPLACEABLE_BUCKETS, RULE_BUCKETS, type RuleBucket, type RuleSet } from "./test-diff-separator.ts";

/** Thrown for any problem resolving or validating a config. Distinguished
 * from a generic Error so a caller can report it without a stack trace. */
export class ConfigError extends Error {}

interface BucketConfig {
  add?: string[];
  replace?: string[];
}

type ParsedConfig = Partial<Record<RuleBucket, BucketConfig>>;

/**
 * Finds which config file to use, or null when none of the three sources
 * apply and the defaults alone are in play. Does not check the file exists
 * for an explicit path or the environment variable; that failure is
 * reported later, when the file is actually read, with a clearer message.
 */
export function resolveConfigPath(options: {
  explicitPath?: string;
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
}): string | null {
  if (options.explicitPath !== undefined) return options.explicitPath;
  const envPath = options.env?.ADG_TEST_DIFF_CONFIG;
  if (typeof envPath === "string" && envPath !== "") return envPath;
  if (options.repoRoot !== undefined) {
    const candidate = join(options.repoRoot, ".adg", "test-diff.json");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function parseBucket(bucket: RuleBucket, raw: unknown): BucketConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`"${bucket}" must be an object with "add" and/or "replace"`);
  }
  const obj = raw as Record<string, unknown>;
  const allowedKeys = REPLACEABLE_BUCKETS.has(bucket) ? ["add", "replace"] : ["add"];
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.includes(key)) {
      throw new ConfigError(`"${bucket}.${key}" is not a recognised key (allowed: ${allowedKeys.join(", ")})`);
    }
  }
  const result: BucketConfig = {};
  if ("add" in obj) {
    if (!isStringArray(obj.add)) throw new ConfigError(`"${bucket}.add" must be an array of strings`);
    result.add = obj.add;
  }
  if ("replace" in obj) {
    if (!isStringArray(obj.replace)) throw new ConfigError(`"${bucket}.replace" must be an array of strings`);
    result.replace = obj.replace;
  }
  return result;
}

/** Parses and validates a config document already read into a string. Pure:
 * no file I/O, so it is testable directly against a literal string. */
export function parseConfig(text: string): ParsedConfig {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`not valid JSON (${(err as Error).message})`);
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new ConfigError("the config must be a JSON object");
  }
  const obj = json as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!(RULE_BUCKETS as readonly string[]).includes(key)) {
      throw new ConfigError(`"${key}" is not a recognised top-level key (allowed: ${RULE_BUCKETS.join(", ")})`);
    }
  }
  const result: ParsedConfig = {};
  for (const bucket of RULE_BUCKETS) {
    if (bucket in obj) result[bucket] = parseBucket(bucket, obj[bucket]);
  }
  return result;
}

/** Applies parsed bucket configs on top of the defaults: "add" extends the
 * defaults, "replace" discards them before adding. A bucket the config does
 * not mention keeps the defaults untouched. */
export function mergeRules(base: RuleSet, parsed: ParsedConfig): RuleSet {
  const result: RuleSet = { ...base };
  for (const bucket of RULE_BUCKETS) {
    const cfg = parsed[bucket];
    if (cfg === undefined) continue;
    const startFrom = cfg.replace !== undefined ? [...cfg.replace] : [...base[bucket]];
    result[bucket] = cfg.add !== undefined ? [...startFrom, ...cfg.add] : startFrom;
  }
  return result;
}

/** Every fragment in every bucket must itself be a valid regex. Checked
 * fragment by fragment so the error names the one that broke, instead of
 * only the whole bucket's joined pattern. */
function validateFragments(rules: RuleSet): void {
  for (const bucket of RULE_BUCKETS) {
    for (const fragment of rules[bucket]) {
      try {
        new RegExp(fragment);
      } catch (err) {
        throw new ConfigError(`"${bucket}" has an invalid regex fragment '${fragment}': ${(err as Error).message}`);
      }
    }
  }
}

/**
 * Reads, parses, merges, and validates a config file into a full RuleSet on
 * top of the defaults. `path` null means no config file applies: the
 * defaults alone. Throws ConfigError on any problem; never falls back to
 * the defaults silently on a broken config, since that would make a broken
 * config look the same as no config.
 */
export function loadRuleSet(path: string | null): RuleSet {
  if (path === null) return DEFAULT_RULES;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new ConfigError(`could not read '${path}' (${(err as Error).message})`);
  }
  const parsed = parseConfig(text);
  const merged = mergeRules(DEFAULT_RULES, parsed);
  validateFragments(merged);
  return merged;
}
