#!/usr/bin/env bash
# Which schemes' tools/land.sh differ from the kit's template (#602). A scheme copies the template byte for byte and
# keeps its own settings in tools/land.local.sh, so any difference is a sync it hasn't taken (or a migration to the
# local file it hasn't made). tools/deploy.sh runs this when a deploy changes the template.
#   tools/kit-land-drift.sh [projects dir]
# Prints "<project number> <origin>" for each scheme repo (<projects dir>/*/repo, default Citadel's) whose main
# commit's tools/land.sh differs from this checkout's template. A repo without one, and Citadel's own (it holds the
# template: its land.sh is its own), are left out.
set -euo pipefail
template=$(dirname "$0")/../kit/skills/scheme-setup/templates/land.sh
projects=${1:-$HOME/.local/share/claude-coordinator/projects}
want=$(sha256sum <"$template")
for repo in "$projects"/*/repo; do
  [ ! -e "$repo/kit/skills/scheme-setup/templates/land.sh" ] || continue
  # Main's commit, not the main checkout's files: a landing's fast-forward may be half done there.
  [ -n "$(git -C "$repo" ls-tree HEAD tools/land.sh 2>/dev/null)" ] || continue
  [ "$(git -C "$repo" show HEAD:tools/land.sh | sha256sum)" != "$want" ] || continue
  origin=$(git -C "$repo" remote get-url origin 2>/dev/null) || origin='(no origin)'
  origin=${origin#*github.com[:/]} origin=${origin%/}
  echo "$(basename "$(dirname "$repo")") ${origin%.git}"
done
