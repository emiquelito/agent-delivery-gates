#!/usr/bin/env bash
# Checks markdown prose against this repo's writing constraints: banned words,
# banned patterns, em dashes, and a spaced hyphen standing in for an em dash.
# See CLAUDE.md for the constraints themselves.
#
# Usage:
#   scan-prose.sh              scan every tracked markdown file
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

PATTERN='\bgenuine(ly)?\b|\bdisciplin\w*\b|\bshap(e|es|ed|ing)\b|\binstinct\w*\b|\bsurfac(e|es|ed|ing)\b|\bbolt(ed)?[- ]on\b|\bcalls for\b|\brather than\b|—|[[:alpha:]] - [[:alpha:]]'

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
  # Newline delimited, not -z: command substitution strips null bytes, which
  # would silently join filenames together. git quotes odd paths by default.
  if ! tracked=$(git ls-files '*.md' 2>&1); then
    die "git ls-files failed, is this a git repository? git said: $tracked"
  fi
  if [ -n "$tracked" ]; then
    mapfile -t files <<< "$tracked"
  fi
  if [ "${#files[@]}" -eq 0 ]; then
    echo "scan-prose: no tracked markdown files to scan"
    exit 0
  fi
fi

matched_count=0
had_match=0

for f in "${files[@]}"; do
  set +e
  output=$(grep -inHE "$PATTERN" -- "$f")
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

echo "scan-prose: scanned ${#files[@]} file(s), $matched_count matched"

[ "$had_match" -eq 1 ] && exit 1
exit 0
