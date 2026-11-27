# Cloud helpers: a step a home minion hands to a cloud session, not a minion in the cloud

Status: accepted, 2026-11-27 (#2200).

Cara, 2026-11-26 ~23:55 PST: "a local perigee minion orchestrating a cloud session that does certain types of CPU work …
more like a remote pool of smaller "free" compute that the minions can leverge when it makes sense", then "I guess they
would act more like subagents?". Cloud *minion* turns (#2153) stay off: "I think we should call cloud sessions a failure
until we rethink and retry them" (~00:00 PST), and on resuming the helpers (~00:40 PST): "Resume now". Shipped dark
(2026-11-27, "Ship dark, switch off"): every helper path sits behind the helpers switch #2187 adds, off by default, turned
on after the end-to-end proof.

`citadel-cloud` is a command a minion runs in its own turn, as it runs a Grunt or `citadel-heavy`. The minion keeps its
chat, cards, tools and shared folder; only the step runs in a Claude Code cloud session, on the turn's own login (sender
pays). Exit 69 (EX_UNAVAILABLE) means the cloud couldn't be used, and the minion runs the step at home; 75 keeps
its Citadel-wide meaning, "handed over to the server, end your turn" (citadel-heavy, citadel-job, citadel-wait).

Picked on #2200's card, 2026-11-27 (all four as recommended):
- **Job kinds: "Commands and briefs".** A command job runs a fixed script on a cheap model, and the script reports
  progress itself every couple of minutes. A brief job (research, a review) lets the model think, with a hard deadline.
- **Who picks the cloud: "Minion calls it".** A minion runs `citadel-cloud` when its guide says the step fits; where it
  then runs is the helper's pick (below).
- **In the chat: "Live line per step".** One chat line per cloud step, updated in place: what runs, minutes so far, the
  session link, the latest output, then done or fell back home.
- **Wait or carry on: "Both, by length".** The minion waits in its turn; a step that outlasts the wait is handed to the
  server (#1890's minion jobs) and wakes the minion with its result.
- **Where a job runs: "Helper checks first"** (2026-11-27). Cara's priorities, in her order: "1. Keep perigee not under
  heavy load so it can be responsive at all times 2. No overload machines that are running time sensitive jobs that could
  get flakey if more is offloaded to them 3. Not put tasks that will be WAY slower on the cloud VMs into the cloud 4. Not
  use cloud sessions when a free github runner would do the same task". The minion still calls the helper, which picks
  before it starts anything (`pickPlace`, `src/cloud-helper.ts`). The server answers what a turn can't see
  (`GET /api/tickets/:ticket/cloud-helpers/place`: the switch, and whether a machine lending the scheme CI has room for a
  suite with no ship or CI waiting there, by its balancer); the helper adds whether the repo is public (`gh api`) and the
  command's cloud runs over its perigee runs in citadel-heavy's history. A command job runs in the first place that
  passes: a connected machine with room, then GitHub's free runners on a public repo (citadel-heavy with
  `CITADEL_HEAVY_GITHUB=1`), then a cloud session unless its runs were 3× slower or worse, then perigee's small slot
  (`citadel-heavy --here`). A cloud session that can't start or goes quiet falls back to that slot by itself. A command
  asking for files back skips both CI places, which return only output. A brief needs a model: a cloud session, or exit
  69 and a Grunt at home.

GitHub's runners or a cloud session (#2198's timings, 2026-11-26): on a public repo GitHub's runners are free and
unmetered, 4 vCPU and 16 GB each, at most 20 jobs at once, and Citadel's suite split 16 ways took 4:45-4:59 there against
6:26 on Cara's desktop. Neither reaches the tailnet, and both run a snapshot or commit, not perigee's live data. GitHub
wins every model-free command on a public repo: no plan usage, no model in the loop, and the workflow's own logs. A cloud
session wins on a private repo (other schemes' repos are, so the kit's citadel-heavy workflow template isn't changed),
for a brief, which needs a model, and when GitHub's 20 jobs are taken.

Why non-delivery is caught in minutes: on 2026-11-26 a session (ticket 4254) never pushed its result branch. Its
follow-up started a 25-30 minute test run in the background and ended its turn; the cloud environment's own Stop hook
then made it push a draft to its working branch (`claude/…`), which Citadel didn't watch, and the home turn showed nothing
for 17 minutes until it was stopped. So a result names its job, the helper reads the session's working branch as well as
its result branch, a command job's silence past a few minutes ends in a read-back and then a run at home, and a brief job ends at
its deadline the same way.

Consequences: a session's work draws on its sender's plan (an estimate per step is counted in the minion's spend; the real
use never reaches Citadel). A session's GitHub access is its claude.ai account's: a repo it can't reach is exit 69, not a
setup step for people.
