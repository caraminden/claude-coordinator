#!/usr/bin/env bash
# One-job runners in warm slot folders (runner pool P2, #2269): the root half, the Linux twin of runner-slot.ps1. The runner
# agent (as root, in WSL or on plain Linux) runs it with one op:
#
#   runner-slot.sh update                                keep /opt/citadel-pool/runner/<version> at GitHub's newest release
#   runner-slot.sh start <scheme id> <slot> <once> <url>  start slot <n>'s one-job runner
#   runner-slot.sh stop <repo name> <slot>                stop it, and wipe what a runner stopped before its job leaves
#                                                        (by the slot folder's name: nothing from Citadel)
#   runner-slot.sh state                                  one JSON line per slot: repo, slot, running, job, exit
#
# A slot is /opt/citadel-pool/<repo>/slot-<n>, owned by the scheme's user (add-runner.sh's ci-<repo>-<hash>, so one scheme's
# jobs can't touch another's). Its bin, externals and root files are hard links into the one copy of the runner program
# (cp -al: no extra space, and read-only to that user), never the copy's own folder: two runners in one folder clash
# (P0, #2266). Start runs launch-slot.sh as that user in a transient unit, citadel-slot-<repo>-<n>.service, whose
# arguments hold only the one-time id: the launcher swaps it for the runner's config at Citadel. Root never runs or reads
# a file from a slot (a job can write there): the links come from a root-only folder by rename, which never follows a
# link, and the launcher's lines are read as the scheme's user.
set -euo pipefail

pool=${CITADEL_POOL:-/opt/citadel-pool}
copies=$pool/runner
here=$(dirname "$(readlink -f "$0")")

die() { echo "runner-slot: $*" >&2; exit 1; }

[[ $(id -u) == 0 ]] || die 'Run this as root (the runner agent does): it makes users and units.'
op=${1:-}

slot_units() { systemctl list-units --all --plain --no-legend 'citadel-slot-*.service' 2>/dev/null | awk '{print $1, $3}'; }

case $op in
state)
  # Every slot folder, read as the scheme's user that owns it (its parent is root's, so a job can't swap the folder).
  for dir in "$pool"/*/slot-*/; do
    dir=${dir%/}
    [[ -d $dir && ! -L $dir && $dir =~ /([^/]+)/slot-([0-9]+)$ ]] || continue
    repo_name=${BASH_REMATCH[1]} n=${BASH_REMATCH[2]}
    owner=$(stat -c %U "$dir")
    [[ $owner == ci-* ]] || continue
    running=false
    systemctl is-active --quiet "citadel-slot-$repo_name-$n.service" && running=true
    job=$(runuser -u "$owner" -- grep -ao 'Running job: .*' "$dir/runner-console.log" 2> /dev/null | tail -n 1 | cut -c14-200 | tr -cd '[:print:]' | sed 's/["\\]/ /g' || true)
    code=$(runuser -u "$owner" -- grep -aoE 'runner exited -?[0-9]+' "$dir/slot.log" 2> /dev/null | tail -n 1 | grep -oE -- '-?[0-9]+$' || true)
    printf '{"repo":"%s","slot":%s,"running":%s%s%s}\n' "$repo_name" "$n" "$running" "${job:+,\"job\":\"$job\"}" "${code:+,\"exit\":$code}"
  done
  exit 0
  ;;
update)
  if slot_units | awk '$2 == "active" || $2 == "activating"' | grep -q .; then die 'a slot is running; the copy updates only between jobs.'; fi
  release=$(curl -fsSL -H 'User-Agent: Citadel' https://api.github.com/repos/actions/runner/releases/latest)
  version=$(grep -oE '"tag_name": *"v[0-9]+\.[0-9]+\.[0-9]+"' <<< "$release" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || true)
  [[ -n $version ]] || die "GitHub's newest runner release has no version this script can read."
  sha=$(grep -oE 'BEGIN SHA linux-x64 -->[0-9a-f]{64}' <<< "$release" | grep -oE '[0-9a-f]{64}$' || true)
  [[ -n $sha ]] || die "runner v$version's release notes have no linux-x64 SHA-256."
  install -d -m 0755 -o root -g root "$pool" "$copies"
  have=$(cat "$copies/current" 2>/dev/null || true)
  if [[ $have == "$version" && -x $copies/$version/bin/Runner.Listener ]]; then
    echo "runner v$version is current"
    exit 0
  fi
  tarball=$(mktemp --suffix=.tar.gz)
  trap 'rm -f "$tarball"' EXIT
  echo "Downloading runner v$version"
  curl -fsSL -o "$tarball" "https://github.com/actions/runner/releases/download/v$version/actions-runner-linux-x64-$version.tar.gz"
  got=$(sha256sum "$tarball" | cut -d' ' -f1)
  [[ $got == "$sha" ]] || die "the download's SHA-256 is $got, not $sha from the release notes; nothing changed."
  rm -rf "${copies:?}/$version.part" "${copies:?}/$version"
  mkdir "$copies/$version.part"
  tar -xzf "$tarball" -C "$copies/$version.part"
  chown -R root:root "$copies/$version.part"
  chmod -R go-w "$copies/$version.part"
  mv -T "$copies/$version.part" "$copies/$version"
  echo "$version" > "$copies/current"
  # The old copies: no slot runs, and each slot links to the current one at its next start.
  for old in "$copies"/*/; do
    [[ $(basename "$old") == "$version" ]] || rm -rf "${old:?}"
  done
  echo "runner v$version installed (was ${have:+v}${have:-none})"
  exit 0
  ;;
start | stop) ;;
*) die 'usage: runner-slot.sh update | state | start <scheme> <slot> <once> <url> | stop <repo name> <slot>' ;;
esac

slot=${3:-}
[[ $slot =~ ^([1-9]|1[0-6])$ ]] || die 'slot must be 1 to 16'

if [[ $op == stop ]]; then
  # By the slot folder's own name, which the agent kept from its start: works after the scheme stopped borrowing here.
  repo_name=${2:-}
  [[ $repo_name =~ ^[A-Za-z0-9_.-]{1,100}$ && ! $repo_name =~ ^\.+$ ]] || die "repo must be the slot folder's repo name"
  dir=$pool/$repo_name/slot-$slot
  unit=citadel-slot-$repo_name-$slot.service
  # Stopping the unit ends its whole cgroup: the launcher, the runner and anything a job left running.
  systemctl stop "$unit" 2>/dev/null || true
  # rm takes a link off, never what it names.
  [[ -d $dir && ! -L $dir ]] && rm -f "$dir/.runner" "$dir/.credentials" "$dir/.credentials_rsaparams"
  echo "stopped $unit"
  exit 0
fi

scheme=${2:-}
once=${4:-}
url=${5:-}
url=${url%/}
[[ $scheme =~ ^[0-9]{1,9}$ ]] || die 'scheme must be a scheme id'
[[ $url =~ ^https?://[^[:space:]\"\'\`]+$ ]] || die 'url must be an http(s) address'
[[ -n ${CC_MACHINE_TOKEN:-} ]] || die 'No machine token: set CC_MACHINE_TOKEN (the agent does).'

# Which repo the scheme has, from Citadel (no token): the folder and the user are named after it.
repo=$(node --input-type=module - "$url" "$scheme" <<'JS'
const [url, scheme] = process.argv.slice(-2);
const res = await fetch(`${url}/api/machines/runner-token`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${process.env.CC_MACHINE_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ scheme: Number(scheme), mint: false }),
  signal: AbortSignal.timeout(60_000),
}).catch((err) => ({ ok: false, status: 0, json: async () => ({ error: err.message }) }));
const body = await res.json().catch(() => ({}));
if (!res.ok) { console.error(`Citadel refused: ${body.error ?? res.status}`); process.exit(1); }
console.log(body.repo);
JS
) || die "Citadel wouldn't say which repo scheme $scheme has (the line above says why)."
[[ $repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "Citadel named an odd repo: $repo"
repo_name=${repo#*/}
[[ $repo_name =~ ^\.+$ ]] && die "Citadel named an odd repo: $repo"
user=ci-$(tr -c 'a-z0-9\n' '-' <<< "${repo_name,,}" | cut -c1-20)-$(printf %s "$repo" | sha256sum | cut -c1-6)
dir=$pool/$repo_name/slot-$slot
unit=citadel-slot-$repo_name-$slot.service

[[ $once =~ ^[0-9a-f]{48}$ ]] || die 'once must be the 48-character one-time id Citadel sent'
if systemctl is-active --quiet "$unit"; then die "$unit is still running a runner; stop it first."; fi
version=$(cat "$copies/current" 2>/dev/null || true)
[[ -n $version ]] || die 'no runner copy on this machine yet: update makes it.'
[[ -x $copies/$version/bin/Runner.Listener ]] || die "the runner copy v$version is incomplete: run update."

if ! id "$user" > /dev/null 2>&1; then
  useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$user"
  echo "Made the user $user for $repo's runners (no password, no sudo)."
fi
install -d -m 0755 -o root -g root "$pool" "$pool/$repo_name"
[[ -L $dir ]] && die "$dir is a link, not a folder; nothing changed."
[[ -d $dir ]] || install -d -m 0700 -o "$user" -g "$user" "$dir"
# The program links, made again whenever the copy changed: cut in a root-only folder beside the slot, then renamed in.
# rename(2) replaces a link a job put there instead of following it, and refuses a folder a job filled.
marker=$pool/$repo_name/.slot-$slot.version
if [[ $(cat "$marker" 2>/dev/null || true) != "$version" ]]; then
  tmp=$(mktemp -d "$pool/$repo_name/.link-XXXXXX")
  cp -al "$copies/$version/." "$tmp/"
  for entry in "$tmp"/* "$tmp"/.[!.]*; do
    [[ -e $entry ]] || continue
    name=$(basename "$entry")
    rm -rf "${dir:?}/$name"
    mv -T "$entry" "$dir/$name"
  done
  rmdir "$tmp"
  echo "$version" > "$marker"
fi
install -m 0755 -o root -g root "$here/launch-slot.sh" "$pool/launch-slot.sh"

systemctl reset-failed "$unit" 2>/dev/null || true
systemd-run --quiet --collect --unit "$unit" --uid "$user" --gid "$user" --working-directory "$dir" \
  --property Slice=citadel-runners.slice --property Nice=10 --property KillMode=mixed \
  --setenv HOME="$dir/home" /bin/bash "$pool/launch-slot.sh" "$dir" "$once" "$url"

# The launcher's first lines say whether the scheme's user got its config: read as that user, never as root.
for _ in $(seq 1 40); do
  sleep 0.5
  tail=$(runuser -u "$user" -- tail -n 5 "$dir/slot.log" 2>/dev/null || true)
  grep -q " once ${once:0:8}" <<< "$tail" || continue
  err=$(grep ' error: ' <<< "$tail" | tail -n 1 || true)
  [[ -z $err ]] || die "$unit's launcher failed: ${err#* }"
  if grep -q 'starting the runner' <<< "$tail"; then
    echo "started $unit (runner v$version)"
    echo "slot: $dir"
    exit 0
  fi
done
die "$unit's launcher said nothing in 20 seconds; its log: $dir/slot.log"
