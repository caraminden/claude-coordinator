#!/usr/bin/env bash
# Adds one scheme's Linux GitHub Actions runners on a CI PC: plain Linux, or a WSL distro on a Windows one (Citadel #510), the Linux
# twin of add-runner.ps1. The runner agent in that distro runs it as root when someone asks `ci_runners add` with
# os linux:
#
#   add-runner.sh <scheme id, name or label> <citadel machines url> [count 1-4]
#
# It asks Citadel which repo and label the scheme has (no token yet) and skips each instance already here; then for
# each missing one it unpacks the stock runner (checked against GitHub's SHA-256) into /opt/actions-runner-<repo>
# (then -2 ...), owned by the scheme's own user ci-<repo>-<hash> (one per scheme, so one scheme's jobs can't read or
# change another's runners), registers it with label <scheme-slug>-ci-linux and name <PC>-linux (then -linux-2 ...),
# and writes its systemd unit citadel-runner-<owner>-<repo>[-n].service itself.
#
# Root never runs a file from a runner folder: CI jobs can write there. config.sh runs as the scheme's user, and the
# unit (in /etc/systemd/system, root's alone) is the record remove-runner.sh trusts; the folder's .citadel-runner
# marker is for people. One registration token, fetched as late as possible with the machine token in
# CC_MACHINE_TOKEN, handed to config.sh in its environment (never its arguments), never written down.
set -euo pipefail

scheme=${1:-}
url=${2:-}
url=${url%/}
count=${3:-1}
# For tests; the agent never sets these.
root=${CITADEL_RUNNER_ROOT:-/opt}
units=${CITADEL_RUNNER_UNITS:-/etc/systemd/system}
version=${RUNNER_VERSION:-2.338.0}
# From the release notes of that version (<!-- BEGIN SHA linux-x64 -->); set both to change version.
sha=${RUNNER_SHA256:-af4b794c1bc41d73d40535e3fe092a39f9679cd8d965954c2aca25a05ca41d32}
name=${RUNNER_NAME:-$(hostname)}-linux

die() { echo "add-runner: $*" >&2; exit 1; }

[[ -n $scheme && -n $url ]] || die 'usage: add-runner.sh <scheme> <citadel url> [count]'
[[ $count =~ ^[1-4]$ ]] || die "count must be 1 to 4, not $count"
[[ -n ${CC_MACHINE_TOKEN:-} ]] || die 'No machine token: set CC_MACHINE_TOKEN (the runner agent does).'
[[ $(id -u) == 0 ]] || die 'Run this as root: adding users and systemd services needs it.'
[[ -d /run/systemd/system ]] || die 'systemd is not running here (in WSL, install-runner-agent.sh turns it on in /etc/wsl.conf).'

# Citadel's answer about the scheme: repo, label and, when $1 is true, a token, one per line; or why not.
citadel() {
  node --input-type=module - "$url" "$scheme" "$1" register <<'JS'
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

# 1. Names first, so a re-run with nothing to add stops here without minting a token.
mapfile -t names < <(citadel false) || true
[[ ${#names[@]} -ge 2 && -n ${names[0]} ]] || die 'Citadel gave no repo for the scheme (the line above says why).'
repo=${names[0]}
label=${names[1]}-linux
[[ $repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "Citadel named an odd repo: $repo"
owner=${repo%%/*}
repo_name=${repo#*/}
# The scheme's user: readable, unique by the hash, and inside Linux's 32 characters.
user=ci-$(tr -c 'a-z0-9\n' '-' <<< "${repo_name,,}" | cut -c1-20)-$(printf %s "$repo" | sha256sum | cut -c1-6)

missing=()
taken=0
for i in $(seq 1 "$count"); do
  suffix=$([[ $i == 1 ]] && echo '' || echo "-$i")
  dir=$root/actions-runner-$repo_name$suffix
  unit=citadel-runner-$owner-$repo_name$suffix.service
  theirs=$(sed -n '1s/^# citadel-repo=//p' "$units/$unit" 2>/dev/null || true)
  if [[ -f $units/$unit && $theirs == "$repo" && ! -f $dir/.runner ]]; then
    # Its unit is written before config.sh, so an add that was cut off leaves this.
    taken=$((taken + 1))
    echo "$name$suffix in $dir was never registered (an add cut off?): ci_runners remove, then add again." >&2
  elif [[ -f $units/$unit && $theirs == "$repo" ]]; then
    echo "Already here, left as it is: $name$suffix in $dir (service $(systemctl is-active "$unit" || true))"
  elif [[ -e $units/$unit || -e $dir ]]; then
    # Repo foo's second instance and repo foo-2's first share these names; or a runner made by hand sits there.
    taken=$((taken + 1))
    echo "$dir or $unit is already there, not as $repo's (${theirs:-no Citadel unit}), so $name$suffix can't go there; nothing changed for it." >&2
  else
    missing+=("$suffix")
  fi
done
if [[ ${#missing[@]} == 0 ]]; then
  [[ $taken == 0 ]] || die "$taken runner(s) couldn't be added: see above."
  echo "$repo already has $count Linux runner(s) here, so nothing changed."
  exit 0
fi

# 2. Download the stock runner once and check it before anything runs from it.
tarball=$(mktemp --suffix=.tar.gz)
trap 'rm -f "$tarball"' EXIT
echo "Downloading runner v$version"
curl -fsSL -o "$tarball" "https://github.com/actions/runner/releases/download/v$version/actions-runner-linux-x64-$version.tar.gz"
got=$(sha256sum "$tarball" | cut -d' ' -f1)
[[ $got == "$sha" ]] || die "The download's SHA-256 is $got, not $sha from the release notes; nothing installed."

if ! id "$user" >/dev/null 2>&1; then
  useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$user"
  echo "Made the user $user for $repo's runners (no password, no sudo)."
fi

token=''
failed=0
undo() { failed=$((failed + 1)); echo "$runner: $1; removing $dir and $unit, which this run made." >&2; rm -rf "$dir"; rm -f "$units/$unit"; }
for suffix in "${missing[@]}"; do
  dir=$root/actions-runner-$repo_name$suffix
  runner=$name$suffix
  unit=citadel-runner-$owner-$repo_name$suffix.service
  # 3. Its unit first, so whatever happens next, remove-runner.sh can find this folder: written here from the runner's
  #    svc.sh template (root never runs svc.sh, which CI jobs can change), as the scheme's user. Its first line is what
  #    remove-runner.sh reads. KillMode=mixed, not the template's process: a job's leftovers end with the runner.
  cat > "$units/$unit" <<EOF
# citadel-repo=$repo
# Made by Citadel's add-runner.sh (#510); remove-runner.sh removes it.
[Unit]
Description=GitHub Actions runner $runner for $repo ($label)
After=network-online.target

[Service]
ExecStart=/bin/bash $dir/bin/runsvc.sh
User=$user
WorkingDirectory=$dir
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=5min

[Install]
WantedBy=multi-user.target
EOF
  # 4. The runner, owned by the scheme's user. It reads .env at start: telemetry off, and a home of its own, so
  #    runners never share tool caches (#370).
  if ! { mkdir -p "$dir/home" && tar -xzf "$tarball" -C "$dir" &&
    printf '%s\n' 'DOTNET_CLI_TELEMETRY_OPTOUT=1' 'DOTNET_NOLOGO=1' "HOME=$dir/home" > "$dir/.env" &&
    printf '{"repo": "%s", "label": "%s", "name": "%s", "mode": "linux", "unit": "%s", "added_at": "%s"}\n' "$repo" "$label" "$runner" "$unit" "$(date -u +%FT%TZ)" > "$dir/.citadel-runner" &&
    chown -R "$user:" "$dir" && chmod 700 "$dir"; }; then
    undo "couldn't unpack"; continue
  fi
  # 5. The token, as late as possible: it lasts about an hour, and one registers every instance of this run.
  if [[ -z $token ]]; then
    mapfile -t reg < <(citadel true) || true
    token=${reg[2]:-}
    [[ -n $token ]] || { undo 'no token'; die 'Citadel gave no registration token (the line above says why).'; }
  fi
  # The first runner carries the scheme's label alone; the others also <label>-side, for jobs that hold a runner long
  # (Citadel's flake proofs, #1240), so one runner is always left for the jobs that can't wait.
  labels=$label
  [[ -z $suffix ]] || labels+=",$label-side"
  echo "Registering $runner on $repo with labels $labels"
  # As the scheme's user, without the machine token, and with the registration token in its environment
  # (ACTIONS_RUNNER_INPUT_TOKEN is config.sh's --token), never in any command line `ps` shows. -m keeps that HOME.
  if ! (cd "$dir" && unset CC_MACHINE_TOKEN && export HOME=$dir/home ACTIONS_RUNNER_INPUT_TOKEN=$token &&
    runuser -m -u "$user" -- ./config.sh --unattended --url "https://github.com/$repo" --name "$runner" --labels "$labels" --work _work); then
    undo 'config.sh failed'; continue
  fi
  # 6. Started now and at every start of the distro; a service that dies at once (enable still says yes) is a failure.
  if ! { systemctl daemon-reload && systemctl enable --now "$unit" && sleep "${CITADEL_RUNNER_SETTLE:-3}" && systemctl is-active --quiet "$unit"; }; then
    failed=$((failed + 1)); echo "$runner is registered on GitHub but $unit didn't start; it stays: look in $dir/_diag, then remove it (remove-runner.sh) before trying again." >&2; continue
  fi
  echo "Added: $unit is $(systemctl is-active "$unit" || true), folder $dir"
done

echo
echo "  label  $label  (runs-on: [self-hosted, $label]); every runner but the first also has $label-side"
echo "  check  https://github.com/$repo/settings/actions/runners should list them as Idle."
[[ $failed == 0 && $taken == 0 ]] || die "$((failed + taken)) runner(s) weren't added; the lines above say why."
