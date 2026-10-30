#!/usr/bin/env bash
# Stand-in for GitHub branch protection on main. A private repo on a personal account
# only gets enforced rulesets with GitHub Pro, so Claude Code sessions enforce the same
# rules here instead:
#   - nothing is pushed to main or master; main changes only through the route CLAUDE.md
#     names under "Project facts", "How a change ships" (a merged pull request, or a land step)
#   - no plain force pushes (--force, -f, +refspec); --force-with-lease on your own branch
#   - no --no-verify or core.hooksPath override on a push (they would skip .githooks/pre-push)
#   - GitHub MCP file writes (push_files, create_or_update_file, delete_file) never target main
# Merges are gated by the scheme's approval rules, which make the merge tools prompt for
# approval. .githooks/pre-push is the backstop for pushes this script cannot see.
#
#   tools/guard.sh --install       SessionStart: point core.hooksPath at .githooks
#   tools/guard.sh --hook bash     PreToolUse on Bash/PowerShell: checks each `git push`
#   tools/guard.sh --hook github   PreToolUse on GitHub MCP file writes: checks the branch
#   tools/guard.sh --self-test     runs both hook modes on known commands; 0 when all pass
#
# Hook modes read Claude Code's JSON on stdin and exit 2 with the reason on stderr to block.
# Needs only bash, awk and git (no jq), so it runs the same in Git Bash on Windows.
set -uo pipefail

root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"

block() {
  printf '[guard] %s\n' "$1" >&2
  printf '[guard] main only changes through the route in CLAUDE.md, Project facts, "How a change ships" (see tools/guard.sh).\n' >&2
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

# Splits a shell command into words, one per line, honouring quotes, escapes and comments,
# with a \034 line wherever a new command starts (; & | ( ) newline, and backticks in bash).
# A word holding $, a backtick, ( or a {a,b} brace list outside single quotes gets a \035 in
# it: the shell fills it in at run time, so the guard cannot know what it names.
# ps=1 switches to PowerShell rules: backtick escapes, backslash is literal, <# #> comments.
# ps=2 is cmd.exe: ^ escapes, and no single quotes, comments or backtick substitution.
tokenize() {
  printf '%s' "$1" | awk -v ps="$2" '
    function flush() { if (intok) { gsub(/\n/, " ", tok); print tok; tok = ""; intok = 0 } }
    { s = s (NR > 1 ? "\n" : "") $0 }
    END {
      n = length(s); q = ""; tok = ""; intok = 0
      esc = (ps == "1") ? "`" : (ps == "2") ? "^" : "\\"
      for (i = 1; i <= n; i++) {
        c = substr(s, i, 1)
        if (q == "\047") { if (c == "\047") q = ""; else tok = tok c; continue }
        if (q == "\"") {
          if (c == esc && i < n) { i++; tok = tok substr(s, i, 1); continue }
          if (c == "$" || (c == "`" && ps == "0")) tok = tok "\035"
          if (c == "\"") q = ""; else tok = tok c
          continue
        }
        if (c == esc && i < n) { i++; c = substr(s, i, 1); if (c != "\n") { tok = tok c; intok = 1 }; continue }
        if ((c == "\047" && ps != "2") || c == "\"") { q = c; intok = 1; continue }
        if (c == " " || c == "\t" || c == "\r") { flush(); continue }
        # A # that starts a word opens a comment up to the end of the line; main#x is a word.
        if (c == "#" && !intok && ps != "2") { while (i < n && substr(s, i + 1, 1) != "\n") i++; continue }
        if (ps == "1" && c == "<" && !intok && substr(s, i + 1, 1) == "#") {
          j = index(substr(s, i + 2), "#>"); i = j ? i + j + 2 : n; continue
        }
        if (c == "(" || (c == "`" && ps == "0")) { tok = tok "\035"; intok = 1 }
        if (c == "\n" || c == ";" || c == "&" || c == "|" || c == "(" || c == ")" || (c == "`" && ps == "0")) {
          flush(); print "\034"; continue
        }
        if (c == "$") tok = tok "\035"
        if (c == "{" && ps == "0" && match(substr(s, i), /^\{[^ \t\r\n;&|()<>]*\}/) && substr(s, i + 1, RLENGTH - 2) ~ /,|\.\./) tok = tok "\035"
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
    for c in ${cfg[@]+"${cfg[@]}"}; do
      case "$(printf '%s' "$c" | tr '[:upper:]' '[:lower:]')" in
        alias.*) block "git -c alias.* can hide a push from this guard; run the git command itself." ;;
        core.hookspath*) [ "${w[i]:-}" = push ] && block "git -c core.hooksPath=... on a push would skip .githooks/pre-push; push without it." ;;
      esac
    done
    [ "${w[i]:-}" = push ] || continue

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

    case "$dir" in
      *$'\035'*) branch=$'\035' ;; # git -C "$X": which repo, and so which branch, is unknown
      *) branch="$(git -C "${dir:-.}" symbolic-ref --short -q HEAD 2>/dev/null)" ;;
    esac
    # With no refspec git pushes the current branch, except that --tags alone pushes tags.
    if [ "${#refspecs[@]}" -eq 0 ] && [ "$tags" = 0 ]; then
      [ "$branch" = $'\035' ] && block "git -C names its repo with \$VAR or \$(...), so the guard cannot see which branch this push sends. Write the path or the branch out."
      is_protected "$branch" && block "this push has no branch named and the current branch is $branch. Work on a feature branch and push that."
    fi
    for r in ${pos[@]+"${pos[@]}"}; do
      case "$r" in *$'\035'*) block "this push names its remote or branch with \$VAR, \$(...) or backticks, which only resolve when it runs. Write the names out (git push origin HEAD pushes the current branch)." ;; esac
    done
    for r in ${refspecs[@]+"${refspecs[@]}"}; do
      case "$r" in +*) block "a +refspec ($r) is a force push. On your own branch use --force-with-lease." ;; esac
      [ "$r" = ":" ] && block "git push <remote> : pushes every matching branch, main included; push your branch by name."
      if [[ "$r" == *:* ]]; then src="${r%%:*}"; dst="${r#*:}"; else src="$r"; dst="$r"; fi
      [ -n "$dst" ] || dst="$src"
      case "$dst" in HEAD|@) dst="$branch" ;; esac
      [ "$dst" = $'\035' ] && block "git -C names its repo with \$VAR or \$(...), so the guard cannot see which branch HEAD is. Write the path or the branch out."
      dst="${dst#refs/heads/}"
      is_protected "$dst" && block "pushing to $dst is blocked. Push your own branch."
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
  local wps="$1" k j nested nps
  shift
  [ "$#" -gt 0 ] || return 0
  local -a w=("$@")
  check_segment "${w[@]}"
  for ((k = 0; k < ${#w[@]}; k++)); do
    nested=""
    case "${w[k]}" in
      eval|Invoke-Expression|iex) nested="${w[*]:k+1}"; nps="$wps" ;;
      sh|bash|zsh|dash|*/sh|*/bash|*/zsh|*/dash|bash.exe|*\\bash.exe|*/bash.exe)
        # -c may follow other options (--norc -c, -e -c, -ec): check each later word.
        for ((j = k + 1; j < ${#w[@]}; j++)); do
          [[ "${w[j]}" =~ ^-[A-Za-z]*c[A-Za-z]*$ ]] || continue
          for ((j = j + 1; j < ${#w[@]}; j++)); do
            case "${w[j]}" in *push*) check_command "${w[j]}" 0 ;; esac
          done
        done ;;
      # pwsh -Command joins all its remaining words into one command, wherever it comes.
      pwsh|powershell|pwsh.exe|powershell.exe|*\\pwsh.exe|*\\powershell.exe|*/pwsh) nested="${w[*]:k+1}"; nps=1 ;;
      cmd|cmd.exe|*\\cmd.exe|*/cmd.exe) nested="${w[*]:k+1}"; nps=2 ;;
    esac
    case "$nested" in *push*) check_command "$nested" "$nps" ;; esac
  done
  return 0
}

# Runs the hook modes on known commands: tools/guard.sh --self-test exits 0 when all pass.
# Add a line here for every gap you close or false block you fix.
self_test() {
  local b pass=0 fail=0 # tmp stays global for the EXIT trap
  # Run from a git hook, git exports GIT_DIR and friends, which would point the scratch repos
  # below (and their HEAD and config) at the repo being pushed.
  unset $(git rev-parse --local-env-vars)
  tmp="$(mktemp -d)" || exit 1
  trap 'rm -rf "$tmp"' EXIT
  for b in main topic; do
    git init -q "$tmp/on-$b" && git -C "$tmp/on-$b" symbolic-ref HEAD "refs/heads/$b" || exit 1
  done
  run() { # expected exit, hook, JSON
    local got
    printf '%s' "$3" | bash "$0" --hook "$2" 2>/dev/null
    got=$?
    if [ "$got" = "$1" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); printf 'FAIL: wanted %s, got %s: %s\n' "$1" "$got" "$3"; fi
  }
  t() { # expected exit, tool (Bash|PowerShell), branch of the cwd (main|topic), command
    local c="$4"
    c="${c//\\/\\\\}"; c="${c//\"/\\\"}"; c="${c//$'\n'/\\n}"; c="${c//$'\t'/\\t}"
    run "$1" bash "{\"tool_name\":\"$2\",\"tool_input\":{\"command\":\"$c\"},\"cwd\":\"$tmp/on-$3\"}"
  }
  # Allowed.
  t 0 Bash topic 'git push origin topic'
  t 0 Bash topic 'git push -u origin topic'
  t 0 Bash topic 'git push'
  t 0 Bash topic 'git push origin HEAD'
  t 0 Bash topic 'git push origin HEAD:refs/heads/topic'
  t 0 Bash topic 'git push --force-with-lease origin topic'
  t 0 Bash main 'git push --tags origin'
  t 0 Bash topic 'git push origin topic 2>&1 | tail -5'
  t 0 Bash topic 'git push origin topic > "$LOG"'
  t 0 Bash topic 'git -C "$PWD" push origin topic'
  t 0 Bash topic 'echo "git push origin main"'
  t 0 Bash topic 'git commit -m "push to main later" && git push origin topic'
  t 0 Bash topic $'git commit -m "$(cat <<\'EOF\'\nDon\'t push to main\nEOF\n)" && git push -u origin topic'
  t 0 Bash topic 'git push origin topic # then main'
  t 0 Bash topic 'git push origin topic;# main'
  t 0 Bash topic 'git push origin main#x'
  t 0 Bash topic 'git push origin "topic#main"'
  t 0 Bash topic 'B=main; git push origin topic'
  t 0 Bash topic '(git push origin topic) && echo {a,b} $((1 + 2))'
  t 0 Bash topic 'bash -c "git push origin topic"'
  t 0 PowerShell topic 'git push origin topic'
  t 0 PowerShell topic 'git push origin topic <# main #>'
  t 0 PowerShell topic 'git push origin topic # main'
  # Pushes to main, force pushes and hook bypasses.
  t 2 Bash topic 'git push origin main'
  t 2 Bash topic 'git push origin master'
  t 2 Bash topic 'git push origin "main"'
  t 2 Bash topic 'git push origin HEAD:main'
  t 2 Bash topic 'git push origin topic:refs/heads/main'
  t 2 Bash topic 'git push origin :main'
  t 2 Bash main 'git push'
  t 2 Bash main 'git push origin'
  t 2 Bash main 'git push origin HEAD'
  t 2 Bash topic 'git -C ../on-main push origin HEAD'
  t 2 Bash topic 'git push origin +topic'
  t 2 Bash topic 'git push --force origin topic'
  t 2 Bash topic 'git push -f origin topic'
  t 2 Bash topic 'git push -uf origin topic'
  t 2 Bash topic 'git push --no-verify origin topic'
  t 2 Bash topic 'git -c core.hooksPath=/dev/null push origin topic'
  t 2 Bash topic 'git push --all origin'
  t 2 Bash topic 'git push origin :'
  t 2 Bash topic "git push origin 'refs/heads/*:refs/heads/*'"
  t 2 Bash topic 'echo ok && git push origin main'
  t 2 Bash topic '(git push origin main)'
  t 2 Bash topic $'git push origin topic # fine\ngit push origin main'
  # Shell wrappers.
  t 2 Bash topic 'eval "git push origin main"'
  t 2 Bash topic 'bash -c "git push origin main"'
  t 2 Bash topic "sh -c 'git push origin main'"
  t 2 Bash topic 'bash --norc -c "git push origin main"'
  t 2 Bash topic 'bash -e -c "git push origin main"'
  t 2 Bash topic 'bash -ec "git push origin main"'
  t 2 Bash topic 'env FOO=1 /bin/bash -o pipefail -lc "git push origin main"'
  t 2 Bash topic 'pwsh -Command "git push origin main"'
  t 2 Bash topic 'pwsh -NoProfile -NonInteractive -Command "git push origin main"'
  t 2 Bash topic 'powershell.exe -ExecutionPolicy Bypass -c "git push origin main"'
  t 2 Bash topic 'cmd //c git push origin main'
  t 2 Bash topic 'cmd /c "echo # & git push origin main"'
  t 2 Bash topic "cmd /c \"echo ' & git push origin main\""
  t 2 PowerShell topic 'git push origin main'
  t 2 PowerShell topic 'git push origin topic; git push origin main'
  t 2 PowerShell topic 'git push origin topic <# x #> main'
  # Names that only resolve at run time.
  t 2 Bash topic 'git push origin $(echo main)'
  t 2 Bash topic 'git push origin `echo main`'
  t 2 Bash topic 'git push origin $BRANCH'
  t 2 Bash topic 'git push origin "${BRANCH}"'
  t 2 Bash topic 'git push origin "$(git branch --show-current)"'
  t 2 Bash topic 'git push origin HEAD:$B'
  t 2 Bash topic 'git push $REMOTE topic'
  t 2 Bash topic "bash -c 'git push origin \$B'"
  t 2 PowerShell topic 'git push origin $branch'
  t 2 PowerShell topic 'git push origin ($b)'
  t 2 PowerShell topic 'git push origin (git branch --show-current)'
  t 2 Bash topic 'git push origin {topic,main}'
  t 2 Bash topic 'git push origin topic:{main,x}'
  t 0 Bash topic 'git push origin "{topic,main}"'
  t 2 Bash topic 'git -C "$R" push origin HEAD'
  t 2 Bash topic 'git -C "$R" push'
  t 0 Bash topic 'git -C "$R" push origin topic'
  t 2 Bash topic 'git -c alias.p=push p origin main'
  # GitHub MCP file writes.
  run 0 github '{"tool_name":"mcp__github__push_files","tool_input":{"branch":"topic"}}'
  run 2 github '{"tool_name":"mcp__github__push_files","tool_input":{"branch":"main"}}'
  run 2 github '{"tool_name":"mcp__github__create_or_update_file","tool_input":{"branch":"refs/heads/master"}}'
  run 2 github '{"tool_name":"mcp__github__delete_file","tool_input":{"path":"x"}}'
  # The self-test itself, as a git hook runs it: it must pass and leave that hook's repo alone.
  if [ -z "${GUARD_SELF_TEST_NESTED:-}" ]; then
    git init -q "$tmp/real" && git -C "$tmp/real" symbolic-ref HEAD refs/heads/mine
    if GUARD_SELF_TEST_NESTED=1 GIT_DIR="$tmp/real/.git" GIT_WORK_TREE="$tmp/real" bash "$0" --self-test >/dev/null &&
      [ "$(git -C "$tmp/real" symbolic-ref HEAD)" = refs/heads/mine ] &&
      [ "$(git -C "$tmp/real" config --get core.bare)" = false ]; then
      pass=$((pass + 1))
    else
      fail=$((fail + 1)); echo "FAIL: --self-test under GIT_DIR failed or changed that repo's HEAD or core.bare"
    fi
  fi
  echo "[guard] self-test: $pass passed, $fail failed"
  [ "$fail" = 0 ]
}

mode=""
case "${1:-}" in
  --install) mode=install ;;
  --self-test) self_test; exit ;;
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
        is_protected "$b" && block "$tool to $b is blocked. Write to your own branch."
        ;;
    esac
    exit 0
    ;;
  *)
    echo "usage: tools/guard.sh --install | --hook bash|github | --self-test" >&2
    exit 1
    ;;
esac
