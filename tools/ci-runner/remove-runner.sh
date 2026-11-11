#!/usr/bin/env bash
# Removes one scheme's Citadel-made Linux runners from the WSL distro on Cara's desktop (Citadel #510), the Linux twin
# of remove-runner.ps1. The runner agent in that distro runs it as root for `ci_runners remove` with os linux:
#
#   remove-runner.sh <scheme id, name or label> <citadel machines url>
#
# It acts only on folders /opt/actions-runner-* whose .citadel-runner marker (add-runner.sh writes one) names the
# scheme's repo. For each: it stops and uninstalls the runner's systemd service (svc.sh), takes the runner off GitHub
# with `config.sh remove` and a removal token Citadel mints (about an hour, never stored), then deletes the folder.
# A runner GitHub won't remove keeps its folder, and the script says why; running it again retries.
set -euo pipefail

scheme=${1:-}
url=${2:-}
url=${url%/}
root=${CITADEL_RUNNER_ROOT:-/opt}
user=${CITADEL_RUNNER_USER:-citadel-ci}

die() { echo "remove-runner: $*" >&2; exit 1; }

[[ -n $scheme && -n $url ]] || die 'usage: remove-runner.sh <scheme> <citadel url>'
[[ -n ${CC_MACHINE_TOKEN:-} ]] || die 'No machine token: set CC_MACHINE_TOKEN (the runner agent does).'
[[ $(id -u) == 0 ]] || die 'Run this as root: removing a systemd service needs it.'
# Unlike C:\ on Windows, only root can make a folder here, so a marker in it is one add-runner.sh wrote.
[[ $(stat -c %u "$root") == "$EUID" && ! $(stat -c %A "$root") =~ ^d.{4}w|^d.{7}w ]] || die "$root is not root's alone, so its markers can't be trusted; nothing removed."

# Citadel's answer about the scheme: repo, label and, when $1 is true, a removal token, one per line; or why not.
citadel() {
  node --input-type=module - "$url" "$scheme" "$1" remove <<'JS'
const [url, scheme, mint, kind] = process.argv.slice(-4);
const res = await fetch(`${url}/api/machines/runner-token`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${process.env.CC_MACHINE_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ scheme: /^\d+$/.test(scheme) ? Number(scheme) : scheme, mint: mint === 'true', kind }),
  signal: AbortSignal.timeout(60_000),
}).catch((err) => ({ ok: false, status: 0, json: async () => ({ error: err.message }) }));
const body = await res.json().catch(() => ({}));
if (!res.ok) { console.error(`Citadel refused: ${body.error ?? res.status}`); process.exit(1); }
console.log([body.repo, body.label, body.token ?? ''].join('\n'));
JS
}

mapfile -t names < <(citadel false) || true
[[ ${#names[@]} -ge 2 && -n ${names[0]} ]] || die 'Citadel gave no repo for the scheme (the line above says why).'
repo=${names[0]}

mine=()
for dir in "$root"/actions-runner-*/; do
  dir=${dir%/}
  [[ -f $dir/.citadel-runner ]] || continue
  theirs=$(node -e 'try { console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).repo) } catch {}' "$dir/.citadel-runner")
  [[ $theirs == "$repo" ]] && mine+=("$dir")
done
if [[ ${#mine[@]} == 0 ]]; then
  echo "No Citadel Linux runner of $repo here, so nothing changed."
  exit 0
fi

mapfile -t reg < <(citadel true) || true
token=${reg[2]:-}
[[ -n $token ]] || die 'Citadel gave no removal token (the line above says why).'
failed=0
for dir in "${mine[@]}"; do
  echo "Removing the runner in $dir"
  # config.sh remove refuses while the service is installed.
  if [[ -f $dir/.service ]] && ! (cd "$dir" && ./svc.sh stop && ./svc.sh uninstall); then
    failed=$((failed + 1)); echo "Its service wouldn't stop or uninstall; $dir stays." >&2; continue
  fi
  if [[ -f $dir/.runner ]] && ! (cd "$dir" && runuser -u "$user" -- ./config.sh remove --token "$token"); then
    failed=$((failed + 1)); echo "config.sh remove failed; $dir stays. Its _diag folder says why." >&2; continue
  fi
  rm -rf "$dir"
  echo "Removed $dir"
done
[[ $failed == 0 ]] || die "$failed runner folder(s) weren't removed; the lines above say why."
