#!/usr/bin/env bash
# The npm packages a test run needs, in a checkout that hasn't got them (#1863): a scratch worktree, the live checkout, an
# old minion's worktree. Without them typecheck.test.ts and the property tests fail on their import, which land.sh read as
# "red on main", and the suite's type check failed every run on perigee.
#   test-deps.sh <checkout>      its node_modules matches its package-lock.json: 0, else 1 with why on stderr. A checkout
#                                with none gets a link to a store kept per lockfile in the repo's git folder (installed
#                                once, with npm ci), and "linked" is printed; a real folder that is out of date gets an
#                                npm ci of its own. No package-lock.json: 0, nothing to do.
#   test-deps.sh missing <log>   0 when the output says a package was missing: the test could not run, so it is no verdict.
# TEST_DEPS_TIMEOUT: seconds an install may take (180); a store unused for 7 days is deleted.
set -uo pipefail
say() { echo "test-deps: $*" >&2; }

if [ "${1:-}" = missing ]; then
  # A path ('./x', '/x') is the repo's own file, so that stays a real failure.
  grep -qE "Cannot find (package|module) '[^./']|(typescript|Biome) is (not installed|missing)" "$2" 2>/dev/null
  exit
fi

cd "$1" || exit 1
[ -f package-lock.json ] || exit 0
limit=${TEST_DEPS_TIMEOUT:-180}
tools=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 1
# <folder holding node_modules>: it has every package this lockfile names for this machine, at its version, and none the
# lockfile doesn't name: land.sh counts a suite run on it as a run of the commit, so it must be what CI's npm ci installs.
matches() {
  "$tools/citadel-node" -e '
    const fs = require("node:fs"), dir = process.argv[1];
    const libc = process.report.getReport().header.glibcVersionRuntime ? "glibc" : "musl";
    const fits = (list, me) => !list || (list.some((x) => x[0] !== "!") ? list.includes(me) : !list.includes(`!${me}`));
    const pkgs = JSON.parse(fs.readFileSync("package-lock.json", "utf8")).packages ?? {};
    for (const [path, p] of Object.entries(pkgs)) {
      if (!path || p.link) continue;
      // npm ci drops an optional package it could not fetch, tsc and Biome own programs too, and still exits 0.
      if (p.optional && !(fits(p.os, process.platform) && fits(p.cpu, process.arch) && fits(p.libc, libc))) continue;
      if (JSON.parse(fs.readFileSync(`${dir}/${path}/package.json`, "utf8")).version !== p.version) process.exit(1);
    }
    const names = (at) => fs.existsSync(at) ? fs.readdirSync(at).filter((n) => n[0] !== ".") : [];
    for (const n of names(`${dir}/node_modules`))
      for (const f of n[0] === "@" ? names(`${dir}/node_modules/${n}`).map((x) => `${n}/${x}`) : [n])
        if (!pkgs[`node_modules/${f}`]) process.exit(1);' "$1" >/dev/null 2>&1
}
install() { timeout -k 10 "$limit" npm ci --ignore-scripts --prefer-offline --no-audit --no-fund </dev/null >&2; }

if [ -d node_modules ] && [ ! -L node_modules ]; then
  matches . && exit 0
  say "$PWD/node_modules doesn't match package-lock.json: running npm ci in it"
  install && matches . && exit 0
  say "npm ci failed in $PWD"
  exit 1
fi

common=$(git rev-parse --path-format=absolute --git-common-dir) && sha=$(sha256sum <package-lock.json) || exit 1
stores=$common/cc-test-deps
store=$stores/${sha%% *}
mkdir -p "$stores" || exit 1
exec 8>>"$stores/lock"
flock -w "$limit" 8 || { say "another install of the packages hasn't ended in ${limit}s"; exit 1; }
if ! matches "$store"; then
  tmp=$(mktemp -d "$stores/new.XXXXXX") || exit 1
  trap 'rm -rf "${tmp:?}"' EXIT
  cp package.json package-lock.json "$tmp/" || exit 1
  say "installing the packages of $PWD's lockfile once, in $store"
  (cd "$tmp" && install 8>&-) && matches "$tmp" || { say "npm ci failed in a copy of $PWD's lockfile"; exit 1; }
  rm -rf "${store:?}" && mv -T "$tmp" "$store" || exit 1
fi
touch "$store"
find "$stores" -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rm -rf {} + 2>/dev/null
[ "$(readlink node_modules 2>/dev/null)" = "$store/node_modules" ] && exit 0
ln -sfn "$store/node_modules" node_modules || exit 1
echo linked
