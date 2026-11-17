#!/usr/bin/env bash
# Upload one file, or a folder as a .tar.gz, from a GitHub Actions job to Citadel's CI store.
# Copied from the Citadel kit (the citadel:ci-store skill); keep it as it is so a newer copy drops in.
#
#   tools/ci-upload.sh --kind build|report|release [--name NAME] [--target TARGET] PATH
#
# The job needs `permissions: id-token: write` (beside `contents: read`): the script asks GitHub for the job's
# own run token, which is all the store wants. No secret. The store names the scheme, workflow, run and commit
# from that token.
#   --name    what the file is called in the store (default: PATH's name, plus .tar.gz for a folder)
#   --target  what the cleanup rules group by beside the workflow, for a workflow that builds several things
# A report that can't be uploaded warns and passes; a build or release that can't fails the step.
# CITADEL_STORE_URL overrides where the store is.
set -euo pipefail

store=${CITADEL_STORE_URL:-http://perigee.tail59477f.ts.net:8574}
kind='' name='' target='' path=''
while [ $# -gt 0 ]; do
  case $1 in
    --kind) kind=${2:-}; shift 2 ;;
    --name) name=${2:-}; shift 2 ;;
    --target) target=${2:-}; shift 2 ;;
    -*) echo "ci-upload: unknown option $1" >&2; exit 2 ;;
    *) [ -z "$path" ] || { echo "ci-upload: one path at a time" >&2; exit 2; }; path=$1; shift ;;
  esac
done
case $kind in build | report | release) ;; *) echo "ci-upload: --kind build, report or release" >&2; exit 2 ;; esac
[ -n "$path" ] || { echo "ci-upload: give the file or folder to upload" >&2; exit 2; }

# What to do when the upload can't happen: a report never fails its job.
give_up() {
  if [ "$kind" = report ]; then
    echo "::warning::ci-upload: $1 (a report: not failing the job)"
    exit 0
  fi
  echo "::error::ci-upload: $1"
  exit 1
}

[ -e "$path" ] || give_up "$path is not there"
# GitHub's hosted runners aren't on the tailnet, so they can't reach the store.
if [ "${RUNNER_ENVIRONMENT:-}" = github-hosted ]; then
  echo "::warning::ci-upload: skipped, a GitHub-hosted runner can't reach Citadel's store"
  exit 0
fi
[ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ] && [ -n "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ] ||
  give_up "no run token: the job needs 'permissions: id-token: write'"

tmp=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ci-upload.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

file=$path
if [ -d "$path" ]; then
  base=$(basename "$(cd "$path" && pwd)")
  [ -n "$name" ] || name=$base.tar.gz
  file=$tmp/upload.tar.gz
  # To stdout, not -f: on Windows tar reads a path like D:\x as a remote host.
  tar -czf - -C "$path/.." "$base" > "$file" || give_up "packing $path failed"
fi
[ -n "$name" ] || name=$(basename "$path")
# The name and target go into the URL as they are, so only what the store takes: letters, digits and . _ + -
plain='^[A-Za-z0-9][A-Za-z0-9._+-]*$'
[[ $name =~ $plain ]] || give_up "the name '$name' has more than letters, digits and . _ + - in it: pass a plain one with --name"
[[ -z $target || $target =~ $plain ]] || give_up "the target '$target' has more than letters, digits and . _ + - in it"

# Tokens go to curl on stdin, never on a command line another job on this PC could list.
answer=$(printf 'header = "Authorization: Bearer %s"\n' "$ACTIONS_ID_TOKEN_REQUEST_TOKEN" |
  curl -sS --config - --max-time 30 --retry 2 "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=citadel-ci-store") || give_up "GitHub didn't hand out a run token"
token=$(printf '%s' "$answer" | sed -n 's/.*"value" *: *"\([^"]*\)".*/\1/p')
[ -n "$token" ] || give_up "GitHub didn't hand out a run token"
echo "::add-mask::$token"

url="$store/api/ci-store/$name?kind=$kind${target:+&target=$target}"
# 503: the store is taking other jobs' uploads and has no room to take this one beside them yet, or it
# couldn't read GitHub's signing keys to check the run token (it tries again within seconds).
for try in 1 2 3 4 5 6; do
  code=$(printf 'header = "Authorization: Bearer %s"\n' "$token" |
    curl -sS --config - --max-time 1800 --connect-timeout 15 -T "$file" -o "$tmp/answer" -w '%{http_code}' "$url") || give_up "the store at $store didn't answer"
  [ "$code" = 503 ] && [ "$try" != 6 ] || break
  sleep "${CI_UPLOAD_WAIT:-30}"
done
if [ "$code" != 201 ]; then
  give_up "the store refused $name (HTTP $code): $(head -c 600 "$tmp/answer" 2>/dev/null)"
fi
echo "ci-upload: stored $name ($kind) in Citadel's CI store"
