#!/usr/bin/env bash
# Removes one scheme's Citadel-made Linux runners from this Linux PC or WSL distro (Citadel #510), the Linux twin
# of remove-runner.ps1. The runner agent in that distro runs it as root for `ci_runners remove` with os linux:
#
#   remove-runner.sh <scheme id, name or label> <citadel machines url>
#
# It trusts only the systemd units add-runner.sh wrote (/etc/systemd/system/citadel-runner-*.service, root's alone,
# first line `# citadel-repo=<repo>`), never a runner folder: CI jobs can write those. For each unit of the scheme's
# repo it stops and deletes the unit, takes the runner off GitHub with `config.sh remove` as the scheme's user and a
# removal token Citadel mints (about an hour, never stored), then deletes the folder. Once none of the repo's runners
# is left, it deletes the scheme's user too. A runner GitHub won't remove keeps its folder, and the script says why;
# running it again retries (the folder's .citadel-runner marker names the repo, for people).
set -euo pipefail

scheme=${1:-}
url=${2:-}
url=${url%/}
# For tests; the agent never sets these.
root=${CITADEL_RUNNER_ROOT:-/opt}
units=${CITADEL_RUNNER_UNITS:-/etc/systemd/system}

die() { echo "remove-runner: $*" >&2; exit 1; }

[[ -n $scheme && -n $url ]] || die 'usage: remove-runner.sh <scheme> <citadel url>'
[[ -n ${CC_MACHINE_TOKEN:-} ]] || die 'No machine token: set CC_MACHINE_TOKEN (the runner agent does).'
[[ $(id -u) == 0 ]] || die 'Run this as root: removing users and systemd services needs it.'
[[ $(stat -c %u "$units") == "$EUID" && ! $(stat -c %A "$units") =~ ^d.{4}w|^d.{7}w ]] || die "$units is not root's alone, so its units can't be trusted; nothing removed."

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
[[ $repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "Citadel named an odd repo: $repo"
repo_name=${repo#*/}
user=ci-$(tr -c 'a-z0-9\n' '-' <<< "${repo_name,,}" | cut -c1-20)-$(printf %s "$repo" | sha256sum | cut -c1-6)

mine=()
for unit in "$units"/citadel-runner-*.service; do
  [[ -f $unit && $(sed -n '1s/^# citadel-repo=//p' "$unit") == "$repo" ]] && mine+=("$unit")
done
if [[ ${#mine[@]} == 0 ]]; then
  echo "No Citadel Linux runner of $repo here, so nothing changed."
  exit 0
fi

mapfile -t reg < <(citadel true) || true
token=${reg[2]:-}
[[ -n $token ]] || die 'Citadel gave no removal token (the line above says why).'
failed=0
for unit in "${mine[@]}"; do
  dir=$(sed -n 's/^WorkingDirectory=//p' "$unit")
  # The unit is root's, but check what it points at all the same before deleting anything there.
  if [[ ! $dir =~ ^$root/actions-runner-[A-Za-z0-9_.-]+$ || $(sed -n 's/^User=//p' "$unit") != "$user" ]]; then
    failed=$((failed + 1)); echo "$unit doesn't point at a runner folder of $user ($dir); left as it is." >&2; continue
  fi
  echo "Removing the runner in $dir"
  if ! systemctl disable --now "$(basename "$unit")"; then
    failed=$((failed + 1)); echo "$(basename "$unit") wouldn't stop; $dir stays." >&2; continue
  fi
  if [[ -f $dir/.runner ]] && ! (cd "$dir" && unset CC_MACHINE_TOKEN && export HOME=$dir/home ACTIONS_RUNNER_INPUT_TOKEN=$token &&
    runuser -m -u "$user" -- ./config.sh remove); then
    # The unit stays (stopped) so a re-run finds this runner again.
    failed=$((failed + 1)); echo "config.sh remove failed; $dir stays. Its _diag folder says why." >&2; continue
  fi
  rm -f "$unit"
  rm -rf "$dir"
  echo "Removed $dir"
done
systemctl daemon-reload
left=0
for unit in "$units"/citadel-runner-*.service; do
  [[ -f $unit && $(sed -n '1s/^# citadel-repo=//p' "$unit") == "$repo" ]] && left=$((left + 1))
done
if [[ $left == 0 ]] && id "$user" >/dev/null 2>&1; then
  userdel "$user" && echo "Deleted the user $user." || echo "Couldn't delete the user $user (a process of it still running?); it has no runner left, so it's harmless." >&2
fi
[[ $failed == 0 ]] || die "$failed runner(s) weren't removed; the lines above say why."
