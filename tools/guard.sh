#!/usr/bin/env bash
# Stand-in for GitHub branch protection on main. A private repo on a personal account
# only gets enforced rulesets with GitHub Pro, so Claude Code sessions enforce the same
# rules here instead:
#   - nothing is pushed to main or master; changes land through a pull request
#   - no plain force pushes (--force, -f, +refspec); --force-with-lease on your own branch
#   - no --no-verify or core.hooksPath override on a push (they would skip .githooks/pre-push)
#   - GitHub MCP file writes (push_files, create_or_update_file, delete_file) never target main
# Merges are gated by the "ask" rules in .claude/settings.json, which make the merge tools
# prompt for approval. .githooks/pre-push is the backstop for pushes this script cannot see.
#
#   tools/guard.sh --install       SessionStart: point core.hooksPath at .githooks
#   tools/guard.sh --hook bash     PreToolUse on Bash/PowerShell: checks each `git push`
#   tools/guard.sh --hook github   PreToolUse on GitHub MCP file writes: checks the branch
#
# Hook modes read Claude Code's JSON on stdin and exit 2 with the reason on stderr to block.
# Needs only bash, awk and git (no jq), so it runs the same in Git Bash on Windows.
# Ported from the Delve repo, minus its gate that held every push until the full test suite
# had passed on that exact tree (add one here once this repo has tests).
set -uo pipefail

root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"

block() {
  printf '[guard] %s\n' "$1" >&2
  printf '[guard] main only changes through a merged pull request (stand-in for branch protection, see tools/guard.sh).\n' >&2
  exit 2
}

is_protected() {
  case "$1" in main|master) return 0 ;; esac
  return 1
}

# Value of the first "key": "string" pair in the hook JSON, with JSON escapes decoded.
# Escaped quotes inside other strings never match, so the first hit is the real key.
json_field() {
  printf '%s' "$input" | awk -v key="$1" '
    { s = s (NR > 1 ? "\n" : "") $0 }
    END {
      if (!match(s, "\"" key "\"[ \t\r\n]*:[ \t\r\n]*\"")) exit
      s = substr(s, RSTART + RLENGTH); n = length(s); out = ""
      for (i = 1; i <= n; i++) {
        c = substr(s, i, 1)
        if (c == "\"") break
        if (c == "\\") {
          i++; c = substr(s, i, 1)
          if (c == "n") c = "\n"
          else if (c == "t") c = "\t"
          else if (c == "r") c = "\r"
          else if (c == "b" || c == "f") c = " "
          else if (c == "u") { c = "?"; i += 4 }
        }
        out = out c
      }
      printf "%s", out
    }'
}

# Splits a shell command into words, one per line, honouring quotes and escapes, with a
# \034 line wherever a new command starts (; & | ( ) newline, and backticks in bash).
# ps=1 switches to PowerShell rules: backtick escapes, backslash is literal.
tokenize() {
  printf '%s' "$1" | awk -v ps="$2" '
    function flush() { if (intok) { gsub(/\n/, " ", tok); print tok; tok = ""; intok = 0 } }
    { s = s (NR > 1 ? "\n" : "") $0 }
    END {
      n = length(s); q = ""; tok = ""; intok = 0
      esc = (ps == "1") ? "`" : "\\"
      for (i = 1; i <= n; i++) {
        c = substr(s, i, 1)
        if (q == "\047") { if (c == "\047") q = ""; else tok = tok c; continue }
        if (q == "\"") {
          if (c == esc && i < n) { i++; tok = tok substr(s, i, 1); continue }
          if (c == "\"") q = ""; else tok = tok c
          continue
        }
        if (c == esc && i < n) { i++; c = substr(s, i, 1); if (c != "\n") { tok = tok c; intok = 1 }; continue }
        if (c == "\047" || c == "\"") { q = c; intok = 1; continue }
        if (c == " " || c == "\t" || c == "\r") { flush(); continue }
        if (c == "\n" || c == ";" || c == "&" || c == "|" || c == "(" || c == ")" || (c == "`" && ps != "1")) {
          flush(); print "\034"; continue
        }
        tok = tok c; intok = 1
      }
      flush()
    }'
}

resolve_dir() { # base dir, -C argument
  case "$2" in
    /*|[A-Za-z]:*|\\*) printf '%s' "$2" ;;
    *) if [ -n "$1" ]; then printf '%s/%s' "$1" "$2"; else printf '%s' "$2"; fi ;;
  esac
}

# Checks one command's words; blocks if any `git ... push` in it breaks a rule.
check_segment() {
  local -a w=("$@")
  local n=${#w[@]} g i a dir branch repo src dst r c
  for ((g = 0; g < n; g++)); do
    case "${w[g]}" in git|git.exe|*/git|*/git.exe|*\\git|*\\git.exe) ;; *) continue ;; esac
    dir="$cwd"
    local -a cfg=()
    i=$((g + 1))
    while [ "$i" -lt "$n" ]; do
      case "${w[i]}" in
        -C) dir="$(resolve_dir "$dir" "${w[i+1]:-}")"; i=$((i + 2)) ;;
        -c|--config-env) cfg+=("${w[i+1]:-}"); i=$((i + 2)) ;;
        --config-env=*) cfg+=("${w[i]#--config-env=}"); i=$((i + 1)) ;;
        --git-dir|--work-tree|--namespace|--exec-path) i=$((i + 2)) ;;
        -*) i=$((i + 1)) ;;
        *) break ;;
      esac
    done
    [ "${w[i]:-}" = push ] || continue

    for c in ${cfg[@]+"${cfg[@]}"}; do
      case "$(printf '%s' "$c" | tr '[:upper:]' '[:lower:]')" in
        core.hookspath*) block "git -c core.hooksPath=... on a push would skip .githooks/pre-push; push without it." ;;
      esac
    done

    local -a pos=()
    local force=0 noverify=0 all=0 tags=0 endopts=0
    repo=""
    for ((i = i + 1; i < n; i++)); do
      a="${w[i]}"
      if [ "$endopts" = 1 ]; then pos+=("$a"); continue; fi
      case "$a" in
        --) endopts=1 ;;
        --force) force=1 ;;
        --no-verify) noverify=1 ;;
        --all|--mirror|--branches) all=1 ;;
        --tags) tags=1 ;;
        --repo=*) repo="${a#--repo=}" ;;
        --repo) repo="${w[i+1]:-}"; i=$((i + 1)) ;;
        -o|--push-option|--receive-pack|--exec) i=$((i + 1)) ;;
        --*) ;;
        [0-9\<\>\*]*\>*|[0-9\<\>\*]*\<*|\>*|\<*)
          # A redirection (> log, 2>/dev/null): not a refspec; skip its target too.
          [[ "$a" =~ ^[0-9*]*[\<\>]+$ ]] && i=$((i + 1))
          ;;
        -?*)
          if [[ "$a" =~ ^-[A-Za-z0-9]+$ ]]; then
            case "$a" in *f*) force=1 ;; esac
            case "$a" in *o) i=$((i + 1)) ;; esac
          fi
          ;;
        *) pos+=("$a") ;;
      esac
    done

    [ "$noverify" = 1 ] && block "git push --no-verify would skip .githooks/pre-push; push without it."
    [ "$all" = 1 ] && block "git push --all/--mirror/--branches would push main too; push your branch by name."
    [ "$force" = 1 ] && block "plain force pushes are blocked. On your own branch use --force-with-lease; never rewrite main or someone else's branch."

    local -a refspecs=()
    if [ -n "$repo" ]; then
      refspecs=(${pos[@]+"${pos[@]}"})
    elif [ "${#pos[@]}" -gt 1 ]; then
      refspecs=("${pos[@]:1}")
    fi

    branch="$(git -C "${dir:-.}" symbolic-ref --short -q HEAD 2>/dev/null)"
    # With no refspec git pushes the current branch, except that --tags alone pushes tags.
    if [ "${#refspecs[@]}" -eq 0 ] && [ "$tags" = 0 ] && is_protected "$branch"; then
      block "this push has no branch named and the current branch is $branch. Work on a feature branch and push that."
    fi
    for r in ${refspecs[@]+"${refspecs[@]}"}; do
      case "$r" in +*) block "a +refspec ($r) is a force push. On your own branch use --force-with-lease." ;; esac
      [ "$r" = ":" ] && block "git push <remote> : pushes every matching branch, main included; push your branch by name."
      if [[ "$r" == *:* ]]; then src="${r%%:*}"; dst="${r#*:}"; else src="$r"; dst="$r"; fi
      [ -n "$dst" ] || dst="$src"
      case "$dst" in HEAD|@) dst="$branch" ;; esac
      dst="${dst#refs/heads/}"
      is_protected "$dst" && block "pushing to $dst is blocked. Push a feature branch and open a pull request."
      case "$dst" in *'*'*) block "wildcard refspec ($r) could push main; push your branch by name." ;; esac
    done
  done
  return 0
}

# Runs check_segment on every command in a command line, and recurses into the command
# string of a shell wrapper (bash -c "...", pwsh -Command "...", eval "...").
check_command() { # command line, ps flag
  local word
  local -a seg=()
  while IFS= read -r word; do
    if [ "$word" != $'\034' ]; then seg+=("$word"); continue; fi
    check_words "$2" ${seg[@]+"${seg[@]}"}
    seg=()
  done < <(tokenize "$1" "$2")
  check_words "$2" ${seg[@]+"${seg[@]}"}
}

check_words() { # ps flag, words...
  local wps="$1" k nested nps
  shift
  [ "$#" -gt 0 ] || return 0
  local -a w=("$@")
  check_segment "${w[@]}"
  for ((k = 0; k < ${#w[@]}; k++)); do
    nested=""
    case "${w[k]}" in
      eval|Invoke-Expression|iex) nested="${w[*]:k+1}"; nps="$wps" ;;
      sh|bash|zsh|dash|*/sh|*/bash|*/zsh|*/dash|bash.exe|*\\bash.exe|*/bash.exe)
        if [[ "${w[k+1]:-}" =~ ^-[A-Za-z]*c$ ]]; then nested="${w[k+2]:-}"; nps=0; fi ;;
      pwsh|powershell|pwsh.exe|powershell.exe|*\\pwsh.exe|*\\powershell.exe|*/pwsh)
        case "$(printf '%s' "${w[k+1]:-}" | tr '[:upper:]' '[:lower:]')" in
          -c|-command|-co|-com|-comm|-comma|-comman) nested="${w[k+2]:-}"; nps=1 ;;
        esac ;;
    esac
    case "$nested" in *push*) check_command "$nested" "$nps" ;; esac
  done
  return 0
}

mode=""
case "${1:-}" in
  --install) mode=install ;;
  --hook) mode="${2:-}" ;;
esac

case "$mode" in
  install)
    cd "$root" 2>/dev/null || exit 0
    git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
    current="$(git config --get core.hooksPath)"
    # Git reads a relative hooksPath from the top of the work tree, so compare where both lead.
    if [ -z "$current" ]; then
      git config core.hooksPath .githooks
    elif [ "$(cd "$current" 2>/dev/null && pwd -P)" != "$(cd .githooks && pwd -P)" ]; then
      echo "[guard] core.hooksPath is '$current', so .githooks/pre-push (the push-to-main backstop) is not active in this clone."
    fi
    exit 0
    ;;
  bash)
    input="$(cat)"
    case "$input" in *push*) ;; *) exit 0 ;; esac
    cmd="$(json_field command)"
    cwd="$(json_field cwd)"
    ps=0
    [ "$(json_field tool_name)" = PowerShell ] && ps=1
    check_command "$cmd" "$ps"
    exit 0
    ;;
  github)
    input="$(cat)"
    tool="$(json_field tool_name)"
    case "$tool" in
      *__push_files|*__create_or_update_file|*__delete_file)
        b="$(json_field branch)"
        b="${b#refs/heads/}"
        [ -n "$b" ] || block "$tool names no branch, and GitHub would write to main. Name a feature branch."
        is_protected "$b" && block "$tool to $b is blocked. Write to a feature branch and open a pull request."
        ;;
    esac
    exit 0
    ;;
  *)
    echo "usage: tools/guard.sh --install | --hook bash|github" >&2
    exit 1
    ;;
esac
