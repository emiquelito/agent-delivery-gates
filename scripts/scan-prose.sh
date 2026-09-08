#!/usr/bin/env bash
# Checks tracked text against a configurable set of prose rules: banned
# words, banned patterns, and (when the rules say so) a spaced hyphen
# standing in for an em dash. The rules themselves are not built in here;
# see "Rules files" below.
#
# Usage:
#   scan-prose.sh                    scan every tracked text file, minus
#                                     whatever the rules exclude
#   scan-prose.sh FILE...            scan exactly these files
#   scan-prose.sh --rules PATH ...   use this rules file instead of the
#                                     usual lookup
#   scan-prose.sh --require-rules    treat "no rules configured" as exit 2
#                                     instead of exit 0
#
# Rules files:
#   A rules file is plain text, one entry per line.
#     - A blank line, or a line whose first non-space character is #, is
#       ignored.
#     - "include: PATH" pulls in another rules file, resolved relative to
#       the including file's own directory.
#     - "exclude: GLOB" adds a path that is never scanned in the default
#       (no-argument) mode.
#     - "prose-only: FRAGMENT" is an extended-regex fragment applied only to
#       prose files, not to source.
#     - Any other non-empty line is an extended-regex fragment applied to
#       every scanned file.
#   Fragments are joined with | to build the pattern used against each file.
#
#   Which rules file is used, first match wins:
#     1. --rules PATH
#     2. ADG_PROSE_RULES in the environment
#     3. .adg/prose-rules.txt in the repository root, if it exists
#     4. nothing: no rules are configured
#
# Exit codes:
#   0  scanned cleanly, nothing matched (or no rules were configured and
#      --require-rules was not given)
#   1  banned prose found
#   2  the scan could not run as asked: bad path, git unavailable, a rules
#      file that does not exist, an include cycle, or (with
#      --require-rules) no rules configured
#
# Exit 2 matters: a checker that cannot read its input must never look the
# same as a checker that read the input and found it clean.
set -euo pipefail

die() {
  echo "scan-prose: $1" >&2
  exit 2
}

# --- argument parsing --------------------------------------------------------

rules_path_arg=""
require_rules=0
args=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --rules)
      [ "$#" -ge 2 ] || die "--rules requires a path argument"
      rules_path_arg=$2
      shift 2
      ;;
    --rules=*)
      rules_path_arg=${1#--rules=}
      shift
      ;;
    --require-rules)
      require_rules=1
      shift
      ;;
    --)
      shift
      args+=("$@")
      break
      ;;
    *)
      args+=("$1")
      shift
      ;;
  esac
done

# --- rules loading ------------------------------------------------------------

# Populated by load_rules_file. Fragments apply to every scanned file,
# prose-only fragments apply to prose files only, excludes narrow the
# default (no-argument) file list.
fragments=()
prose_only=()
excludes=()

# load_rules_file reads one rules file, recursing into its includes. chain is
# a ":"-separated list of the absolute paths of files currently being read,
# used to detect a cycle: an include that points back at one of its own
# ancestors.
load_rules_file() {
  local path=$1 chain=$2 abspath dir
  [ -f "$path" ] || die "rules file '$path' does not exist"
  abspath=$(realpath -- "$path") || die "could not resolve '$path'"
  case ":$chain:" in
    *":$abspath:"*) die "include cycle: '$path' includes itself, directly or indirectly" ;;
  esac
  local newchain="$chain:$abspath"
  dir=$(dirname -- "$abspath")

  local line
  while IFS= read -r line || [ -n "$line" ]; do
    # A blank line (all whitespace, or empty) is ignored.
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    # A comment: first non-space character is #.
    [[ "$line" =~ ^[[:space:]]*# ]] && continue

    local trimmed=${line#"${line%%[![:space:]]*}"}
    case "$trimmed" in
      include:*)
        local inc=${trimmed#include:}
        inc=${inc#"${inc%%[![:space:]]*}"}
        local incpath
        case "$inc" in
          /*) incpath=$inc ;;
          *) incpath="$dir/$inc" ;;
        esac
        load_rules_file "$incpath" "$newchain"
        ;;
      exclude:*)
        local ex=${trimmed#exclude:}
        ex=${ex#"${ex%%[![:space:]]*}"}
        excludes+=("$ex")
        ;;
      prose-only:*)
        local po=${trimmed#prose-only:}
        po=${po#"${po%%[![:space:]]*}"}
        prose_only+=("$po")
        ;;
      *)
        fragments+=("$trimmed")
        ;;
    esac
  done < "$path"
}

# In default (no-argument) mode, the file list itself comes from git, so a
# missing repository is a hard error, exactly as before rules files existed.
# Establish that first, and reuse the temp dir and repo root for both the
# rules lookup below and the file listing further down: a git failure must
# surface as exit 2, never get quietly swallowed into "no rules configured".
root=""
if [ "${#args[@]}" -eq 0 ]; then
  tmpd=$(mktemp -d) || die "could not create a temporary directory"
  trap 'rm -rf "$tmpd"' EXIT
  if ! root=$(git rev-parse --show-toplevel 2>"$tmpd/err"); then
    die "not a git repository. git said: $(cat "$tmpd/err")"
  fi
else
  # Explicit file arguments do not require a repository. Best-effort only:
  # used solely to look for a default rules file, never fatal on its own.
  root=$(git rev-parse --show-toplevel 2>/dev/null) || root=""
fi

# Resolve which rules file to use, first match wins. An explicitly named
# source (--rules or ADG_PROSE_RULES) that does not exist is an error: the
# caller asked for a specific file. The repo-default lookup is not an error
# if it turns up nothing; that just means no rules are configured.
rules_path=""
rules_explicit=0
if [ -n "$rules_path_arg" ]; then
  rules_path=$rules_path_arg
  rules_explicit=1
elif [ -n "${ADG_PROSE_RULES:-}" ]; then
  rules_path=$ADG_PROSE_RULES
  rules_explicit=1
elif [ -n "$root" ]; then
  candidate="$root/.adg/prose-rules.txt"
  [ -f "$candidate" ] && rules_path=$candidate
fi

if [ -n "$rules_path" ]; then
  if [ "$rules_explicit" -eq 1 ] && [ ! -f "$rules_path" ]; then
    die "rules file '$rules_path' does not exist"
  fi
  load_rules_file "$rules_path" ""
fi

if [ "${#fragments[@]}" -eq 0 ] && [ "${#prose_only[@]}" -eq 0 ]; then
  if [ "$require_rules" -eq 1 ]; then
    die "no prose rules are configured; nothing was checked"
  fi
  echo "scan-prose: no prose rules are configured; nothing was checked"
  exit 0
fi

pattern_code=$(IFS='|'; echo "${fragments[*]}")
prose_fragments=("${fragments[@]}")
[ "${#prose_only[@]}" -gt 0 ] && prose_fragments+=("${prose_only[@]}")
pattern_prose=$(IFS='|'; echo "${prose_fragments[*]}")

pattern_for() {
  # Lowercased, so an uppercase extension is treated the same as a lower one.
  case "${1,,}" in
    *.ts|*.tsx|*.js|*.mjs|*.cjs|*.sh) printf '%s' "$pattern_code" ;;
    *) printf '%s' "$pattern_prose" ;;
  esac
}

# --- file selection ------------------------------------------------------------

files=()
if [ "${#args[@]}" -gt 0 ]; then
  # Explicit arguments: every one must resolve to a readable regular file.
  # A typo or a renamed file is an error, never a silent pass.
  for arg in "${args[@]}"; do
    if [ -d "$arg" ]; then
      die "'$arg' is a directory, expected a file"
    elif [ -L "$arg" ] && [ ! -e "$arg" ]; then
      die "'$arg' is a symlink whose target does not exist"
    elif [ ! -e "$arg" ]; then
      die "'$arg' does not exist"
    elif [ ! -f "$arg" ]; then
      die "'$arg' is not a regular file"
    elif [ ! -r "$arg" ]; then
      die "'$arg' is not readable"
    fi
    files+=("$arg")
  done
else
  # No arguments: scan tracked markdown. git failing here is an error, not an
  # empty result. Capturing status separately keeps the failure visible.
  # Null delimited, through a temp file. Two traps to avoid here: command
  # substitution strips null bytes, and plain newline-delimited output makes
  # git quote any non-ASCII path (core.quotepath defaults to true), which
  # yields a filename that cannot be opened. A temp file keeps git's exit
  # status visible and the bytes intact. root and tmpd were already
  # established above, ahead of the rules lookup.
  # --others --exclude-standard adds files that are not tracked yet and not
  # ignored. Without them a new file was never checked until after its first
  # commit, which is exactly when checking it still helps.
  exclude_pathspecs=()
  for ex in "${excludes[@]}"; do
    exclude_pathspecs+=(":(exclude)$ex")
  done
  if ! git -C "$root" ls-files -z --cached --others --exclude-standard -- \
      '*.md' '*.json' '*.ts' '*.sh' '.gitignore' '.gitattributes' 'NOTICE' \
      "${exclude_pathspecs[@]}" >"$tmpd/list" 2>"$tmpd/err"; then
    die "git ls-files failed. git said: $(cat "$tmpd/err")"
  fi
  if [ -s "$tmpd/list" ]; then
    mapfile -d '' -t rel <"$tmpd/list"
    for r in "${rel[@]}"; do
      files+=("$root/$r")
    done
  fi
  if [ "${#files[@]}" -eq 0 ]; then
    echo "scan-prose: nothing tracked to scan"
    exit 0
  fi
fi

matched_count=0
had_match=0

for f in "${files[@]}"; do
  pat=$(pattern_for "$f")
  # An empty pattern (source file, prose-only fragments configured but no
  # fragment applies to code) means nothing to look for in this file. An
  # empty extended-regex pattern matches every line, so this is not a
  # no-op to skip: passing it to grep would flag the whole file.
  if [ -z "$pat" ]; then
    continue
  fi

  set +e
  output=$(grep -inHE "$pat" -- "$f")
  status=$?
  set -e

  case "$status" in
    0)
      matched_count=$((matched_count + 1))
      had_match=1
      printf '%s\n' "$output"
      ;;
    1) ;;
    *) die "error reading '$f'" ;;
  esac
done

echo "scan-prose: scanned ${#files[@]} file(s), $matched_count contained matches"

[ "$had_match" -eq 1 ] && exit 1
exit 0
