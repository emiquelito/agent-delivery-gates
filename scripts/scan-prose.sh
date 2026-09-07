#!/usr/bin/env bash
# Scans tracked markdown prose for banned words, banned patterns, and em
# dashes. See CLAUDE.md for the writing constraints this enforces.
set -euo pipefail

PATTERN='\bgenuine(ly)?\b|\bdisciplin\w*\b|\bshap(e|es|ed|ing)\b|\binstinct\w*\b|\bsurfac(e|es|ed|ing)\b|\bbolt(ed)?[- ]on\b|\bcalls for\b|\brather than\b|—'

if [ "$#" -gt 0 ]; then
  files=("$@")
else
  # No arguments: scan tracked markdown files only.
  mapfile -t files < <(git ls-files '*.md')
fi

scanned_count=0
matched_count=0
had_match=0

for f in "${files[@]}"; do
  [ -f "$f" ] || continue
  scanned_count=$((scanned_count + 1))

  set +e
  output=$(grep -nE "$PATTERN" -- "$f")
  status=$?
  set -e

  if [ "$status" -eq 0 ]; then
    matched_count=$((matched_count + 1))
    had_match=1
    printf '%s\n' "$output"
  elif [ "$status" -ne 1 ]; then
    echo "scan-prose: error reading $f" >&2
    exit 2
  fi
done

echo "scan-prose: scanned $scanned_count file(s), $matched_count matched"

if [ "$had_match" -eq 1 ]; then
  exit 1
fi

exit 0
