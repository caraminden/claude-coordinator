#!/usr/bin/env bash
# Adds one scheme's Linux GitHub Actions runners inside the WSL distro on Cara's desktop (Citadel #510), the Linux
# twin of add-runner.ps1. The runner agent in that distro runs it as root when someone asks `ci_runners add` with
# os linux:
#
#   add-runner.sh <scheme id, name or label> <citadel machines url> [count 1-4]
#
# It asks Citadel which repo and label the scheme has (no token yet) and skips each instance already here; then for
# each missing one it unpacks the stock runner (checked against GitHub's SHA-256) into /opt/actions-runner-<repo>
# (then -2 ...), writes its .env and a .citadel-runner marker (remove-runner.sh only removes folders with one),
# registers it with label <scheme-slug>-ci-linux and name <PC>-linux (then -linux-2 ...) as the user citadel-ci,
# and installs it as a systemd service with the runner's own svc.sh. One registration token, fetched as late as
# possible with the machine token in CC_MACHINE_TOKEN, never written down. It never touches another runner.
set -euo pipefail

scheme=${1:-}
url=${2:-}
url=${url%/}
count=${3:-1}
# For tests; the agent never sets these.
root=${CITADEL_RUNNER_ROOT:-/opt}
user=${CITADEL_RUNNER_USER:-citadel-ci}
version=${RUNNER_VERSION:-2.338.0}
# From the release notes of that version (<!-- BEGIN SHA linux-x64 -->); set both to change version.
sha=${RUNNER_SHA256:-af4b794c1bc41d73d40535e3fe092a39f9679cd8d965954c2aca25a05ca41d32}
name=${RUNNER_NAME:-$(hostname)}-linux

die() { echo "add-runner: $*" >&2; exit 1; }

[[ -n $scheme && -n $url ]] || die 'usage: add-runner.sh <scheme> <citadel url> [count]'
[[ $count =~ ^[1-4]$ ]] || die "count must be 1 to 4, not $count"
[[ -n ${CC_MACHINE_TOKEN:-} ]] || die 'No machine token: set CC_MACHINE_TOKEN (the runner agent does).'
[[ $(id -u) == 0 ]] || die 'Run this as root: installing a systemd service needs it.'
id "$user" >/dev/null 2>&1 || die "No user $user; install-runner-agent.sh makes it."
[[ -d /run/systemd/system ]] || die 'systemd is not running in this distro; install-runner-agent.sh turns it on in /etc/wsl.conf.'

# Citadel's answer about the scheme: repo, label and, when $1 is true, a token, one per line; or why not.
citadel() {
  node --input-type=module - "$url" "$scheme" "$1" "${2:-register}" <<'JS'
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
repo_name=${repo#*/}

missing=()
taken=0
for i in $(seq 1 "$count"); do
  suffix=$([[ $i == 1 ]] && echo '' || echo "-$i")
  dir=$root/actions-runner-$repo_name$suffix
  theirs=''
  [[ -f $dir/.citadel-runner ]] && theirs=$(node -e 'try { console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).repo) } catch { console.log("(unreadable)") }' "$dir/.citadel-runner")
  if [[ -n $theirs && $theirs != "$repo" ]]; then
    # Repo foo's second instance and repo foo-2's first share a folder name.
    taken=$((taken + 1))
    echo "$dir already holds a runner for $theirs, so $name$suffix can't go there; nothing changed for it." >&2
  elif [[ -e $dir ]]; then
    state='no service'
    [[ -f $dir/.service ]] && state="service $(systemctl is-active "$(cat "$dir/.service")" || true)"
    echo "Already here, left as it is: $name$suffix in $dir ($state)"
  else
    missing+=("$suffix")
  fi
done
if [[ ${#missing[@]} == 0 ]]; then
  [[ $taken == 0 ]] || die "$taken runner(s) couldn't be added: their folders belong to another repo's runners."
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

token=''
failed=0
for suffix in "${missing[@]}"; do
  dir=$root/actions-runner-$repo_name$suffix
  runner=$name$suffix
  mkdir -p "$dir"
  if ! (
    set -e
    tar -xzf "$tarball" -C "$dir"
    # 3. The runner reads .env at start: telemetry off, and a home of its own, so runners never share tool caches (#370).
    mkdir -p "$dir/home"
    printf '%s\n' 'DOTNET_CLI_TELEMETRY_OPTOUT=1' 'DOTNET_NOLOGO=1' "HOME=$dir/home" > "$dir/.env"
    printf '{"repo": "%s", "label": "%s", "name": "%s", "mode": "linux", "added_at": "%s"}\n' "$repo" "$label" "$runner" "$(date -u +%FT%TZ)" > "$dir/.citadel-runner"
    chown -R "$user:" "$dir"
  ); then
    failed=$((failed + 1)); echo "$runner: couldn't unpack into $dir; removing it." >&2; rm -rf "$dir"; continue
  fi
  # 4. The token, as late as possible: it lasts about an hour, and one registers every instance of this run.
  if [[ -z $token ]]; then
    mapfile -t reg < <(citadel true) || true
    token=${reg[2]:-}
    [[ -n $token ]] || { rm -rf "$dir"; die 'Citadel gave no registration token (the line above says why).'; }
  fi
  echo "Registering $runner on $repo with label $label"
  if ! (cd "$dir" && runuser -u "$user" -- ./config.sh --unattended --url "https://github.com/$repo" --token "$token" --name "$runner" --labels "$label" --work _work); then
    failed=$((failed + 1)); echo "$runner: config.sh failed; removing $dir, which this run made." >&2; rm -rf "$dir"; continue
  fi
  # 5. A systemd service as $user (the runner's own svc.sh), started now and at every boot of the distro.
  if ! (cd "$dir" && ./svc.sh install "$user" && ./svc.sh start); then
    failed=$((failed + 1)); echo "$runner is registered on GitHub but its service didn't start; $dir stays: look in its _diag, then remove it (remove-runner.sh) before trying again." >&2; continue
  fi
  echo "Added: $(cat "$dir/.service") is $(systemctl is-active "$(cat "$dir/.service")"), folder $dir"
done

echo
echo "  label  $label  (runs-on: [self-hosted, $label])"
echo "  check  https://github.com/$repo/settings/actions/runners should list them as Idle."
[[ $failed == 0 && $taken == 0 ]] || die "$((failed + taken)) runner(s) weren't added; the lines above say why."
