#!/usr/bin/env bash
# Checks markdown prose against this repo's writing constraints: banned words,
# banned patterns, em dashes, and a spaced hyphen standing in for an em dash.
# See CLAUDE.md for the constraints themselves.
#
# Usage:
#   scan-prose.sh              scan every tracked text file, minus three
#   scan-prose.sh FILE...      scan exactly these files
#
# Exit codes:
#   0  scanned cleanly, nothing matched
#   1  banned prose found
#   2  the scan could not run as asked (bad path, git unavailable)
#
# Exit 2 matters: a checker that cannot read its input must never look the same
# as a checker that read the input and found it clean.
set -euo pipefail

# Two groups. The first is this repo's own banned vocabulary. The second is
# the stock vocabulary that marks text as machine written. Words this project
# needs are deliberately absent from both: robust, invariant, harness, ensure,
# underscore. So are navigation and elevation, which are ordinary technical
# words, and foster, which rejects the surname and the phrase foster care.
#
# Two known limits, both accepted:
#   - Fenced code blocks are scanned like prose, so an identifier that matches
#     a banned word is rejected. Revisit if that starts to bite.
#   - The JSON half of the default file set covers rules/ only. Widen it when
#     prose-bearing JSON appears elsewhere.
#   - TypeScript sources are scanned, so a banned word in a comment fails the
#     gate. An identifier that matches one fails it too; rename the identifier.
PATTERN_REPO='\bgenuine(ly)?\b|\bdisciplin\w*\b|\bshap(e|es|ed|ing)\b|\binstinct\w*\b|\bsurfac(e|es|ed|ing)\b|\bbolt(ed)?[- ]on\b|\bcalls for\b|\brather than\b|—'
PATTERN_TELLS='\bdelv(e|es|ed|ing)\b|\bsubstrates?\b|\bload[- ]bearing\b|\btapestr(y|ies)\b|\btestaments?\b|\brealms?\b|\bnuanc(e|es|ed|ing)\b|\bplethora\b|\bmyriads?\b|\bmeticulous(ly)?\b|\bseamless(ly)?\b|\bintricate\b|\bprofound(ly)?\b|\bparadigms?\b|\bholistic(ally)?\b|\bcutting[- ]edge\b|\bgame[- ]chang(er|ing)\b|\bembark(s|ed|ing)?\b|\belevat(e|es|ed|ing)\b|\bunlock(s|ed|ing)?\b|\bpivotal(ly)?\b|\bcrucial\b|\blandscape\b|\bnavigat(e|es|ed|ing)\b|\butiliz(e|es|ed|ing|ation)\b|\bleverag(e|es|ed|ing)\b|\bdeep dive\b|\bdive into\b|\bworth noting\b'
# A spaced hyphen standing in for an em dash is a prose problem. In source it
# would match ordinary subtraction, so it applies to prose files only.
PATTERN_HYPHEN='[[:alpha:]] - [[:alpha:]]'
PATTERN_PROSE="$PATTERN_REPO|$PATTERN_TELLS|$PATTERN_HYPHEN"
PATTERN_CODE="$PATTERN_REPO|$PATTERN_TELLS"

pattern_for() {
  # Lowercased, so an uppercase extension is treated the same as a lower one.
  case "${1,,}" in
    *.ts|*.tsx|*.js|*.mjs|*.cjs|*.sh) printf '%s' "$PATTERN_CODE" ;;
    *) printf '%s' "$PATTERN_PROSE" ;;
  esac
}

die() {
  echo "scan-prose: $1" >&2
  exit 2
}

files=()
if [ "$#" -gt 0 ]; then
  # Explicit arguments: every one must resolve to a readable regular file.
  # A typo or a renamed file is an error, never a silent pass.
  for arg in "$@"; do
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
  # status visible and the bytes intact.
  tmpd=$(mktemp -d) || die "could not create a temporary directory"
  trap 'rm -rf "$tmpd"' EXIT
  # Anchor to the repo root. git resolves a pathspec against the current
  # directory, so running this from a subdirectory would quietly match fewer
  # files, or none, and still report a clean scan.
  if ! root=$(git rev-parse --show-toplevel 2>"$tmpd/err"); then
    die "not a git repository. git said: $(cat "$tmpd/err")"
  fi
  # --others --exclude-standard adds files that are not tracked yet and not
  # ignored. Without them a new file was never checked until after its first
  # commit, which is exactly when checking it still helps.
  # Three exclusions, each for a reason. This script holds every banned word
  # as a literal in its own pattern. The lockfile is generated. The licence
  # text is not ours to edit.
  if ! git -C "$root" ls-files -z --cached --others --exclude-standard -- \
      '*.md' '*.json' '*.ts' '*.sh' '.gitignore' '.gitattributes' 'NOTICE' \
      ':(exclude)scripts/scan-prose.sh' \
      ':(exclude)package-lock.json' \
      ':(exclude)LICENSE' >"$tmpd/list" 2>"$tmpd/err"; then
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
  set +e
  output=$(grep -inHE "$(pattern_for "$f")" -- "$f")
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
