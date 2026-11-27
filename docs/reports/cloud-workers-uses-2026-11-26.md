# Cloud workers: every way to use them well (2026-11-26)

Research minion #2190, run as a Claude Code cloud session. Asked by Cara on 2026-11-26 at about 22:55 PST: "lets start a research minion (in the cloud hopefully) to think about all the ways we can best leverage cloud workers". Earlier that night: "what about coding tasks?"

Research only: no code was changed. I read `src/cloud-pool.ts` and `src/cloud-turn.mjs` at `5a61844`, the official docs (cited below, all read 2026-11-27), and probed this VM myself (marked **[probed]**).

## Top 3

1. **Stop capping steps at 25 minutes.**
   - The docs say a background command may run up to **2 hours** when given a `timeout`. 30 minutes is only the default.
   - That one constant and one prompt line (S) open up the 25.9 h a week of 20+ minute heavy jobs, mutation runs included.
2. **Send model-free heavy compute to GitHub-hosted Actions runners, not to Claude cloud sessions.**
   - Scheme checks (17.8 h), Rust jobs (19.3 h) and mutation runs (5.9 h) don't need a model. A cloud session spends plan usage just to run a shell command.
   - `tests.yml` already has a `CI_RUNNER == 'github'` path. I'm challenging the framing here: the cheapest cloud worker for a pure job is one with no Claude in it.
3. **Give each scheme a cloud environment with a cached setup script.**
   - Node 26, `npm ci`, `cargo fetch`, a Godot binary, and for the Android schemes `dl.google.com` allowed.
   - It cuts the cold start that makes short jobs a poor fit, and it unblocks Android, which is a "no" today.
   - Size M. The one blocker: the CLI can't pick an `env_` environment per start.

The full ranked list is below. Each idea has what it frees, what it costs, what blocks it and a build size: S is under a day of one minion, M is a few minions, L is a build.

---

## 0. Facts that change the picture

These are from the docs (read 2026-11-27) or from probing this VM.

| # | Fact | Source | What it changes |
|---|---|---|---|
| F1 | Background commands: "A command that Claude starts in the background gets 30 minutes, or the `timeout` Claude passes with `run_in_background`, up to a maximum of 2 hours." Foreground: 2 min by default, up to 10 min, then moved to the background. | https://code.claude.com/docs/en/tools-reference ; https://code.claude.com/docs/en/cloud-environments (2026-11-27). [probed] This session's Bash tool caps a background timeout at 7,200,000 ms. | `CLOUD.stepMinutes = 25` rests on a wrong premise (#2147 read the 30 min default as the cap). Steps of 25 min up to about 115 min are possible. |
| F2 | Concurrency: no number is documented. The routines page has errors "You were at the limit for tasks Claude can work on at the same time" and "Your organization was at its limit…". Parallel `--cloud` sessions "all run simultaneously". | https://code.claude.com/docs/en/routines ; https://code.claude.com/docs/en/claude-code-on-the-web (2026-11-27) | A hidden cap exists. The pool must learn it from refusals, not assume a number (idea 14). |
| F3 | Usage: "counts toward your plan's usage limits alongside the rest of your Claude and Claude Code usage, and there's no separate charge for the cloud VM". Sessions "share rate limits with all other … usage within your account. Running multiple tasks in parallel consumes more rate limits proportionately." | https://code.claude.com/docs/en/claude-code-on-the-web (2026-11-27) | Cost is tokens, not wall-clock. A wide fan-out can use up the person's own 5-hour or weekly limit and lock them out of interactive use. That is a reason to order work by priority, which is different from capping it. |
| F4 | Environments: network None, Limited (default allowlist plus package managers plus your hosts, `*.` wildcards allowed) or Full. Env vars and a setup script. A setup that finishes in about 5 min is snapshotted and reused, rebuilt on a script or host change and about every 7 days. Running processes aren't kept. | https://code.claude.com/docs/en/cloud-environments (2026-11-27) | A per-scheme environment makes starts warm. Adding `dl.google.com` to an Android scheme's environment fixes #2154's "no". |
| F5 | The default allowlist has `maven.google.com`, `developer.android.com`, crates, npm, PyPI, Go, Gradle, Docker Hub, ghcr and Ubuntu apt. It does **not** have `dl.google.com`. | same page, "Default allowed domains" | [probed] `dl.google.com` was refused with proxy 403. A Godot binary from GitHub releases came down fine (200, 50 MB). `godotengine.org` and `downloads.tuxfamily.org` were refused. |
| F6 | `claude --environment <id>` takes only self-hosted `ccpool_` ids: "Claude Code rejects Anthropic-hosted `env_` IDs passed to the flag". The CLI uses the environment picked with `/remote-env`. | https://code.claude.com/docs/en/cloud-environments ; [probed] `claude --help` on 2.1.332 | Citadel can't choose an environment per start. It's one environment per login, set once. The way around it is ideas 3 and 16. |
| F7 | Self-hosted environments: `claude -p "<prompt>" --environment ccpool_… --output-format json` returns `{ok, session_id, url}` and exits, **no pty**. Results are read back by a Stop hook that gets `last_assistant_message`. Auth is a claude.ai OAuth token: "There is no long-lived CI token… `user:sessions:claude_code`, is capped server-side at 30 days." | https://code.claude.com/docs/en/self-hosted-environments-testing (2026-11-27) | It's a cleaner protocol than #2153's pty scraping, and it would run on Cara's desktop as a pool (idea 17). |
| F8 | Scheduled tasks (routines, research preview) have an API trigger: `POST https://api.anthropic.com/v1/claude_code/routines/<trig_id>/fire` with a per-task bearer token, `anthropic-beta: experimental-cc-routine-2026-04-01`, and optional `text` up to 65,536 chars. It returns `claude_code_session_id` and `claude_code_session_url`. Limits: 30 fires an hour per task and 100 API fires an hour per account. Cron no more often than hourly. | https://code.claude.com/docs/en/routines ; https://platform.claude.com/docs/en/api/claude-code/routines-fire (2026-11-27) | It starts a cloud session with one HTTPS call: no pty, no onboarding screens, the session id handed back. That's a robust start path (idea 4) and a home for nightly jobs. |
| F9 | Idle: "after a few minutes without activity, a session's VM pauses with its files saved, and a paused VM can later be reclaimed". A reclaimed VM comes back fresh with the conversation; running commands and subagents are not restored. | https://code.claude.com/docs/en/cloud-environments ; https://code.claude.com/docs/en/claude-code-on-the-web (2026-11-27) | A follow-up to a recently paused session is warm (files kept). One that was reclaimed is cold. Reusing a session for a batch of jobs works only while it stays busy. |
| F10 | Preinstalled: Python, Node 20/21/22, Ruby, PHP, OpenJDK 21, Go, Rust, GCC/Clang, **Docker**, PostgreSQL 16, Redis 7, Chrome, gh. | https://code.claude.com/docs/en/cloud-environments | [probed] docker 29.9.3 client, cargo/clippy, go, java, python3, claude 2.1.332, and Playwright plus Chromium. No wine and no pwsh. |
| F11 | Cloud sessions can't reply by `SendMessage` to another machine: "Read the cloud session's response in its transcript". | https://code.claude.com/docs/en/cross-session-messaging (2026-11-27) | Git stays the read-back channel. #2153's design is right. |
| F12 | GitHub Actions: `anthropics/claude-code-action@v1` "runs on GitHub-hosted runners, which consume your GitHub Actions minutes". `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) "runs use your Claude subscription instead of API billing". | https://code.claude.com/docs/en/github-actions (2026-11-27) | A second cloud worker class. Without the action, it's plain CPU on GitHub's runners with no Claude cost at all. |
| F13 | Agent SDK: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products". Managed Agents (beta `managed-agents-2026-04-01`) is API-key billed, with real create, stream and read endpoints. | https://code.claude.com/docs/en/agent-sdk/overview ; https://platform.claude.com/docs/en/managed-agents/overview (2026-11-27) | Citadel runs each person's own login for their own work, which fits. If Citadel is ever offered to outsiders, plan logins become a policy question. Managed Agents is the paid, API-shaped escape hatch (idea 24). |
| F14 | [probed] From inside a cloud session, the `claude-code-remote` tools exist: `create_session` (takes an `env_` id), `send_message`, `list_events`, `get_session` (which shows `rate_limit_info`, e.g. `seven_day … allowed`), and `create_trigger`. Lineage limit is depth 8. | This session | A cloud session can fan out children on a chosen environment and read their transcripts. That's a read-back API, but only from inside the cloud (idea 16). Undocumented on the public pages I read, so it may change. |

Session cost below uses the brief's figure, about $0.50 per 20 min of running (~$1.50 an hour). Because of F3 that is really token-driven. A session sitting on a long background command spends few tokens, so long compute jobs probably cost less per hour than research does. **I couldn't measure that** (see "What I couldn't check").

---

## 1. Ranked ideas

Columns: **Frees** is perigee or desktop time, wait or latency. **Costs** is plan usage, latency and risk. **Blocks** is what stops it today. **Size**: S, M or L.

### Tier 1: do these first

**1. Raise the step limit to match the docs (F1).**
- **What:**
  - `CLOUD.stepMinutes` goes from 25 to about 110, with `markRefusal` following.
  - `cloudPrompt` tells the session: run a long command in the background with an explicit `timeout`, poll it, and keep any foreground command under 10 min.
  - Today's line, "in the foreground and keep it under 25 minutes", asks for a foreground run that the tool auto-backgrounds at 10 min anyway.
- **Frees:**
  - Every 20+ min heavy job becomes eligible: 36 jobs and 25.9 of 65.5 heavy run-hours last week.
  - That includes mutation runs (5.9 h, one of which waited 70 min for a slot).
  - It also means the full Citadel suite has room to finish in the cloud. It didn't finish in 30 min.
- **Costs:**
  - About $1.50 an hour by the brief's measure, and likely less (F3).
  - Risk: a session stopped mid-step loses that step. That's already true today.
- **Blocks:** nothing, except one real session to confirm a 60 min background command survives. Does the VM count a running background command as activity (F9)? Very likely yes, but it's undocumented.
- **Size:** S.

**2. Model-free heavy jobs on GitHub-hosted runners (F12).**
- **What:** `citadel-heavy` gets a third place beside perigee and a PC: a `workflow_dispatch` on `ubuntu-latest` for jobs with no judgement in them. That covers scheme checks, `cargo test`, mutation sweeps, the nightly flake sweep and full-suite reruns.
- **Frees:**
  - Up to the bulk of 65.5 heavy run-hours: scheme checks 17.8 h, Rust 19.3 h, mutation 5.9 h.
  - No Claude usage spent on them.
- **Costs:**
  - GitHub Actions minutes. Public repos are free. Private repos depend on the account's quota, **which I couldn't see**.
  - Start-up is about 20–40 s, which is no better than a session for 15 s jobs, so batch those (idea 6).
  - A standard runner is smaller than the 24-thread desktop (2–4 vCPU), so long jobs run slower.
- **Blocks:**
  - Schemes not on GitHub.
  - Jobs needing perigee-only things (systemd units, ananicy, the database).
  - `tests.yml`'s self-hosted concurrency rules, which need a separate workflow.
- **Size:** M.
- **Why it's ranked above cloud sessions:** a Claude cloud session is a model plus a VM. For a job where the model only types `cargo test`, you pay for the model for nothing. Keep cloud sessions for work that needs judgement.

**3. One cloud environment per login with a cached setup script (F4, F5, F6).**
- **What:**
  - A setup script that installs Node 26 (only 20–22 are preinstalled), runs `npm ci` for Citadel's one dev dependency, warms the cargo registry, and downloads a pinned Godot headless binary from GitHub releases.
  - It's idempotent and skips a repo that isn't checked out.
  - Allowed hosts add `dl.google.com` (and whatever the SDK manager asks for) so Android builds can go.
  - Kept under about 5 min so it's snapshotted.
- **Frees:**
  - The cold start: Node 26 install plus 55 s of onboarding in #2147, minus the onboarding.
  - Android minions become cloud-eligible (`ANDROID_BRIEF` today keeps them home).
- **Costs:**
  - The env vars and script are readable by anyone using the environment.
  - It's personal per login, so each person's environment has to be set up (by Citadel's setup page or by hand).
  - Widening the allowlist widens what a prompt-injected session can reach.
- **Blocks:** the CLI picks the environment by `/remote-env`, not per start (F6). So it's one environment per login that serves every scheme: the script must handle every scheme's repo, or the per-scheme route goes through idea 4 or 16.
- **Size:** M (script, plus a Settings page step "set your cloud environment", plus dropping the Android rule when the environment allows it).

### Tier 2: high value once Tier 1 is in

**4. Start sessions through a routine's `/fire` endpoint instead of a pty (F8).**
- **What:**
  - One routine per scheme and login, bound to that scheme's repo and environment, with an empty base prompt.
  - Citadel POSTs the brief as `text` and gets the session id back in JSON.
  - Follow-ups stay `claude -p --cloud <id>`.
- **Frees:**
  - All of `underPty`, `keyFor` and the onboarding-screen guessing: the brittle 55 s start.
  - The "id never showed" branch in `cloud-turn.mjs`, which can lose a result.
  - Per-scheme environments become possible, because the routine carries one (it fixes F6's blocker).
- **Costs:**
  - It's a research preview.
  - 30 fires an hour per routine and 100 an hour per account. Fine for minions, tight for a flood of sweep jobs.
  - Tokens are made by hand in the web UI per routine ("no public API for token management") and stored as a Citadel secret.
- **Blocks:** whether a routine's run keeps accepting `-p --cloud` follow-ups like an ordinary session. **Unverified.**
- **Size:** M.

**5. Speculative fixes: two or three drafts at once (extends the cloud code drafts being built).**
- **What:**
  - For a bug minion, start 2–3 cloud drafts: the same brief with different steers ("fix at the root in X", "smallest guard", "rewrite Y"), or different models.
  - Home runs each draft's affected tests and the reviewer, and keeps the one that passes with the smallest diff. The rest are deleted branches.
- **Frees:**
  - Latency: a wrong first approach costs one review cycle today, often an hour or more of wall-clock.
  - #2147 drafted a real fix correctly in 96 s, so a draft is cheap.
- **Costs:** 2–3× draft usage, about $0.40 to $1.20 more per bug. Home's review time grows unless the losers are dropped automatically by their tests.
- **Blocks:** the draft class being built. Needs a "pick the winner" step (tests first, then the reviewer).
- **Size:** M.

**6. Batch short heavy jobs into one session or runner.**
- **What:**
  - The median heavy job is 15 s, which is too short for a cold start.
  - Collect a scheme's queued checks for N minutes, or by commit, and ship them as one job: one start, many commands, one result.
  - Or keep a warm session busy with a queue (F9: files survive a pause, not a reclaim).
- **Frees:** most of the 498 scheme-check jobs (17.8 h) and the short Rust jobs are cloud-eligible only this way.
- **Costs:**
  - Latency: a check waits for the batch window.
  - Risk: one red hides behind others unless each command's result is reported separately.
- **Blocks:** `citadel-heavy` places one job at a time. Results must come back per job, for example a JSON array in `result.json`.
- **Size:** M.

**7. Mutation testing in the cloud, in parallel.**
- **What:**
  - Split a mutation run's mutants across 3–4 sessions, or runners for idea 2, each with its own slice.
  - Results merge home.
  - Long runs need idea 1.
- **Frees:** 5.9 h a week, plus the 70 min slot wait. Mutation is the clearest long, CPU-only, embarrassingly parallel job here.
- **Costs:** about $1–2 a run on sessions, or minutes only on Actions. 4 vCPU per session versus the desktop's 24 threads, so each slice is slower and the whole run is faster only when wide.
- **Blocks:** idea 1 (or 2). A stable mutant-to-slice split.
- **Size:** S–M.

**8. Fan-out reviews for high-risk ships.**
- **What:**
  - When a ship is high risk (auth, deploy, tripwire, access), run 2–3 independent reviewers at once in cloud sessions.
  - Use different lenses or models. `tools/review-escapes` found one pass can swing by 3 named bugs, so two independent passes catch more than one.
  - Home merges the findings.
- **Frees:**
  - Perigee worker slots (~250 MB each) during review.
  - Escapes: Build 7's whole-build review found a scheme-list bug no feeder review caught.
- **Costs:**
  - About $0.40–1 per reviewer session.
  - The reviewer needs the diff and the repo only, which a session has.
  - The verifier arm needs a booted dev copy: possible in the cloud with Node 26, **unverified**.
- **Blocks:** the review flow is a home Grunt. It needs a cloud variant that takes a branch and returns findings as JSON.
- **Size:** M.

**9. Run the prompt-eval and review-escapes benches in the cloud, sharded.**
- **What:**
  - `tools/prompt-eval run --base main` and `review-escapes run` are many independent `claude -p` turns on the asker's login. A pass costs about $32 Sonnet or $47 Opus.
  - Shard cases across 4–8 cloud sessions. Each runs its cases with `claude -p` inside the VM (claude is preinstalled there) and pushes a results file.
- **Frees:**
  - Perigee processes and memory for an hours-long background run.
  - Wall-clock: 4–8× wider.
- **Costs:**
  - The same model spend as today, since these already run on the asker's login, plus the orchestrating sessions' small overhead.
  - Shared rate limits (F3): a wide shard burns the 5-hour window faster.
- **Blocks:**
  - Both rigs read fixtures from the repo (fine). Does any case need `$TMPDIR` workspaces with git history beyond depth 50? Clone depth may need raising.
  - Nested `claude -p` inside a cloud session: **unverified** whether it's allowed and billed the same.
- **Size:** S–M.

**10. Nightly audits per scheme as scheduled tasks.**
- **What:**
  - A routine per scheme on a cron (hourly at most, F8), each pushing a report branch.
  - Audits: the test-quality audit, `tools/stale-docs`, a security review of the day's commits, dead code, layout-map and glossary drift, dependency CVEs (`cargo audit`, `npm audit`), and license checks.
- **Frees:** no perigee time. Today these happen only when someone asks.
- **Costs:**
  - About $0.50–1 per audit per night per scheme. Ten schemes is about $5–10 a night, so choose the 2–3 audits that matter per scheme.
  - Risk: report noise nobody reads. Give each one a "did anything change" gate.
- **Blocks:**
  - Results come home only by branch (fine).
  - A schedule's start stays home today because its run "files itself away with Citadel's tools". A cloud routine needs a home-side reader that turns its branch into a card.
- **Size:** M.

**11. Dependency upgrades per scheme.**
- **What:** a weekly cloud job per scheme that runs `cargo update`, `npm outdated` plus bumps, or a Godot or engine version bump, runs the scheme's tests (with idea 1 for long ones), and pushes a branch with the bump, the test result and a changelog summary. Home ships it like any draft.
- **Frees:** a whole class of minion that today needs a perigee worker for the build and test.
- **Costs:** about $1–2 per scheme per week. Risk is the same as a human bump, and home review gates it.
- **Blocks:** Windows-only and Android builds (idea 3 for Android; Windows below).
- **Size:** S per scheme once the draft class exists.

**12. Pre-draft the next minion.**
- **What:**
  - When the Taskmaster writes a handoff or a card waits on a person's go, a cloud session drafts the implementation against the handoff's text before the go.
  - On go, the minion starts from the draft branch.
  - On no, the branch is deleted.
- **Frees:** latency. The draft is ready when the person says yes; with go cards sitting minutes to hours, that's most of a minion's first turn.
- **Costs:**
  - Wasted drafts on cards that are declined or changed. With about $0.40 a draft that's cheap, but it pays usage on the requester's login for work they didn't confirm.
  - That needs a per-person opt-in, which is consent, not a cap.
- **Blocks:** a handoff that needs the shared folder stays home (`staysHome`). The card-start path already carries the handoff text, so the plumbing exists.
- **Size:** M.

### Tier 3: worth doing, smaller or narrower

**13. Other schemes' builds.**
- **Rust/Windows overlay:**
  - The Linux side works in the cloud: `cargo check`, clippy and tests, 8 min measured.
  - A Windows cross-check with `cargo check --target x86_64-pc-windows-gnu` plus mingw from apt is plausible but **unverified**.
  - MSVC targets need Microsoft downloads, which are likely blocked.
  - Real Windows runs stay on the Windows box.
- **Godot game:**
  - Headless import, GDScript lint and GUT tests are plausible. The binary download works [probed], `godotengine.org` is blocked [probed], and GitHub releases is enough.
- **Web apps:** Playwright plus Chromium are preinstalled, so the UI sweeps and app shots (`tools/ui-sweep.ts`, `tools/app-shots`) can run there.
- **Android:** needs idea 3. There's no emulator (no KVM on the VM is likely, **unverified**), so builds and unit tests only.
- **Frees:** part of Rust's 19.3 h, and the schemes' share of the 17.8 h of checks.
- **Costs:** per idea 1 or 2.
- **Size:** S per scheme (a recipe in its instructions).

**14. A concurrency-aware cloud line (F2, F3, F14).**
- **What:** no cap of ours, per Josh. But:
  - (a) Treat "at the limit for tasks Claude can work on at the same time" as a signal: wait and retry, and remember the observed ceiling per login, so the pool fills to the real cap without errors.
  - (b) Order the cloud line by value (people's asks before sweeps and audits), so when the person's plan is near its weekly limit, low-value fan-out goes first to the back.
  - (c) Read `rate_limit_info` where it's available (F14 shows it inside a session) and show it on the worker tile.
- **Frees:** failed starts, and the person locked out of interactive use.
- **Costs:** none.
- **Blocks:** no documented API for plan status from outside. `get_session` works only from inside a cloud session.
- **Size:** S–M.

**15. Route by expected duration, learned per job type.**
- **What:**
  - Citadel already has the timings for every heavy job.
  - Route: under ~2 min stays home or is batched (idea 6). 2–110 min with no model goes to the Actions runner (idea 2). Judgement work goes to a cloud session. Over 110 min is split or stays home.
  - The cloud first when it's "no loss of value", per Cara's rule, but measured, not assumed.
- **Frees:** fills the pool with what fits instead of what's marked.
- **Costs:** none beyond the build.
- **Size:** M.

**16. A dispatcher cloud session for fan-out (F14).**
- **What:**
  - One cloud session takes a fan-out job ("try 3 fixes", "8 shards") and uses its own `create_session` with a chosen `env_` environment.
  - It watches children with `list_events` and `get_session`, merges their branches, and pushes one result.
  - It sidesteps F6 (environment choice) and gives a real read-back API in the cloud.
- **Costs:** a dispatcher session's tokens for the whole fan-out, plus depth limit 8.
- **Risk:** these tools aren't in the public docs I read and may change.
- **Blocks:** whether children run on the same login and are allowed by plan (they should be, since it's the same account).
- **Size:** M.

**17. Make Cara's desktop a self-hosted environment (F7).**
- **What:**
  - Register the desktop as a `ccpool_` runner.
  - Citadel then starts sessions there with `claude -p --environment ccpool_… --output-format json`: no pty, an id back at once, results by Stop hook.
  - That's the same "cloud session" lifecycle on the 24-thread machine that runs the suite in 196 s.
- **Frees:**
  - The same plumbing serves both, so full-suite and Android/Windows-needing jobs go to a machine that has the tools.
  - The perigee load of minion turns moves to the desktop.
- **Costs:**
  - The OAuth token's session scope is capped at 30 days, so it needs renewing monthly.
  - It's research-preview-ish.
- **Blocks:** this overlaps Build 7's machine connections, which already do turns on PCs. Only worth it if the pty start (idea 4's problem) keeps hurting.
- **Size:** M–L.

**18. Bisect a red main in the cloud.**
- **What:** `tools/land/blame.sh`'s bisect over N suspects runs N test runs. Fan them out, one session or runner per suspect commit.
- **Frees:** the minutes of a main-red bisect that block every land.
- **Costs:** N × a short run.
- **Blocks:** the suite in the cloud (idea 1) or on Actions (idea 2). Only the failing files need running, which keeps it short.
- **Size:** S–M.

**19. Stress and flake hunting in a different machine shape.**
- **What:** extends the cloud flake runs being built.
  - 4 vCPU is a *different* timing environment from the 24-thread desktop, and that's a feature for races.
  - Run suspects under `stress-ng` or with `taskset` to 1–2 cores, in Docker, to shake out timing bugs the desktop never shows.
- **Frees:** the burn-in's "racy" calls (Build 7 retro, item 2), with evidence of whether a red reproduces under load.
- **Costs:** small.
- **Blocks:** the flake runs being built.
- **Size:** S.

**20. Deterministic benchmarks only.**
- **What:**
  - Wall-clock benchmarks on a shared cloud VM are noisy, so don't trust them across sessions.
  - Two uses do work: instruction counts (`tools/citadel-callgrind`; valgrind counts don't depend on machine load), and A/B runs of base and head *interleaved in the same session*.
- **Frees:** perigee CPU for callgrind (slow), with no risk to its responsiveness.
- **Costs:** small.
- **Blocks:** valgrind via apt (allowed, F5).
- **Size:** S.

**21. Long property and fuzz runs.**
- **What:** run fast-check properties with a large `numRuns`, or `cargo fuzz` for the Rust scheme, for 60–110 min nightly. Push any counterexample as a test case.
- **Frees:** finds bugs no unit test asks for, at zero perigee cost.
- **Costs:** about $1–3 a night, likely less (F3).
- **Blocks:** idea 1.
- **Size:** S.

**22. Docs and repo-hygiene drafts.**
- **What:**
  - Layout-map rows for new modules.
  - ADR drafts from a decision thread's pasted text.
  - Design-system page refreshes.
  - Retros drafted from `git log`, though not from the database, which a session can't read (the brief would have to paste the numbers).
- **Frees:** minion turns at home for writing work.
- **Costs:** about $0.40 each.
- **Blocks:** anything that needs the shared folder or database stays home (`staysHome`), which takes out most retros.
- **Size:** S.

**23. Cloud UI checks for front-end changes.**
- **What:**
  - A UI change's screenshots (`node tools/ui-shot.ts`) and dev copy (`tools/citadel-dev-copy`) need Node 26 and the server.
  - Both should run in a session with idea 3's environment.
  - Shots come back as `.citadel/out/` files.
- **Frees:** dev-copy servers on perigee (memory and ports).
- **Costs:** per draft.
- **Blocks:** the dev copy may assume perigee paths or systemd. **Unverified.**
- **Size:** M.

**24. Managed Agents for API-billed work (F13).**
- **What:**
  - For jobs that shouldn't spend anyone's plan, Managed Agents (beta) has a real API: create a session, stream events, fetch results, schedule. It's API-key billed.
  - Examples: shared, org-wide sweeps, or work paid by the scheme rather than a person.
- **Frees:** the "who pays" question for shared jobs, and git-only read-back.
- **Costs:** real API dollars (no plan), a beta API, and no ZDR.
- **Size:** L.
- **When:** only if plan limits start biting.

---

## 2. Extending what's shipped or being built

These aren't new ideas.

- **Research and ideation:**
  - With idea 16, a research minion can split itself into 3–5 sub-researchers (docs, code, web, numbers), each in its own session, and merge.
  - This report took one session plus one subagent. Subagents in-session are already a cheap fan-out with no extra VM.
- **Cloud code drafts:**
  - Pair them with idea 5 (race two drafts) and idea 12 (draft before go).
  - Let a draft session run the scheme's affected tests itself before pushing, with idea 1 for long ones.
- **Cloud flake runs:** give them idea 19's stress mode, and put the nightly sweep on a routine (idea 10/4) rather than a home schedule.
- **Test sweeps:** once idea 1 lands, the sweep kind's 25 min refusal should read about 110 min.

## 3. Problems I noticed in the shipped code

These are for whoever owns #2153. I made no code change.

1. **`stepMinutes: 25` and its refusal text claim "a cloud session stops a background command at 30 minutes"**:
   - The docs say up to 2 h with a `timeout` (F1). The prompt also asks for foreground commands up to 25 min, but foreground caps at 10 min and then auto-backgrounds.
2. **Android is refused by rule:** with an environment that allows `dl.google.com` (F4), the rule could be a check of the login's environment instead.
3. **`--environment` isn't usable for `env_` ids (F6):** any plan to pick environments per scheme through the CLI won't work. Use a routine (idea 4) or a dispatcher (idea 16).
4. **The cost estimate is wall-clock-shaped (`costUsd.start` 0.40):** real cost is tokens (F3). For long compute steps it overstates. For chatty research it may understate. Measure a few sessions against the plan's usage page.

## 4. What I couldn't check from inside this session

- **The real concurrency cap** per login or plan. It isn't documented. I didn't start child sessions to find it (cost and consent).
- **Whether a long background command keeps the VM from pausing** (F9 says "activity"). I didn't run a 60+ min command: it needs a real try before idea 1 ships.
- **How much plan usage an idle-waiting session consumes**, compared with the brief's $0.50 per 20 min. No usage meter is visible from inside.
- **GitHub Actions minute quotas** for Cara's account and repos, and whether the scheme repos are public or private.
- **Whether a routine-started session accepts `claude -p --cloud <id>` follow-ups** (idea 4), and whether nested `claude -p` inside a cloud session works and bills normally (idea 9).
- **Windows cross-compiles, KVM/emulator availability**, and whether Citadel's dev copy or full suite run on this VM. I didn't run the full suite: #2147 already showed it over 30 min, and the useful retry needs idea 1's longer timeout.
- **Anything on perigee:** the heavy-job numbers are the brief's, not re-measured, and I couldn't see the database, the shared folder or other schemes' repos (GitHub access here is this repo only).
- **The F14 tools** are visible in this session but not in the public docs I read. Treat them as subject to change.

## Sources (all read 2026-11-27)

- https://code.claude.com/docs/en/claude-code-on-the-web
- https://code.claude.com/docs/en/cloud-environments
- https://code.claude.com/docs/en/tools-reference
- https://code.claude.com/docs/en/env-vars
- https://code.claude.com/docs/en/routines
- https://platform.claude.com/docs/en/api/claude-code/routines-fire
- https://code.claude.com/docs/en/self-hosted-environments-testing
- https://code.claude.com/docs/en/cross-session-messaging
- https://code.claude.com/docs/en/github-actions
- https://code.claude.com/docs/en/headless
- https://code.claude.com/docs/en/agent-sdk/overview
- https://code.claude.com/docs/en/agent-sdk/hosting
- https://code.claude.com/docs/en/remote-control
- https://code.claude.com/docs/en/scheduled-tasks
- https://platform.claude.com/docs/en/managed-agents/overview
- https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-max-or-ultra-plan
