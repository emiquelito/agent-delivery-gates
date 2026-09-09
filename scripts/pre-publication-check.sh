#!/usr/bin/env bash
# Gate that must pass before this repository goes from private to public.
# Runs every check in sequence, prints a clear pass, fail, or skipped marker
# for each, and only then decides the overall result.
#
# Exit codes:
#   0  every check passed, and none was skipped
#   1  at least one check failed, or at least one was skipped (a skipped
#      check makes the run incomplete, which is not the same as clean)
#   2  the script could not run as asked: not a git repository, .gitignore
#      missing or unreadable, or the working notes directory's name could
#      not be determined from it
#
# Exit 2 matters for the same reason it matters in scripts/scan-prose.sh: a
# gate that could not run must never look the same as a gate that ran and
# found everything clean.
#
# This script must never write anything sensitive into itself: no forbidden
# name, no username, no home directory path, and no name of the working
# notes directory. Everything of that kind comes from the environment or
# from reading .gitignore at runtime.
set -euo pipefail

# Strip every GIT_* override before running any git command, the way the
# rest of this repo's tools do (see src/clean-tree-gate.ts). A leftover
# GIT_DIR or GIT_WORK_TREE from the calling shell would point git at a
# different tree than the one this script is meant to check.
# compgen -v lists variable NAMES and never reads a value, so a value
# holding a newline cannot break the parse. It is a bash builtin present in
# bash 3.2, which is what macOS ships, and needs no GNU env.
for name in $(compgen -v GIT_); do unset "$name"; done

die() {
  echo "pre-publication-check: $1" >&2
  exit 2
}

tmpd=$(mktemp -d) || die "could not create a temporary directory"
trap 'rm -rf "$tmpd"' EXIT

# Resolve the repository root from wherever this script is run, so it works
# the same from a subfolder as from the root.
if ! ROOT=$(git rev-parse --show-toplevel 2>"$tmpd/err"); then
  die "not a git repository. git said: $(cat "$tmpd/err")"
fi

GITIGNORE="$ROOT/.gitignore"
[ -f "$GITIGNORE" ] || die "'$GITIGNORE' does not exist; cannot find the working notes directory"

# The working notes directory's name is never written into this script. It
# is read here, from the last non-comment, non-blank line in .gitignore
# that ends in a slash: the convention this repository's own .gitignore
# follows for it, and the convention every fixture built for this script's
# tests follows too.
NOTES_DIR=$(grep -vE '^[[:space:]]*#' "$GITIGNORE" | grep -vE '^[[:space:]]*$' | grep '/$' | tail -1)
NOTES_DIR=${NOTES_DIR%/}
NOTES_DIR=${NOTES_DIR#/}
[ -n "$NOTES_DIR" ] || die "could not find the working notes directory's name in '$GITIGNORE'"

overall_failed=0
overall_skipped=0

pass() {
  echo "PASS  [$1] $2"
}

fail() {
  echo "FAIL  [$1] $2"
  overall_failed=1
}

skip() {
  echo "SKIP  [$1] $2"
  overall_skipped=1
}

# A check nobody asked for. Distinct from SKIP, which means a check that was
# meant to run and could not, and which makes the whole run incomplete. This
# one ran exactly as configured, so it leaves the verdict alone.
off() {
  echo "OFF   [$1] $2"
}

# --- check 1: no commit ever added a file under the notes directory --------

check_notes_dir_history() {
  local id="1" name="no commit ever added a file under the working notes directory"
  local added hit=""
  if ! added=$(git -C "$ROOT" log --all --diff-filter=A --name-only --pretty=format: 2>"$tmpd/err"); then
    fail "$id" "$name: git log failed: $(cat "$tmpd/err")"
    return
  fi
  while IFS= read -r path; do
    [ -z "$path" ] && continue
    case "$path" in
      "$NOTES_DIR"/*|"$NOTES_DIR")
        hit="$path"
        break
        ;;
    esac
  done <<<"$added"
  if [ -n "$hit" ]; then
    fail "$id" "$name: a commit added '$hit'. A file deleted later is still readable at the commit that added it, so removing it now does not clear this."
  else
    pass "$id" "$name"
  fi
}

# --- check 2: no commit message carries AI attribution ---------------------

check_no_ai_attribution() {
  local id="2" name="no commit message carries AI attribution"
  # Off unless asked for. Whether a commit message names the tool that helped
  # write it is a decision for the person making the commit, and a check that
  # fails somebody's history over it is in the way, not in service.
  # Set ADG_CHECK_AI_ATTRIBUTION=1 to turn it on.
  if [ -z "${ADG_CHECK_AI_ATTRIBUTION:-}" ]; then
    off "$id" "$name: not requested. Set ADG_CHECK_AI_ATTRIBUTION=1 to run it."
    return
  fi
  # Deliberately narrow: a co-authored-by line naming an assistant vendor, the
  # phrase "generated with", or the robot emoji. Grepping for a bare vendor
  # word would also catch an ordinary commit message that names a file such
  # as CLAUDE.md; this pattern only fires on the attribution phrasing itself.
  local combined='^co-authored-by:.*(claude|anthropic|chatgpt|copilot|openai|gpt-?[0-9])|generated with|🤖'
  local hit=""
  while IFS= read -r -d '' block; do
    local commit_hash="${block%%$'\n'*}"
    local body="${block#*$'\n'}"
    if printf '%s\n' "$body" | grep -qiE "$combined"; then
      hit="$commit_hash"
      break
    fi
  done < <(git -C "$ROOT" log --all -z --pretty=format:'%H%n%B' 2>"$tmpd/err") \
    || true
  if [ -s "$tmpd/err" ]; then
    fail "$id" "$name: git log failed: $(cat "$tmpd/err")"
    return
  fi
  if [ -n "$hit" ]; then
    fail "$id" "$name: commit $hit carries AI attribution in its message"
  else
    pass "$id" "$name"
  fi
}

# --- shared: a home directory path -----------------------------------------

# A path that names somebody. /home/NAME and /Users/NAME both carry an
# account name, so both are caught. A bare ~/ is not here on purpose: it is
# the anonymous form of a home path, carries no account name and no machine
# name, and documenting where a tool keeps its config, ~/.codex/config.toml
# for one, is the correct thing to write. Catching it stopped the whole
# publication check on a line that leaked nothing.
home_path_pattern() {
  printf '%s' '(^|[^A-Za-z0-9_.-])(/home/[A-Za-z0-9_.-]+|/Users/[A-Za-z0-9_.-]+)'
}

# --- check 3: no commit message carries a personal path --------------------

check_no_personal_path_in_messages() {
  local id="3" name="no commit message carries a personal path"
  local pattern hit=""
  pattern=$(home_path_pattern)
  while IFS= read -r -d '' block; do
    local commit_hash="${block%%$'\n'*}"
    local body="${block#*$'\n'}"
    if printf '%s\n' "$body" | grep -qE "$pattern"; then
      hit="$commit_hash"
      break
    fi
  done < <(git -C "$ROOT" log --all -z --pretty=format:'%H%n%B' 2>"$tmpd/err") \
    || true
  if [ -s "$tmpd/err" ]; then
    fail "$id" "$name: git log failed: $(cat "$tmpd/err")"
    return
  fi
  if [ -n "$hit" ]; then
    fail "$id" "$name: commit $hit's message carries a home directory path"
  else
    pass "$id" "$name"
  fi
}

# --- check 4: no tracked file points at the working notes directory --------

check_no_tracked_reference_to_notes_dir() {
  local id="4" name="no tracked file points at the working notes directory"
  local status
  set +e
  git -C "$ROOT" grep -InF -- "$NOTES_DIR" -- ':!.gitignore' >"$tmpd/hit4" 2>"$tmpd/err4"
  status=$?
  set -e
  case "$status" in
    0)
      fail "$id" "$name, apart from the one ignore rule that has to name it: $(head -1 "$tmpd/hit4")"
      ;;
    1)
      pass "$id" "$name"
      ;;
    *)
      fail "$id" "$name: git grep failed: $(cat "$tmpd/err4")"
      ;;
  esac
}

# --- check 5: no tracked file carries a home path, machine name, username --

check_no_tracked_personal_data() {
  local id="5" name="no tracked file carries a home directory path, a machine name, or a username"
  local home_pattern status hit=""
  home_pattern=$(home_path_pattern)

  # scripts/pre-publication-check.sh is excluded from the home-path search
  # only: this file has to name that pattern to check for it, the same
  # reason scripts/scan-prose.sh excludes itself from its own scan.
  set +e
  git -C "$ROOT" grep -InE -- "$home_pattern" -- ':!scripts/pre-publication-check.sh' \
    >"$tmpd/hit5a" 2>"$tmpd/err5a"
  status=$?
  set -e
  case "$status" in
    0) hit=$(head -1 "$tmpd/hit5a") ;;
    1) ;;
    *) fail "$id" "$name: git grep failed: $(cat "$tmpd/err5a")"; return ;;
  esac

  local username
  username=$(id -un 2>/dev/null || printf '%s' "${USER:-${LOGNAME:-}}")
  if [ -z "$hit" ] && [ -n "$username" ]; then
    set +e
    git -C "$ROOT" grep -InFw -- "$username" >"$tmpd/hit5b" 2>"$tmpd/err5b"
    status=$?
    set -e
    case "$status" in
      0) hit=$(head -1 "$tmpd/hit5b") ;;
      1) ;;
      *) fail "$id" "$name: git grep failed: $(cat "$tmpd/err5b")"; return ;;
    esac
  fi

  local machine
  machine=$(hostname 2>/dev/null || printf '%s' "${HOSTNAME:-}")
  if [ -z "$hit" ] && [ -n "$machine" ]; then
    set +e
    git -C "$ROOT" grep -InFw -- "$machine" >"$tmpd/hit5c" 2>"$tmpd/err5c"
    status=$?
    set -e
    case "$status" in
      0) hit=$(head -1 "$tmpd/hit5c") ;;
      1) ;;
      *) fail "$id" "$name: git grep failed: $(cat "$tmpd/err5c")"; return ;;
    esac
  fi

  if [ -n "$hit" ]; then
    fail "$id" "$name: $hit"
  else
    pass "$id" "$name"
  fi
}

# --- check 6: no forbidden name anywhere ------------------------------------

check_forbidden_names() {
  local id="6" name="no forbidden name appears in tracked files or in history"
  # Every expansion of an array below is written ${a[@]+"${a[@]}"} and not
  # "${a[@]}". Under set -u, bash before 4.4 treats an empty array expanded
  # the second way as an unbound variable and aborts. macOS ships 3.2, and
  # the empty case here is the ordinary one: no names configured is what the
  # SKIP branch below is for, so the plain form aborted the whole run on a
  # Mac before it could print that.
  local names=()
  if [ -n "${ADG_FORBIDDEN_NAMES:-}" ]; then
    IFS=',' read -r -a raw <<<"${ADG_FORBIDDEN_NAMES//$'\n'/,}"
    for n in ${raw[@]+"${raw[@]}"}; do
      n="${n#"${n%%[![:space:]]*}"}"
      n="${n%"${n##*[![:space:]]}"}"
      [ -n "$n" ] && names+=("$n")
    done
  elif [ -n "${ADG_FORBIDDEN_NAMES_FILE:-}" ]; then
    # A names file that is not there means this run was asked for something it
    # cannot do. That is exit 2, not a failed check, and never a quiet pass.
    if [ ! -f "$ADG_FORBIDDEN_NAMES_FILE" ] || [ ! -r "$ADG_FORBIDDEN_NAMES_FILE" ]; then
      echo "pre-publication-check: cannot read ADG_FORBIDDEN_NAMES_FILE '$ADG_FORBIDDEN_NAMES_FILE'" >&2
      exit 2
    fi
    while IFS= read -r line || [ -n "$line" ]; do
      case "${line#"${line%%[![:space:]]*}"}" in
        '#'*) continue ;;
      esac
      IFS=',' read -r -a parts <<<"$line"
      for n in ${parts[@]+"${parts[@]}"}; do
        n="${n#"${n%%[![:space:]]*}"}"
        n="${n%"${n##*[![:space:]]}"}"
        [ -n "$n" ] && names+=("$n")
      done
    done <"$ADG_FORBIDDEN_NAMES_FILE"
  fi

  # A name that reads as a placeholder means this check ran against an
  # example and proved nothing. That is worse than not running it, because it
  # prints PASS. It happened on the first real use of this script.
  local placeholders=""
  for n in ${names[@]+"${names[@]}"}; do
    case "$(printf '%s' "$n" | tr '[:upper:]' '[:lower:]')" in
      your-*|your_*|my-*|my_*|a-client*|an-employer*|a-codename*|*example*|*placeholder*|*changeme*|*todo*|foo|bar|baz|name1|name2)
        placeholders="${placeholders:+$placeholders, }$n" ;;
    esac
  done
  if [ -n "$placeholders" ]; then
    skip "$id" "$name: these read as placeholders, not real names: $placeholders. This check would print a pass having looked for nothing. Put the real names in and run it again. If a real name truly looks like this, rename the entry in your list."
    return
  fi

  if [ "${#names[@]}" -eq 0 ]; then
    skip "$id" "$name: no names configured. Set ADG_FORBIDDEN_NAMES (comma separated) or ADG_FORBIDDEN_NAMES_FILE (one per line, blank lines and lines starting with # ignored) to run this check. A skipped check makes the run incomplete, not clean."
    return
  fi

  local hit=""
  local where=""
  for n in ${names[@]+"${names[@]}"}; do
    set +e
    git -C "$ROOT" grep -InF -- "$n" >"$tmpd/hit6" 2>"$tmpd/err6"
    local status=$?
    set -e
    if [ "$status" -eq 0 ]; then
      hit="$n"
      where="tracked file: $(head -1 "$tmpd/hit6")"
      break
    elif [ "$status" -gt 1 ]; then
      fail "$id" "$name: git grep failed: $(cat "$tmpd/err6")"
      return
    fi

    while IFS= read -r -d '' block; do
      local commit_hash="${block%%$'\n'*}"
      local body="${block#*$'\n'}"
      if printf '%s\n' "$body" | grep -qF -- "$n"; then
        hit="$n"
        where="commit $commit_hash's message. A name found only in history cannot be removed by deleting a file; the commit that carries it has to be dropped from every ref, and the ref rewritten."
        break
      fi
    done < <(git -C "$ROOT" log --all -z --pretty=format:'%H%n%B' 2>"$tmpd/err6b") || true
    [ -n "$hit" ] && break
  done

  if [ -n "$hit" ]; then
    fail "$id" "$name: forbidden name found in $where"
  else
    pass "$id" "$name: checked ${#names[@]} name(s), none found"
  fi
}

# --- check 7: local settings are not tracked --------------------------------

check_local_settings_not_tracked() {
  local id="7" name="local settings are not tracked"
  local tracked
  tracked=$(git -C "$ROOT" ls-files -- '.claude/settings.local.json' '.claude/adg-phase')
  if [ -n "$tracked" ]; then
    fail "$id" "$name: $(printf '%s' "$tracked" | tr '\n' ' ') is tracked"
  else
    pass "$id" "$name"
  fi
}

# --- check 8: the prose scan passes -----------------------------------------

check_prose_scan() {
  local id="8" name="the prose scan passes"
  local scanner="$ROOT/scripts/scan-prose.sh"
  if [ ! -x "$scanner" ] && [ ! -f "$scanner" ]; then
    fail "$id" "$name: '$scanner' not found"
    return
  fi
  set +e
  local output
  output=$(bash "$scanner" 2>&1)
  local status=$?
  set -e
  case "$status" in
    0) pass "$id" "$name" ;;
    1) fail "$id" "$name: $(printf '%s' "$output" | tail -3 | tr '\n' ' ')" ;;
    *) fail "$id" "$name: the prose scan could not run: $(printf '%s' "$output" | tail -3 | tr '\n' ' ')" ;;
  esac
}

echo "pre-publication-check: repository root $ROOT"
echo "pre-publication-check: working notes directory '$NOTES_DIR'"
echo

check_notes_dir_history
check_no_ai_attribution
check_no_personal_path_in_messages
check_no_tracked_reference_to_notes_dir
check_no_tracked_personal_data
check_forbidden_names
check_local_settings_not_tracked
check_prose_scan

echo
if [ "$overall_failed" -eq 1 ]; then
  echo "pre-publication-check: FAILED"
  exit 1
fi
if [ "$overall_skipped" -eq 1 ]; then
  echo "pre-publication-check: INCOMPLETE (a check was skipped)"
  exit 1
fi
echo "pre-publication-check: PASSED"
exit 0
