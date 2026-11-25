#!/usr/bin/env bash
# Send a run's numbers (bench timings, sizes) from a GitHub Actions job to Citadel, which keeps them per commit for
# months, charts them on the CI page's Numbers tab, and wakes the scheme's Taskmaster when a step up holds.
# Copied from the Citadel kit (the citadel:ci-store skill); keep it as it is so a newer copy drops in.
#
#   tools/ci-numbers.sh startup=412ms frame-p95=16.4ms apk-size=12.5MB tests=1830
#   tools/ci-numbers.sh --file bench.txt      # one number a line: name value [unit]
#
# A name is letters, digits and . _ + - (one series per name, per scheme); the unit is the letters after the value.
# At most 50 numbers a run. The job needs `permissions: id-token: write`; the commit, run and branch come from its run
# token. A number that can't be sent warns and never fails the job. CITADEL_STORE_URL overrides where Citadel is.
set -uo pipefail

store=${CITADEL_STORE_URL:-http://perigee.tail59477f.ts.net:8574}
warn() { echo "::warning::ci-numbers: $1 (not failing the job)"; exit 0; }

pairs=()
while [ $# -gt 0 ]; do
  case $1 in
    --file)
      [ -r "${2:-}" ] || warn "can't read ${2:-the --file}"
      while read -r n v u _ || [ -n "${n:-}" ]; do
        [ -z "${n:-}" ] || [ "${n:0:1}" = '#' ] || pairs+=("$n=$v${u:-}")
      done < "$2"
      shift 2 ;;
    -*) warn "unknown option $1" ;;
    *) pairs+=("$1"); shift ;;
  esac
done
[ ${#pairs[@]} -gt 0 ] || warn "give the numbers as name=value[unit]"

json='' sep=''
for p in "${pairs[@]}"; do
  [[ $p =~ ^([A-Za-z0-9][A-Za-z0-9._+-]*)=(-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?)([A-Za-z%/]*)$ ]] ||
    warn "'$p' isn't name=value[unit] (a plain name, a number, then letters, % or / for the unit)"
  json+="$sep{\"name\":\"${BASH_REMATCH[1]}\",\"value\":${BASH_REMATCH[2]},\"unit\":\"${BASH_REMATCH[6]}\"}"
  sep=,
done

if [ "${RUNNER_ENVIRONMENT:-}" = github-hosted ]; then
  warn "skipped, a GitHub-hosted runner can't reach Citadel"
fi
[ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ] && [ -n "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ] ||
  warn "no run token: the job needs 'permissions: id-token: write'"

# Tokens go to curl on stdin, never on a command line another job on this PC could list.
answer=$(printf 'header = "Authorization: Bearer %s"\n' "$ACTIONS_ID_TOKEN_REQUEST_TOKEN" |
  curl -sS --config - --max-time 30 --retry 2 "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=citadel-ci-store") || warn "GitHub didn't hand out a run token"
token=$(printf '%s' "$answer" | sed -n 's/.*"value" *: *"\([^"]*\)".*/\1/p')
[ -n "$token" ] || warn "GitHub didn't hand out a run token"
echo "::add-mask::$token"

out=$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ci-numbers.XXXXXX")
trap 'rm -f "$out"' EXIT
# 503: Citadel couldn't read GitHub's signing keys to check the token yet; it tries again within seconds.
# A curl that fails before an answer (refused, reset, empty reply, connect timeout: curl exits 6 7 28 35 52 55 56) is
# Citadel restarting: tried again too, 6 tries 30 s apart.
for try in 1 2 3 4 5 6; do
  rc=0
  code=$(printf 'header = "Authorization: Bearer %s"\n' "$token" |
    curl -sS --config - --max-time 30 --connect-timeout 15 -H 'Content-Type: application/json' --data-binary "{\"numbers\":[$json]}" \
      -o "$out" -w '%{http_code}' "$store/api/ci-numbers") || rc=$?
  if [ "$rc" != 0 ]; then
    case $rc in 6|7|28|35|52|55|56) [ "$try" != 6 ] || warn "Citadel at $store didn't answer"; sleep "${CI_UPLOAD_WAIT:-30}"; continue ;; esac
    warn "Citadel at $store didn't answer"
  fi
  [ "$code" = 503 ] && [ "$try" != 6 ] || break
  sleep "${CI_UPLOAD_WAIT:-30}"
done
[ "$code" = 201 ] || warn "Citadel refused the numbers (HTTP $code): $(head -c 600 "$out")"
echo "ci-numbers: sent ${#pairs[@]} numbers to Citadel: $(cat "$out")"
