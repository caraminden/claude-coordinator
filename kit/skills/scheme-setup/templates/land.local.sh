# The scheme's own settings and hooks for tools/land.sh, which sources this file. tools/land.sh is the Citadel
# kit's, copied byte for byte: never edit it here, put what is this scheme's in this file. Plain shell, sourced
# under set -euo pipefail, so a mistake here stops every landing: run the scheme's land tests after editing.
# Set only what differs from the core's default (shown); leave the rest commented.

# The check command, exactly as Project facts names it under "Check commands" ('true' while it has none).
# With the CI gate on it is what runs here before anything is pushed: keep it light.
# CHECK='npm test'

# The scheme's main branch.
# BRANCH=main

# The file whose Project facts may have a "Numbered things" line.
# FACTS=CLAUDE.md

# The CI gate: off while both of these are empty. The header of tools/land.sh says what each needs.
# CI_WORKFLOWS: the workflow files that must all be green on the exact commit that lands, split by spaces.
# CI_WORKFLOWS=''
# CI_STATUS: the scheme's own verdict command, when "every workflow green" is not the rule (exit 0 green,
#   1 red, 2 running, 3 not started, 4 no verdict).
# CI_STATUS=''

# How many landings at the front of the line run CI at once. Runners that can't carry three runs at once: 2.
# CI_STACK=${LAND_STACK_DEPTH:-3}

# How many landings share one CI run (batches). 1: off. A deep line on slow CI: 3 or 4.
# CI_BATCH=${LAND_BATCH:-1}

# 0: main stays in the main checkout and is never pushed (a scheme whose origin isn't its own).
# PUSH_MAIN=1

# Step 7: run once per branch that landed, after main was pushed, with the land lock and the place in line
# already free, from the landing's worktree. Its output shows with the landing's; a failure is only warned
# about and the landing still exits 0. Keep a network call in it under a timeout.
# land_after() { # <commit> <branch>
#   timeout 60 gh pr close "$2" --comment "Landed as $1" >/dev/null 2>&1 || true
# }
