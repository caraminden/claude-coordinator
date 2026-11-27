#!/usr/bin/env bash
# The cloud end of a flake repeat-run (#2187): tools/cloud-flake.ts sends a Claude Code cloud session these steps, one command
# each, so no step runs near the session's 30-minute limit on one background command. It runs on the session's VM (Ubuntu,
# root, 4 vCPU, Node 22, no tailnet), never on perigee. Each `run` appends one JSON line to .citadel/out/flake.jsonl, and
# `finish` commits that file with .citadel/result.json and pushes it to the branch the tool watches (src/cloud-turn.mjs reads it).
#
#   tools/cloud-flake-vm.sh setup <node major>         Node of that major (into /opt), devDependencies, git identity, sqlite3,
#                                                      the browser tests' headless Chromium
#   tools/cloud-flake-vm.sh run <test file> <copies>   one batch: <copies> at once under load (tools/flake-proof.sh), at most
#                                                      CLOUD_FLAKE_STEP (1440) s, then its verdict
#   tools/cloud-flake-vm.sh finish <result branch>     commit and push the results
#
# Verdicts: clean (every copy passed), flaky (some failed, or all did and the file then passed alone), red (it failed alone too:
# a plain red or the VM's own environment, no race), skipped (a test skipped here, so it proves nothing), stopped (over the limit).
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
out=.citadel/out
mkdir -p "$out"
results=$out/flake.jsonl
nodedir=/opt/citadel-node
[ -x "$nodedir/bin/node" ] && export PATH=$nodedir/bin:$PATH

case ${1:-} in
  setup)
    major=${2:?usage: cloud-flake-vm.sh setup <node major>}
    t0=$SECONDS
    if [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)" != "$major" ]; then
      base=https://nodejs.org/dist/latest-v$major.x
      name=$(curl -fsSL "$base/SHASUMS256.txt" | awk '/linux-x64\.tar\.xz$/ { print $2; exit }')
      [ -n "$name" ] || { echo "cloud-flake-vm: no Node $major build for linux-x64 at $base"; exit 1; }
      mkdir -p "$nodedir" && curl -fsSL "$base/$name" | tar -xJ -C "$nodedir" --strip-components=1 || { echo "cloud-flake-vm: Node $major didn't install"; exit 1; }
      export PATH=$nodedir/bin:$PATH
    fi
    npm ci --ignore-scripts --no-audit --no-fund --loglevel=error || { echo 'cloud-flake-vm: npm ci failed'; exit 1; }
    git config --global user.name >/dev/null || git config --global user.name 'Citadel cloud flake run'
    git config --global user.email >/dev/null || git config --global user.email 'cloud-flake@citadel.invalid'
    command -v sqlite3 >/dev/null || { apt-get install -y -qq sqlite3 >/dev/null 2>&1 || (apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq sqlite3 >/dev/null 2>&1) || echo 'cloud-flake-vm: no sqlite3 (tests that need it will skip or fail)'; }
    # The browser tests' headless Chromium, the build tests.yml installs (its version read from there, so the two stay one).
    chs=$(sed -n 's|.*v=\([0-9.]*\) dir=\$HOME/\(\.cache/ms-playwright/chromium_headless_shell-[0-9]*\)$|\1 \2|p' .github/workflows/tests.yml | head -1)
    v=${chs% *} dir=$HOME/${chs#* }
    if [ -n "$chs" ] && [ ! -x "$dir/chrome-headless-shell-linux64/chrome-headless-shell" ]; then
      zip=$(mktemp) && mkdir -p "$dir" &&
        curl -fsSL -o "$zip" "https://storage.googleapis.com/chrome-for-testing-public/$v/linux64/chrome-headless-shell-linux64.zip" &&
        python3 -m zipfile -e "$zip" "$dir" && chmod +x "$dir/chrome-headless-shell-linux64/chrome-headless-shell" || echo 'cloud-flake-vm: no headless Chromium (browser tests will skip)'
      rm -f "$zip"
      # Its shared libraries, best effort: a name this Ubuntu lacks only costs that library.
      apt-get update -qq >/dev/null 2>&1
      for lib in libnss3 libnspr4 libgbm1 libxkbcommon0 libatk-bridge2.0-0 libatk1.0-0 libcups2 libxcomposite1 libxdamage1 libxrandr2 libxfixes3 libpango-1.0-0 libcairo2 libasound2t64 libdrm2 fonts-liberation; do
        dpkg -s "$lib" >/dev/null 2>&1 || apt-get install -y -qq "$lib" >/dev/null 2>&1 || echo "cloud-flake-vm: no $lib"
      done
    fi
    echo "cloud-flake-vm: set up in $((SECONDS - t0)) s: node $(node -v), $(nproc) CPUs, $("$dir/chrome-headless-shell-linux64/chrome-headless-shell" --version 2>/dev/null || echo 'no Chromium'), at $(git rev-parse HEAD)"
    ;;
  run)
    file=${2:?usage: cloud-flake-vm.sh run <test file> <copies>}
    copies=${3:-10}
    log=$(mktemp)
    t0=$SECONDS
    rc=0
    CI=1 timeout -k 10 "${CLOUD_FLAKE_STEP:-1440}" bash tools/flake-proof.sh "$file" "$copies" >"$log" 2>&1 || rc=$?
    secs=$((SECONDS - t0))
    failed=$(grep -oE "failed in [0-9]+ of $copies copies" "$log" | head -n 1 | grep -oE '^failed in [0-9]+' | grep -oE '[0-9]+$')
    if [ "$rc" = 0 ]; then verdict=clean failed=0
    elif [ "$rc" = 124 ] || [ "$rc" = 137 ]; then verdict=stopped
    elif grep -q 'skipped a test on this runner' "$log"; then verdict=skipped
    elif grep -q 'alone: failed too' "$log"; then verdict=red
    elif [ -n "$failed" ] && [ "$failed" -lt "$copies" ] || grep -q 'alone: passed' "$log"; then verdict=flaky
    else verdict=red
    fi
    if grep -q 'failing tests:' "$log"; then detail=$(sed -n '/failing tests:/,$p' "$log" | head -n 40)
    else detail=$(tail -n 25 "$log"); fi
    F=$file C=$copies N=${failed:-0} V=$verdict S=$secs D=$detail node -e 'const e = process.env; console.log(JSON.stringify({ file: e.F, copies: +e.C, failed: Math.min(+e.N || (e.V === "flaky" || e.V === "red" ? +e.C : 0), +e.C), verdict: e.V, seconds: +e.S, detail: e.D.slice(0, 1500) }))' >>"$results"
    rm -f "$log"
    echo "cloud-flake-vm: $file: $verdict (${failed:-0} of $copies copies failed) in $secs s"
    ;;
  finish)
    branch=${2:?usage: cloud-flake-vm.sh finish <result branch>}
    touch "$results"
    SHA=$(git rev-parse HEAD) node -e '
      const fs = require("node:fs");
      const rows = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const reply = rows.length ? rows.map((r) => `- ${r.file}: ${r.verdict}, ${r.failed} of ${r.copies} failed, ${r.seconds} s`).join("\n") : "No batch ran.";
      fs.writeFileSync(".citadel/result.json", JSON.stringify({ reply: `Cloud flake run at ${process.env.SHA}:\n${reply}`, card: null, files: [process.argv[1]] }));
    ' "$results"
    git add -f .citadel/result.json "$results"
    git commit -qm "cloud flake results" --no-verify
    git push -q origin "HEAD:refs/heads/$branch" || { echo 'cloud-flake-vm: the push failed; the result follows'; echo CITADEL-RESULT-BEGIN; cat .citadel/result.json; echo; echo CITADEL-RESULT-END; exit 1; }
    echo "cloud-flake-vm: pushed the results to $branch"
    ;;
  *)
    sed -n '2,14p' "$0"
    exit 2
    ;;
esac
