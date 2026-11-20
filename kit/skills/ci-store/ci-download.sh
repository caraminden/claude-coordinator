#!/usr/bin/env bash
# Download a file another job of the same commit put in Citadel's CI store, from a GitHub Actions job.
# Copied from the Citadel kit (the citadel:ci-store skill); keep it as it is so a newer copy drops in.
#
#   tools/ci-download.sh [--workflow FILE] [--kind build|report|release] [--target TARGET] [--name NAME]
#                        [--run RUN_ID] [--commit SHA] [--out PATH]
#   tools/ci-download.sh --list [the same filters]
#
# The job needs `permissions: id-token: write` (beside `contents: read`), as for ci-upload.sh: the store
# reads the scheme and commit from the job's own run token, and hands out only that scheme's files of that
# commit, from any workflow. No secret.
#   --workflow  the workflow that made it, by file name (windows.yml); any workflow when left out
#   --name      the stored name; without it, the newest file matching the other filters
#   --commit    the job's own commit (the default); any other is refused
#   --out       where to write it (default: its stored name, in the current folder)
#   --list      print the matches, newest first, one a line: NAME WORKFLOW run RUN_ID KIND [TARGET]
# A file that can't be downloaded fails the step. CITADEL_STORE_URL overrides where the store is.
set -euo pipefail

store=${CITADEL_STORE_URL:-http://perigee.tail59477f.ts.net:8574}
query='' out='' list=''
plain='^[A-Za-z0-9][A-Za-z0-9._+-]*$'
while [ $# -gt 0 ]; do
  case $1 in
    --workflow | --kind | --target | --name | --run | --commit)
      value=${2:-}
      [[ $value =~ $plain ]] || { echo "ci-download: $1 takes letters, digits and . _ + - only" >&2; exit 2; }
      query="$query&${1#--}=$value"
      [ "$1" != --kind ] || case $value in build | report | release) ;; *) echo "ci-download: --kind build, report or release" >&2; exit 2 ;; esac
      shift 2 ;;
    --out) out=${2:-}; [ -n "$out" ] || { echo "ci-download: --out takes a path" >&2; exit 2; }; shift 2 ;;
    --list) list=1; shift ;;
    *) echo "ci-download: unknown option $1" >&2; exit 2 ;;
  esac
done

give_up() {
  echo "::error::ci-download: $1"
  exit 1
}

[ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ] && [ -n "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ] ||
  give_up "no run token: the job needs 'permissions: id-token: write'"

tmp=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ci-download.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

# Tokens go to curl on stdin, never on a command line another job on this PC could list.
answer=$(printf 'header = "Authorization: Bearer %s"\n' "$ACTIONS_ID_TOKEN_REQUEST_TOKEN" |
  curl -sS --config - --max-time 30 --retry 2 "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=citadel-ci-store") || give_up "GitHub didn't hand out a run token"
token=$(printf '%s' "$answer" | sed -n 's/.*"value" *: *"\([^"]*\)".*/\1/p')
[ -n "$token" ] || give_up "GitHub didn't hand out a run token"
echo "::add-mask::$token"

# GET the store's $1 into $2. A 503 means the store couldn't read GitHub's signing keys to check the run
# token (it tries again within seconds): wait and ask again, as ci-upload.sh does.
fetch() {
  local code try
  for try in 1 2 3 4 5 6; do
    code=$(printf 'header = "Authorization: Bearer %s"\n' "$token" |
      curl -sS --config - --max-time 1800 --connect-timeout 15 -o "$2" -w '%{http_code}' "$store$1") || give_up "the store at $store didn't answer"
    [ "$code" = 503 ] && [ "$try" != 6 ] || break
    sleep "${CI_DOWNLOAD_WAIT:-30}"
  done
  [ "$code" = 200 ] || give_up "the store refused $1 (HTTP $code): $(head -c 600 "$2" 2>/dev/null)"
}

fetch "/api/ci-store?${query#&}" "$tmp/list"
# One file a line. Every value read here is a plain name or number, so no JSON parser is needed.
files=$(sed 's/},{/}\n{/g' "$tmp/list" | grep '"url"' || true)
field() { printf '%s\n' "$1" | sed -n "s/.*\"$2\":\"\{0,1\}\([^\",}]*\).*/\1/p"; }

if [ -n "$list" ]; then
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    target=$(field "$f" target)
    echo "$(field "$f" name) $(field "$f" workflow) run $(field "$f" run_id) $(field "$f" kind)${target:+ $target}"
  done <<< "$files"
  exit 0
fi

first=$(printf '%s\n' "$files" | head -n 1)
[ -n "$first" ] || give_up "nothing in the store matches ${query#&} for this job's commit"
name=$(field "$first" name)
[ -n "$out" ] || out=$name
fetch "$(field "$first" url)" "$tmp/file"
mkdir -p "$(dirname "$out")"
mv "$tmp/file" "$out"
echo "ci-download: $name from $(field "$first" workflow) run $(field "$first" run_id) is at $out"
