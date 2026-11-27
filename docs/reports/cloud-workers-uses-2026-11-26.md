# Cloud workers: every way to use them well (2026-11-26)

Research minion #2190, run as a Claude Code cloud session. Asked by Cara on 2026-11-26 at about 22:55 PST: "lets start a research minion (in the cloud hopefully) to think about all the ways we can best leverage cloud workers". Earlier that night: "what about coding tasks?"

Research only: no code was changed. I read `src/cloud-pool.ts` and `src/cloud-turn.mjs` at `5a61844`, the official docs (cited below, all read 2026-11-27), and probed this VM myself (marked **[probed]**).

> **Read Part A first.** It was added after Cara's follow-ups that night: at 23:20 PST, "oh, this might be useless then, if we cant have the sessions operate remotely", and at 23:40 PST, "The goal needs to be to find any uses for the cloud sessions that can look IDENTICAL to a Citadel user to a local (or on our own machines) session". Cloud sessions are off until this is figured out. Part A re-ranks everything by that test. Part B, from "Top 3 (first pass)" on, is the first report, unchanged except for its labels.

> **Part C (Cara's six questions, 2026-11-27) comes first and supersedes A and B where they disagree.** Her calls: the claude CLI only, so no endpoint, connector or Tailscale; and no per-person setup to babysit.

---

# Part C: answers to Cara's six questions (added 2026-11-27)

## C1. "2 hours is a LOT longer, we could definitely do some test runs or something to help our CI pipeline?"

Yes, but not the land gate itself. I ran Citadel's whole suite here to find out (numbers in C1a).

**Where cloud test runs help CI**, best first:
1. **Mutation runs** (5.9 h a week, one waited 70 min for a slot). They're long, CPU-only and parallel: the best fit there is.
2. **Big burn-ins before a ship joins the line.**
   - Today's burn-in is 10 runs, capped at 2.5 min. The Build 7 retro had four test files called "racy" that were plain reds.
   - A cloud burn-in of a ship's new and changed test files, run 50× during the minion's own turn, catches real races *before* the train. Plain reds show up as 50/50 failures, not "racy".
   - The 4 vCPU box is a harsher timing shape than the desktop, which is good for this.
3. **Nightly "different machine" full runs, 3 in parallel sessions.**
   - Files that fail there but not on the desktop are flake suspects, and they feed `known-flakes`.
   - That extends the nightly flake sweep already being built.
4. **Bisecting a red main** (`tools/land/blame.sh`): one session per suspect commit, each running only the failing files.
5. **The `CI FALLBACK` when the desktop is offline**, sharded across about 4 sessions instead of loading perigee. C1a's numbers: about 9 min a shard across 4 sessions, so it's slower than the desktop but better than loading perigee.

**Not the land gate.** Lands go one at a time, and the desktop runs the suite in 196 s. A slower gate makes every land slower. Keep the gate on the desktop.

### C1a. The full suite on this VM [measured 2026-11-27]

I ran `node --test test/` on Node 26.13.1 here: 4 vCPU, Node's default concurrency, as one background command, and with a mingw install, a wine install and a Rust build competing for the CPU part of the time.

- **It finished in 2,022 s (33.7 min)**: 7,551 tests, 7,084 passed, 46 failed, 421 skipped. The desktop takes 196 s, so this VM is **about 10× slower** for Citadel's suite.
- **The failures I checked were this environment, not the code:**
  - **It runs as root (uid 0).** The "a lock or temp file that can't be opened" tests (deploy and restart locks, the test-run temp file, the jobs rider) assume permissions can deny, and for root they don't.
  - **A shallow clone** (`--is-shallow-repository` true, 53 commits). That breaks `.git-blame-ignore-revs`, the review bench's commits, the blame cases and "the last release's Store".
  - **No `sqlite3` CLI.** All nine backup and off-box tests, and the prune tests.
  - **No biome**, so the format check fails.
  - **systemd user units** (runner add and remove).
  - Fixes: run the suite as a non-root user, `git fetch --unshallow`, and `apt-get install sqlite3`, plus biome from npm.
  - I didn't rerun with those fixes, so I can't say all 46 clear.
- **The VM didn't pause** during a 34-minute background command. That answers my earlier open question for at least that length.

**What it means:**
- **A whole run in one session** fits easily inside 2 h, but at about 34 min it's no gate.
- **Sharded across 4 sessions:** about 9 min each plus about 1–2 min of start, so roughly the land timeout. That's too slow for every land, but fine as the offline fallback, and good for nightly runs and burn-ins.
- **Single files and burn-ins of a few files** take seconds to minutes. That's the sweet spot.

## C2. "Rust being there should mean we can do peek auras builds?"

Mostly yes: builds and checks, not running the overlay.

I couldn't read `caraminden/peek-auras` (it's private, and this session's GitHub access covers Citadel's repo only), so I tested the same shape of program [measured]:
- `rustup target add x86_64-pc-windows-gnu`: **4.6 s**. Installing the mingw linker from Ubuntu's apt: **51 s**.
- A crate using the `windows` crate (0.58) to make a layered, topmost, click-through overlay window cross-compiled to a real Windows `.exe` (PE32+ x86-64) in **10.6 s** (release).
- The **MSVC** toolchain is out: Microsoft's SDK hosts (`download.visualstudio.microsoft.com`, `aka.ms`) are blocked, so `cargo-xwin` can't fetch the SDK. The GNU target catches nearly every compile error, but not MSVC-only linker or CRT differences, or `build.rs` steps that call MSVC tools.
- **Running Windows tests:** wine is in Ubuntu's apt, but took 5 min to install, and my test binary crashed under it (`free(): invalid pointer`, SIGABRT). An overlay's real behaviour needs real Windows anyway.
- The Linux side (`cargo check`, `clippy`, tests of crates that aren't Windows-only) works. #2147's trial ran a crate's `cargo test` in 8 min.

**So for Peek Auras in the cloud:**
- `cargo clippy --target x86_64-pc-windows-gnu`, `cargo build --target x86_64-pc-windows-gnu`, and the platform-free unit tests on Linux.
- The Windows box keeps the MSVC release build and anything that runs the overlay.
- Rust jobs were 509 jobs and 19.3 h last week across schemes. The check and clippy part of that can move.

## C3. "Github actions are limited, cloud claude compute isnt, so why would we waste limited resources?"

I disagree on both halves. The answer differs by repo.

- **Cloud Claude compute is limited.**
  - It "counts toward your plan's usage limits" and shares "rate limits with all other Claude and Claude Code usage within your account". That's the same 5-hour and weekly limits every Citadel minion turn on that login draws from. https://code.claude.com/docs/en/claude-code-on-the-web (2026-11-27).
  - There's also an undisclosed cap on sessions at once ("at the limit for tasks Claude can work on at the same time", https://code.claude.com/docs/en/routines).
  - The VM is free, but every cloud job is a model session.
- **GitHub Actions is unlimited where it matters most here.**
  - "The use of standard GitHub-hosted runners is free: In public repositories", and Actions is "free for standard GitHub-hosted runners in public repositories, and for self-hosted runners". From GitHub's docs source, `github/docs` → `content/billing/concepts/product-billing/github-actions.md` and `data/reusables/actions/actions-billing.md`, read 2026-11-27. docs.github.com itself is blocked from this VM.
  - **`caraminden/claude-coordinator` is public** [checked 2026-11-27], so Citadel's own model-free jobs on GitHub's runners cost nothing scarce.
  - **The scheme repos are private**: peek-auras, voiceanalyzer, transitiontracker, theory-of-crafting, transdata, twireader, cantrips, trippresenter, mandate, gamedevtest and others. Those draw from the account's included allowance ($0.006 a minute for standard Linux). I couldn't see that allowance or its use.

**So:**
- **Citadel's own heavy jobs:** GitHub runners (free, unlimited, and they spend none of anyone's Claude limits).
- **Private schemes:** cloud sessions. Cara is right there, since Actions minutes are the scarcer pool for them.
- Either way, make each cloud job cheap in tokens: one short brief, one batched command, wait, push. The model then mostly waits instead of thinking.

## C4. "for the cloud env… I dont want to be babysitting these sessions, how often would we need to do this? … every Citadel user would need to do it"

**Nobody needs to do it.** Drop per-person environments; that's my Part B idea 3 withdrawn.

- What the environment was for is cheap to do inside every session [measured]:
  - Node 26: **4.7 s** to download and unpack from nodejs.org.
  - Citadel's `npm ci`: seconds.
  - The Rust Windows target: 4.6 s. mingw: 51 s.
- So the brief (or a committed `SessionStart` hook gated on `CLAUDE_CODE_REMOTE=true`, which runs in every user's cloud session with no setup) installs what the job needs. Zero per-person steps, nothing to babysit.
- **If someone ever did make an environment:** the setup cache rebuilds itself about every 7 days and whenever the script changes. Still nothing to tend.
- **The one thing only an environment fixes is Android's `dl.google.com`.** The network is per environment, per person. So Android stays home, as it is now.

## C5. "I dont think any of those options for connecting to Citadel are viable, we should just use the claude CLI"

Agreed. Here's what that means concretely:
- **Start:** `claude --cloud "<brief>"`.
- **Follow-up:** `claude -p "<msg>" --cloud <id>`.
- **Results:** a pushed `cloud/…` branch, with `claude --teleport <id>` as the fallback read.
- **The consequence:** a cloud session can't *be* a minion and look identical, because there are no mid-turn cards, live stream or shared folder. So only Part A's family 1 is left: **the minion stays home and uses the cloud as a backend for steps.** Every use in C1–C3 fits that.

## C6. "Tell me more about the cloud-turn.mjs"

### What it does today

`src/cloud-turn.mjs` runs **in place of `claude` for one minion turn**. The turn wrapper (`src/turn-run.mjs`) starts it with a `cloud.json` job the runner wrote (`CloudPool.job` in `src/cloud-pool.ts`). It prints stream-json like a claude turn would, so the chat, Stop and liveness treat it as any turn. Step by step:

1. **Reach check:** `git ls-remote origin HEAD` from the minion's checkout. If GitHub can't be reached, the result could never come back, so it ends without sending anything.
2. **Start (first turn), under a fake terminal.**
   - `claude --cloud` refuses `-p` (#2147), so it runs `claude --cloud "<brief>"` under util-linux `script`.
   - `keyFor` presses Enter on the first-run screens it recognises by text: the theme, "Press enter", "Yes, proceed", and the trust prompt (down then Enter).
   - It watches the screen until a `claude.ai/code/session_…` link shows (`sessionIn`), up to `startMs` (180 s).
   - The brief comes from `cloudPrompt`: "you're minion #N's cloud session… write `.citadel/result.json`… push to `cloud/t<id>-<time>`".
3. **Follow-ups (later turns):** `claude -p "<text>" --cloud <session> --output-format json`, which queues the message and returns `{ok,…}`.
   - It first checks the *previous* turn's branch for a late answer (`lateResult`), pushed after a Stop or a timeout.
   - A refusal drops the session, so the next turn runs at perigee.
4. **Wait:** every `pollMs` (20 s) it runs `git ls-remote` on the turn's own branch, until a new commit shows or `limitMs` passes (90 min, or 30 min if the id never showed).
5. **Read back** (`fetchResult`):
   - Fetches the branch and reads `.citadel/result.json` (`readResult` checks its shape, since it comes from outside).
   - Copies up to 20 files of up to 5 MB from `.citadel/out/` into the minion's files.
   - Then deletes the branch. If any file couldn't come home, the branch stays.
6. **Card:** a result's `card` is POSTed to Citadel's `/api/tickets/<id>/questions`, the same route `ask_question` uses. The answer comes back as the minion's next message, which becomes the next follow-up.
7. **Fallback read:** if nothing was pushed by the limit, `claude --teleport <session>` runs in a throwaway clone, under the fake terminal again, and the result is read from between `CITADEL-RESULT-BEGIN`/`END` on screen.
8. **End:** a `result` event with `cloud_cost_usd` (an estimate: $0.40 a start, $0.10 a follow-up). Stop kills the local driver only. The cloud session goes on, and its late push is shown next turn.

### Its weak spots

- **Screen scraping:** the start depends on recognising onboarding text and a link on a terminal screen. Any Claude Code UI change breaks it quietly. The 180 s start limit is mostly onboarding (55 s in #2147).
- **The id that never shows:** it keeps watching the branch for 30 min, but a push after that is lost (the code's own `shortcut:` comment).
- **Teleport is scraped too.** It's slow (up to 90 s) and needs the same fake terminal.
- **The 120 s follow-up timeout is ambiguous:** "may have the message", so the person has to resend.
- **Cost is a guess by turn,** not tokens. The real use is on the person's plan and never reaches Citadel.
- **The cloud *is* the turn.** That's the root of Cara's "turn it off": no mid-turn cards, no live progress, no shared folder, no Citadel tools.

### What changing it into a backend step looks like (S0 in Part A)

Keep steps 1–5 and 7, which are the start, poll and read-back that work. Change what wraps them:

- **A command, not a turn:** `citadel-cloud run --brief <file> [--minutes N] [--out <dir>]`, on every turn's PATH beside `citadel-job` and `citadel-heavy`.
  - A home minion calls it in the middle of its own turn.
  - It prints a progress line every minute or so ("cloud session session_…: running, 12 min, branch cloud/…") so the minion's stream stays alive and the person sees a step running.
  - It prints the result's `reply` and the paths of its files on exit.
  - Exit code 75 means "couldn't use the cloud", and the minion runs the step at home, as `citadel-heavy` does today.
- **No cards from the backend:** a backend session has no person to ask. A `card` in its result goes back to the home minion as text, and the minion decides whether to ask the person itself, with a real card in its own turn.
- **The home minion keeps everything else:** chat, live stream, cards, steering, Stop (which also stops the local driver; the session's late push is then discarded), the shared folder, and Citadel's tools.
- **Sender pays:** it runs on the turn's own login (`turnPerson`), as today.
- **A `cloud` place in `citadel-heavy`** for jobs marked cloud-friendly (C1's list, C2's checks), so minions don't have to choose. The line routes long and parallel jobs to it and keeps short ones home.
- **Size:** M. Most of the code exists. The new parts are the CLI wrapper, progress lines, exit codes, the result-to-stdout shape, and the heavy place.

---

# Part A: what looks identical to a local session (added 2026-11-27)

**The test:** would a person in Citadel's chat see any difference at all? That means the same minion, the same live stream, cards mid-turn, steering and Stop, the shared folder and Citadel's tools.

## A0. The answer in one paragraph

**Family 1 wins, and it's buildable today with no network change.** The minion stays home with its chat, cards, tools and shared folder, and hands heavy or parallel *steps* to the cloud, the way it hands work to a Grunt or `citadel-heavy` now. People see the same minion. The only visible trace is a step that runs elsewhere, and it already looks like a tool call.

**Family 2 (the minion itself in the cloud) can come close, but not through Tailscale.**
- **Tailscale (a) doesn't work:** [probed] every packet out of the VM goes through Anthropic's egress gateway.
- **What does work per the docs:** expose Citadel's tools as a **claude.ai custom connector** (a remote MCP server), which cloud sessions reach through Anthropic's servers. Add **HTTP hooks** that post the session's events to a narrow Citadel endpoint, authorised by a **network secret** the session never sees.
- **What that gets:** tools, cards, the shared folder (as tools) and a near-live stream.
- **What stays different:**
  - Start-up latency.
  - Steering lands only between turns, unconfirmed.
  - Stop goes through a different path, unconfirmed.
  - The stream is per line or per tool call, not per token, unconfirmed in a cloud VM.
  - The box's admin has to put an endpoint on the public internet.

## A1. Can a cloud session reach Citadel live?

### What the VM's network actually is [probed, 2026-11-27, on this session's Default environment, Limited]

- **No real egress outside the gateway.** `HTTPS_PROXY` is a local agent proxy. Raw TCP to any IP "connects", but the TLS certificate that comes back is issued by `O=Anthropic, CN=Egress Gateway SDS Issuing CA (production)`, for `1.1.1.1` and for example.com's IP alike. It's a transparent man-in-the-middle gateway.
  - Plain HTTP to `1.1.1.1:80` got the gateway's `426 Upgrade Required`.
- **UDP is answered by the gateway too.** UDP/53 to 1.1.1.1, 9.9.9.9 and OpenDNS all came back NXDOMAIN for example.com (rcode 3, no answers). Hosts that aren't allowed don't resolve at all: example.com, controlplane.tailscale.com, derp1.tailscale.com, pkgs.tailscale.com and stun.l.google.com. There is no raw UDP to the internet.
- **Docs:** sessions run "behind an HTTP/HTTPS network proxy for security and abuse prevention purposes". Three levels: None, Limited (allowlist), Full ("Any domain"). https://code.claude.com/docs/en/cloud-environments (2026-11-27).
- **Paths that skip the allowlist at any level:** GitHub, "MCP connectors you enable… because connector traffic travels through Anthropic's servers", the hosts of the environment's network secrets, and the Anthropic API. Same page.
- `/dev/net/tun` exists and the session is root, so a TUN device isn't the blocker. The network is.

### (a) The session joins our tailnet with a short-lived, locked-down key

- **Does it work per the docs? No, and the probe says no.**
  - WireGuard needs UDP. The gateway answers DNS itself and nothing else got out.
  - Tailscale's fallback is DERP relays over HTTPS. Control and DERP both use an HTTP `Upgrade` to their own protocols over TLS. Through a TLS-intercepting gateway that returned `426 Upgrade Required` on a plain request, I expect that to fail.
  - Tailscale's hosts would need adding under Limited, or Full. I didn't add them: that's an environment change for the owner to approve.
- **What it would take to try:**
  - Allow `controlplane.tailscale.com`, `login.tailscale.com`, `*.tailscale.com` (DERP) and `pkgs.tailscale.com`.
  - Install with the setup script.
  - Run `tailscaled --tun=userspace-networking` with `HTTPS_PROXY` set, and an ephemeral, tagged, pre-approved auth key.
  - An ACL that lets `tag:cloud` reach only `perigee:<tool port>`.
- **What it exposes:**
  - The auth key can't be a network secret (those are only attached as HTTP headers by the proxy), so it sits in an env var or the brief. "Anyone who uses the environment can read the values", and so can a prompt-injected session.
  - With an ephemeral, one-use key that expires in an hour and a one-port ACL, the blast radius is that port. That's still a tailnet node run by a VM you don't control.
- **Who sets it up:** the tailnet's admin (the person who runs the box and its network, not Cara): the tag, the ACL and key minting (an OAuth client that mints a key per session). Cara or each person: the environment's hosts and setup script.
- **Verdict:** don't build on it. Spend 20 minutes on a trial only if the admin wants to be sure. I'd bet on failure.

### (b) A narrow Citadel endpoint on the public internet that only cloud sessions can call

- **Does it work per the docs? Yes.**
  - Add the endpoint's host (say `citadel-cloud.example.org`) to the environment's **Allowed domains**. Or just put a **network secret** on that host: secret hosts are reachable at any level.
  - "Anthropic's agent proxy adds the key to requests for the hosts you list, after each request leaves the session's VM, so the key itself stays outside the VM." https://code.claude.com/docs/en/cloud-environments, "Add network secrets" (2026-11-27). Available on Pro, Max, Ultra, Team and Enterprise.
  - The session `curl`s the endpoint with no token in hand, and the proxy adds `Authorization: Bearer …`.
- **"Only cloud sessions can call it":**
  - The bearer secret gives that in practice. The session can't read it, and nobody else has it.
  - For an IP lock as well: Anthropic publishes outbound ranges, `160.79.104.0/21` and `153.61.208.0/20`, "for outbound requests (for example, when making MCP tool calls to external servers)". https://platform.claude.com/docs/en/api/ip-addresses (2026-11-27).
  - **Unconfirmed:** whether cloud-session VM traffic leaves from those ranges. The page names MCP calls, not session egress.
- **What it would take:**
  - A reverse proxy (TLS, a real hostname) in front of a small Citadel route set:
    - `POST /cloud/events` (a turn's stream)
    - `POST /cloud/card` (ask a question)
    - `GET /cloud/answer/<id>` (long-poll for the answer)
    - `GET/PUT /cloud/shared/<path>` (the shared folder, scoped to the minion)
    - a tool call proxy for the few Citadel tools a minion uses
  - A per-minion token: see the exposure below.
- **What it exposes:**
  - An internet-facing Citadel endpoint: TLS, auth, rate limits, logs.
  - A network secret is environment-wide: "The secret applies in every session that runs in the environment". So one secret covers every cloud session on that person's environment, and Citadel can't tell minion A from minion B by the secret alone.
  - The fix is two-part: the secret gets you in the door, and a per-minion capability token in the brief scopes what you may touch. A leaked brief token reaches one minion's endpoints, and only through the proxy, because it doesn't work without the secret.
  - The shared folder through it is the biggest exposure. Scope it to the minion's scheme, read-mostly.
- **Who sets it up:**
  - The box's admin: the DNS name, the reverse proxy, the port and firewall (optionally the IP ranges above), and the Citadel routes deployed.
  - Each person: the network secret on their own environment. The request form is a single host and token, and Citadel can show the value once for them to paste.

### (c) Citadel as a claude.ai custom connector (remote MCP server)

This is a third shape the docs point to, and the one I'd pick for tools.

- **Does it work per the docs? Yes, for tools.**
  - Connectors added at claude.ai/customize/connectors "are automatically available in Claude Code", and connector traffic "travels through Anthropic's servers rather than the session's network". https://code.claude.com/docs/en/mcp, "Use MCP servers from claude.ai"; https://code.claude.com/docs/en/cloud-environments (2026-11-27).
  - It works at network level None.
  - Long tool calls can be **MCP tasks** in cloud sessions: "MCP tasks work in the cloud with claude.ai connectors that support them on protocol revision 2026-07-28". That's how a mid-turn card can wait for its answer without hitting the 5-minute idle timeout on connector calls. https://code.claude.com/docs/en/mcp, "MCP tasks in cloud sessions" (2026-11-27).
- **What it would take:**
  - Citadel's MCP server (`src/mcp.ts`, today per-turn and local) served as a remote Streamable-HTTP MCP server with OAuth, so each person authorises the connector as themselves and Citadel's access rules apply unchanged.
  - Then `ask_question` becomes a task that resolves when the card is answered.
  - The Citadel tools a minion calls work as they do now.
  - The shared folder becomes tool calls (read, list, write) instead of file paths.
- **What it exposes:**
  - The same public endpoint as (b), but OAuth-authenticated and reachable from Anthropic's published outbound ranges, which are documented for MCP calls. So it can be firewalled to those ranges.
  - Each person's connector reaches what they can reach in Citadel.
  - A prompt-injected cloud session could call any tool that person could, the same as a local minion today.
- **Who sets it up:**
  - The box's admin: the public HTTPS endpoint.
  - A Citadel build: the remote MCP server with OAuth.
  - Each person: adds the connector once. On Team and Enterprise plans "only admins can add servers".
- **Its limit:** a connector gives tools. It doesn't give a live stream or steering. Those come from (b)'s hooks and `claude -p --cloud`.

## A2. Family 1: the minion stays home and the cloud is its backend

They're ranked. Each one **passes the test** unless it says otherwise. The common building block is **S0**.

**S0. `cloud-turn.mjs` as a step, not a turn.**
- Today the cloud *is* the turn, so chat, cards and the stream break.
- Turn the same start, poll and read-back code into a command a home minion runs, like `citadel-job` or a Grunt: `citadel-cloud run --brief <file> --branch …`. It prints progress lines while it waits and returns the result JSON as its output.
- The minion's chat, cards, steering and Stop stay exactly as they are.
- If the cloud fails, refuses or times out, it falls back to doing the step at home, so the person never sees a failure mode that's new to them.
- It runs on the minion's own person's login (sender pays, as now).
- **Size:** M. Most of the code exists (`cloudTurn`, `fetchResult`, `teleport`).

Ranked uses on top of S0, plus one that doesn't need a model at all:

1. **Model-free heavy jobs on GitHub-hosted runners behind `citadel-heavy`** (Part B idea 2).
   - Passes: the minion sees `citadel-heavy` take a little longer or shorter, and that's all.
   - It's not even a cloud session, and costs no plan usage.
   - Frees up to 17.8 + 19.3 + 5.9 h a week.
   - Size M. Blocked only by Actions minutes (unknown) and schemes not on GitHub.
2. **Long steps in the cloud with a model in the loop**, for when a step needs judgement while it runs (a flaky-test investigation, a long build that needs fixing midway).
   - Passes through S0.
   - Use the 2-hour background limit (Part B idea 1).
   - Size S on top of S0.
3. **Fan-out review for high-risk ships** (Part B idea 8).
   - The home minion's self-review sends 2–3 reviewer briefs through S0, waits, and merges the findings into its own review.
   - Passes: it reads as a longer self-review step.
   - Size S on top of S0.
4. **Speculative fixes, two or three drafts at once** (Part B idea 5).
   - The home minion starts 2–3 drafts through S0, runs their tests at home, and keeps one.
   - Passes: the person sees one minion that tried things and picked one.
   - Size S–M.
5. **Research fan-out from a home research minion.**
   - The minion splits its question into 3–5 parts, sends them through S0, and merges.
   - It keeps cards, the shared folder and Citadel's tools for itself.
   - Passes. It's the honest replacement for the cloud research first turn that Cara turned off.
   - Size S.
6. **Mutation, fuzz and bisect runs**, sliced and sent to runners (idea 1) or through S0 (Part B ideas 7, 18, 21).
   - Passes: they're jobs, like now.
   - Size S–M.
7. **Sharded prompt-eval and review-escapes benches** (Part B idea 9).
   - Passes: the asker sees the same report sooner.
   - Size S–M.
8. **Pre-drafted next minion** (Part B idea 12).
   - Passes: nothing is visible until go, then the minion starts from a branch.
   - Size M.
9. **Nightly audits and dependency upgrades** (Part B ideas 10, 11), run as backends of a home schedule.
   - The schedule's run stays home and files its results with Citadel's tools.
   - Passes. That's the fix for "a schedule's start stays home".
   - Size M.
10. **UI shots and other schemes' Linux builds** (Part B ideas 13, 23) through S0 or runners.
    - Passes.
    - Size S per scheme.

These **pass for chat, but not for everyone**:
- **Plan usage:** fan-out spends the person's own limits faster (F3). Use the same consent and ordering as Part B idea 14.

These **fail the test** as originally framed:
- The shipped cloud first turn for research, ideation and sweeps, and the cloud code drafts *as a minion's turn*. Rebuilt on S0 they pass.

## A3. Family 2: the minion runs in the cloud and still looks identical

What "identical" needs, item by item, using shapes (b) and (c):

| Need | How | Per docs? | Passes? |
|---|---|---|---|
| Citadel's tools | (c) connector | Yes | Yes |
| Mid-turn cards | (c) `ask_question` as an MCP task that resolves on answer | Yes (MCP tasks in cloud) | Likely. Unconfirmed until built. |
| Shared folder | (c) file tools, or (b) `/cloud/shared` | Yes | For the person, yes. The agent uses tools, not paths, so prompts differ. |
| Live stream | (b) **HTTP hooks** in the scheme repo's `.claude/settings.json`: `PreToolUse`, `PostToolUse`, `Stop`, and **`MessageDisplay`** ("Runs while an assistant message streams… the new text in `delta`") POST to `/cloud/events` | Hook types yes (https://code.claude.com/docs/en/hooks, 2026-11-27). Repo hooks run in cloud sessions, but "a session with several repositories doesn't load hooks from any repository" | Nearly. Per line, not per token. **Unconfirmed** that `MessageDisplay` fires in a cloud VM with no local screen. |
| Steering mid-turn | `claude -p "<msg>" --cloud <id>` "queues the message" | Yes, as a queue | **Unconfirmed** whether it lands mid-turn or only at the turn's end. Today's local steer lands mid-turn. |
| Stop | No documented CLI stop for a cloud session. The cloud-only tools have an `interrupt_session` | Not from home | **Fails** today. A `PreToolUse` HTTP hook could poll a stop flag and block every next tool, which is close. |
| Pictures and files in the first message | Upload through (b) or the connector | Buildable | Yes once built |
| Start latency | Cold start ~1 min (55 s onboarding in #2147), less with a cached setup (Part B idea 3) or a routine fire (Part B idea 4) | n/a | **Visible**: the first reply is about a minute later |

**Verdict:** family 2 nearly passes, at size **L**: a remote MCP server with OAuth, a public endpoint, the hook set committed to *every* scheme's repo (an every-scheme change), a stop hook and a per-minion token scheme. On top of that, the admin has to put Citadel on the public internet.

What it buys over family 1: the minion's *own* turns stop using a perigee worker (~250 MB and a slot each). Family 1 already moves the heavy part, which is where perigee's load is (65.5 heavy run-hours). So family 2 is worth it only if the worker count itself becomes the limit.

## A4. Part B's ideas against the test

| Part B idea | Passes as built on S0 or runners? |
|---|---|
| 1 Step limit to ~110 min | Yes (it's a S0 setting) |
| 2 GitHub-hosted runners | Yes, no cloud session at all |
| 3 Per-login environment and setup | Yes (makes S0 faster). Android through S0 passes too |
| 4 Routine `/fire` start | Yes (makes S0 robust) |
| 5 Speculative drafts | Yes |
| 6 Batching short jobs | Yes, but adds a wait for short checks the person may notice. Keep batches short. |
| 7 Mutation | Yes |
| 8 Fan-out review | Yes |
| 9 Sharded benches | Yes |
| 10 Nightly audits | Yes, as backends of a home schedule |
| 11 Dependency upgrades | Yes, same |
| 12 Pre-drafting | Yes |
| 13 Other schemes' builds | Yes |
| 14 Concurrency-aware line | Yes (invisible) |
| 15 Route by duration | Yes (invisible) |
| 16 Dispatcher cloud session | Yes, behind S0 |
| 17 Desktop as self-hosted environment | Yes. Runs on our own machine, so it reaches Citadel natively and passes family 2's test with no public endpoint. It doesn't add compute, though. |
| 18 Bisect | Yes |
| 19 Stress and flake hunting | Yes |
| 20 Deterministic benchmarks | Yes |
| 21 Property and fuzz | Yes |
| 22 Docs drafts | Yes through S0. **No** as a cloud minion of its own |
| 23 UI shots | Yes |
| 24 Managed Agents | Yes behind S0. It has a real read API too |

## A5. What I couldn't confirm for Part A

- **Tailscale over DERP/HTTPS through the gateway.** I didn't allow Tailscale's hosts, which would be an environment change for the owner to approve. My expectation is failure (the `426`), but it's untested.
- **Whether session VM egress leaves from Anthropic's published outbound IP ranges.** They're documented for MCP calls only.
- **Whether `MessageDisplay` and HTTP hooks fire in a cloud session**, and whether a hook's POST goes through the agent proxy with the network secret attached. I had no allowed endpoint of ours to test against.
- **Whether `claude -p --cloud <id>` lands a message mid-turn**, and whether there's any supported stop from home.
- **Whether a claude.ai connector's MCP task can wait hours for a card's answer** in a cloud session before the session counts as idle and is reclaimed. The docs say a session waiting on connector *approval* counts as inactive.
- **The real cost and latency of S0 steps.** I couldn't run a child session from here without spending the person's usage unasked.

---

# Part B: the first report

## Top 3 (first pass)

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

## B0. Facts that change the picture

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

## B1. Ranked ideas

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

## B2. Extending what's shipped or being built (not new ideas)

These aren't new ideas.

- **Research and ideation:**
  - With idea 16, a research minion can split itself into 3–5 sub-researchers (docs, code, web, numbers), each in its own session, and merge.
  - This report took one session plus one subagent. Subagents in-session are already a cheap fan-out with no extra VM.
- **Cloud code drafts:**
  - Pair them with idea 5 (race two drafts) and idea 12 (draft before go).
  - Let a draft session run the scheme's affected tests itself before pushing, with idea 1 for long ones.
- **Cloud flake runs:** give them idea 19's stress mode, and put the nightly sweep on a routine (idea 10/4) rather than a home schedule.
- **Test sweeps:** once idea 1 lands, the sweep kind's 25 min refusal should read about 110 min.

## B3. Problems I noticed in the shipped code (for #2153's owner; no change made)

These are for whoever owns #2153. I made no code change.

1. **`stepMinutes: 25` and its refusal text claim "a cloud session stops a background command at 30 minutes"**:
   - The docs say up to 2 h with a `timeout` (F1). The prompt also asks for foreground commands up to 25 min, but foreground caps at 10 min and then auto-backgrounds.
2. **Android is refused by rule:** with an environment that allows `dl.google.com` (F4), the rule could be a check of the login's environment instead.
3. **`--environment` isn't usable for `env_` ids (F6):** any plan to pick environments per scheme through the CLI won't work. Use a routine (idea 4) or a dispatcher (idea 16).
4. **The cost estimate is wall-clock-shaped (`costUsd.start` 0.40):** real cost is tokens (F3). For long compute steps it overstates. For chatty research it may understate. Measure a few sessions against the plan's usage page.

## B4. What I couldn't check from inside this session

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
- https://code.claude.com/docs/en/hooks (HTTP hooks, MessageDisplay)
- https://code.claude.com/docs/en/mcp (claude.ai connectors, MCP tasks in the cloud)
- https://code.claude.com/docs/en/channels
- https://platform.claude.com/docs/en/api/ip-addresses (outbound IP ranges)
- https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-max-or-ultra-plan
