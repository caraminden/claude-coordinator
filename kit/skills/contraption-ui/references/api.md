# Citadel's contraption API

Everything a contraption (an app Citadel serves at `/apps/<name>/`) gets from Citadel and gives it:
the proxy in front of it, the identity header, the calls its server makes to Citadel, the calls
Citadel makes to it, and how Citadel runs and deploys it. Checked line by line against Citadel's
code on 2026-11-08. This file is the current spec: a pasted copy, or the 2026-11-01 build brief,
is older. When Citadel's behaviour and this file disagree, ask your Taskmaster to tell Citadel's.

"Tested" after a rule means Citadel's own test suite checks it, so it holds until someone changes
the test on purpose.

- [The shape of it](#the-shape-of-it)
- [The registry entry](#the-registry-entry)
- [Your service's environment and keys](#your-services-environment-and-keys)
- [Requests from browsers: the `/apps/<name>/` proxy](#requests-from-browsers-the-appsname-proxy)
- [The identity header](#the-identity-header)
- [Calling Citadel from your server](#calling-citadel-from-your-server)
- [The turn API](#the-turn-api)
- [Asks: bug reports, feature asks and data](#asks-bug-reports-feature-asks-and-data)
- [Your home scheme and its minions](#your-home-scheme-and-its-minions)
- [The relay: calling another contraption](#the-relay-calling-another-contraption)
- [Embeddings: `POST /api/contraptions/embed`](#embeddings-post-apicontraptionsembed)
- [Saved secrets: `GET /api/contraptions/secrets/<name>`](#saved-secrets-get-apicontraptionssecretsname)
- [Sessions reading a person's data: `/app-api/read`](#sessions-reading-a-persons-data-app-apiread)
- [Big uploads: `/apps/_citadel/uploads/<name>`](#big-uploads-apps_citadeluploadsname)
- [What Citadel serves your pages](#what-citadel-serves-your-pages)
- [Heavy steps and disk use](#heavy-steps-and-disk-use)
- [Running and deploying: `citadel-app.json`](#running-and-deploying-citadel-appjson)
- [Limits at a glance](#limits-at-a-glance)
- [What changed since 2026-11-02](#what-changed-since-2026-11-02)

## The shape of it

- Your server listens on `127.0.0.1:$PORT` and serves everything under `$BASE_PATH`
  (`/apps/<name>`). Citadel's proxy hands it browser requests with the path unchanged.
- Each gated request carries `X-Citadel-Identity`, signed by Citadel; you verify it with your
  `identity.pub` and key the person's data on its `sub`.
- Your server calls Citadel at `$CITADEL_URL` with `Authorization: Bearer <contraption.key>` to run
  agent turns for a person, file asks with your home scheme, follow its minions' progress, and call
  other contraptions.
- Citadel runs your server as a systemd user service it writes from your repo's
  `citadel-app.json`, and deploys it from GitHub.
- Agent turns run on the person's own Claude (or Codex) sign-in, never anyone else's.

## The registry entry

An admin registers a contraption in Settings → Contraptions, or Citadel's own Taskmaster does it on
an admin's turn (`register_contraption`, `update_contraption`, `set_contraption_person`,
`rotate_contraption_keys`). Another scheme asks its Taskmaster to ask Citadel's.

| Field | What | Rules |
|---|---|---|
| `name` | Slug in every path and the key folder; never changes | `^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$`; not `mine`, `turns`, `sessions`, `asks`, `relay` or `scheme-<n>` |
| `title` | Shown in the rail and in Citadel's messages | 1 to 60 characters |
| `port` | Your server's port on 127.0.0.1 | 1024 to 65535 |
| `icon` | A path for the rail's tile, from your base, like `/icon.svg` | Starts with `/`. Every contraption has one: left empty, a deploy fills it from your manifest's first PNG icon |
| `home_scheme` | The scheme that builds it: asks go there, its minions deploy it | A scheme id |
| `open_paths` | Paths reached without a login or identity | Up to 20, each starting with `/`, relative to your base |
| `relay_paths` | Paths other contraptions may call through the relay | As `open_paths`; empty means none |
| `default_model` | Model for turns that name none | `^[\w.\[\]-]{1,60}$`, like `haiku` |
| `turn_cap` | Turns a person may start per day (server-local midnight) | 1 to 100,000, or none |
| `repo`, `branch`, `folder` | Where deploys come from and go | `owner/name`; default `main`; default `~/apps/<name>` |

Being in the home scheme grants no access to the app. Only people the contraption is **enabled
for** reach it, and disabling someone takes effect on their next request (tested).

## Your service's environment and keys

Citadel sets these on your service and its timers; `citadel-app.json` can't override them (tested):

| Variable | Value |
|---|---|
| `PORT` | The registry's port |
| `BASE_PATH` | `/apps/<name>` |
| `DATA_DIR` | `~/.local/share/<name>`, created empty (0700) on install or deploy if missing; never touched otherwise, except that big uploads land in its `uploads/<login>/` ("Big uploads") (tested) |
| `CITADEL_KEYS` | Your key folder |
| `CITADEL_URL` | Where your server calls Citadel: `http://127.0.0.1:8573` on the live box. Read it; don't hard-code it |
| `PATH` | mise's shims, `~/.local/bin`, then the system's |
| `CITADEL_HEAVY` | The command that runs a heavy step in a shared slot: `"$CITADEL_HEAVY" <command> [args...]` ("Heavy steps and disk use"). Set from your next install or deploy |
| `MISE_TRUSTED_CONFIG_PATHS` | Your app's folder, then any paths your manifest adds |

The key folder (0700) holds two files (0600), rewritten whenever an admin rotates the keys:

- `identity.pub`: Ed25519 public key, PEM (SPKI). Verifies `X-Citadel-Identity`.
- `contraption.key`: your bearer key, `ck_` plus 43 base64url characters, no trailing newline.

Rotating invalidates both at once; your service has to restart to read the new ones.

## Requests from browsers: the `/apps/<name>/` proxy

`/apps/<name>/<rest>` goes to `http://127.0.0.1:$PORT/apps/<name>/<rest>` with the prefix kept and
the query string intact; nothing is rewritten. `/apps/<name>` without the slash answers 302 to
`/apps/<name>/` (tested).

**Your own host** (#709, live): each contraption is served at `<name>.citadel.zip`, still under
`/apps/<name>/`, so its page is another origin from Citadel's and can't call Citadel's API or see its
login. That host serves only you, Citadel UI's files (`/apps/_citadel/`) and the sign-in handoff
(`/_citadel/enter`); `/` goes to `/apps/<name>/`. A page load of `/apps/<name>/` on Citadel's host goes
there, signed in: a one-time token swapped for your host's own cookie, `cc_app`, so people sign in to
Citadel once, not per app. A page load on your host of Citadel's paths or another app's (`/c/…`,
`/apps/toc/…`) goes to Citadel's host; a fetch of one is a 404. Writes and websockets on your host need
your own `Origin` (403 otherwise). Open paths' non-page requests (websockets, fetches) still work on
Citadel's host too. Without `APPS_DOMAIN` (dev copies, previews) you're served on Citadel's host as
before (tested: `test/app-hosts.test.ts`).

**Links to an app** (#827): link people to `https://<name>.citadel.zip/`; the app itself still serves
under `$BASE_PATH` (`/apps/<name>/`), and manifests, `id` and `scope` keep that path. Citadel's rail and
Releases page print the short link when `APPS_DOMAIN` is set, from `url` in `/api/contraptions/mine`.

On every request, open path or not:

- **Any `X-Citadel-*` header the client sent is removed first**, so a client can never claim an
  identity (tested, on gated paths, open paths and websockets).
- Citadel's `cc_session` and `cc_app` cookies are taken out of `Cookie`; your own cookies pass
  through. A `Set-Cookie` from you naming either, or with a `Domain=`, is dropped; your other cookies
  reach the browser, host-only (tested). On gated requests Citadel may add its own `Set-Cookie` renewing a session older than 7
  days (tested).
- `Authorization` passes through untouched: it's yours.
- Request bodies up to 20 MiB; bigger gets 413 (tested). For files past that, use big uploads (below). Answers stream as they come: server-sent
  events arrive event by event (tested), and a stream you drop ends the browser's too, so its
  `EventSource` reconnects (tested). Websocket upgrades are tunnelled on open and gated paths
  (tested).
- If your server doesn't answer: 502, `<title> is not answering`.

**Open paths** (the registry's `open_paths`) skip the login and carry **no** identity header. A
path matches when it equals an open path or sits under it; a path containing `%2e`, `%2f`, `%5c` or
`\` never matches (tested). List single files (`/icon-192.png`), never a folder you don't mean.

**Every other path is gated:**

| Situation | Answer (your server sees nothing) |
|---|---|
| Not signed in, a `GET` page load (`Accept: text/html`, not an upgrade) | 302 to Citadel's `/c/?next=<path>`, then back after login (through the sign-in handoff on your own host) |
| Not signed in, anything else | 401, `Not logged in` |
| Signed in, not enabled | 403, an HTML "You don't have access to <title>" page |
| Citadel can't open your signing key | 503 |
| Enabled | Forwarded with a fresh `X-Citadel-Identity` |

All but the 503 are tested. When someone is disabled, their open streams and websockets are closed within about
2 s (tested).

Inside Citadel's window your pages are shown in a frame beside the app rail, from your own host
(Citadel and your page talk by postMessage, which rail.js does); installed, they're their own app
(references/installing.md).

### Downloads

Your host's login cookie, `cc_app`, is `Partitioned` (CHIPS): in Citadel's frame it lives under the
site Citadel was opened on. When that isn't `citadel.zip` (Citadel opened at its other hostname),
Chrome sends a request from `<a download>`, with or without `target="_blank"`, outside that
partition, with no cookie: the gate answers 401 and Chrome shows "File wasn't available on site". A
plain new tab (`target="_blank"`) goes without it too, and falls back to signing in again through
Citadel's host. A navigation of the frame itself keeps the cookie (#986, each case run in headless
Chrome 2026-11-18). So a file people save from your server:

- is linked with a plain `<a href="api/desktop.zip">`, no `download`, no `target`, or opened from
  script with `location.href = 'api/desktop.zip'`;
- is answered with `Content-Disposition: attachment; filename="desktop.zip"`, which names the file and
  keeps your page in place (a type the browser can't show, like a zip, downloads without it too);
- streams from your server at any size: nothing is held in the page's memory, unlike fetch → Blob.

An error answer to such a link replaces your page in the frame, so link files that exist. `<a
download>` stays right for a `blob:` or `data:` URL your page built itself, which no request carries.

## The identity header

```
X-Citadel-Identity: v1.<base64url(JSON claims)>.<base64url(Ed25519 signature over "v1." + the claims part)>
```

| Claim | Meaning |
|---|---|
| `app` | Your name. Refuse a header naming another app |
| `sub` | The person's Citadel user id, a JSON number (an integer): stable, the key for their data. Apps that key folders or maps on it use `String(sub)` |
| `login`, `name` | Their login and display name, which can change |
| `iat`, `exp` | Seconds; `exp` is `iat + 60` |
| `from`, `fromTitle` | Only on a relayed call (the calling contraption's name and title) or a session read (`scheme-<id>` and the scheme's name) |

Verify on every gated request and refuse anything that fails. Any account on the box can reach
your port directly, so the header is the only proof of who's calling. This mirrors Citadel's own
check, which its tests run against forged, expired and other apps' headers:

```ts
import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pub = createPublicKey(readFileSync(join(process.env.CITADEL_KEYS!, 'identity.pub')));
const APP = process.env.BASE_PATH!.slice('/apps/'.length);

export function identity(header: string | undefined) {
  const m = /^v1\.([\w-]+)\.([\w-]+)$/.exec(header ?? '');
  if (!m) return null;
  try {
    if (!verify(null, Buffer.from(`v1.${m[1]}`), pub, Buffer.from(m[2], 'base64url'))) return null;
    const c = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
    return c.app === APP && typeof c.exp === 'number' && c.exp * 1000 > Date.now() ? c : null;
  } catch {
    return null;
  }
}
// identity(req.headers['x-citadel-identity'] as string | undefined)
```

A header with `from` isn't the person clicking in your UI: it's another contraption or a session
acting for them. Serve it only on the paths you opened for that (`relay_paths`, `/app-api/read`)
and treat `from: scheme-<id>` as read-only.

## Calling Citadel from your server

These rules hold for every route below (tested):

- **From your own server, on this machine:** the request must come from a loopback address, carry
  no `X-Forwarded-For` or `Forwarded` header and no `cc_session` cookie, or it gets 403. A browser,
  or anything through Caddy, can't call these routes.
- **With your key:** `Authorization: Bearer <contents of contraption.key>`; a missing or unknown key
  gets 401.
- **JSON in:** `Content-Type: application/json` (else 415), valid JSON (else 400 `Invalid JSON`),
  under the route's size limit (else 413).
- **Errors** come back as JSON `{ "error": "<message for a person>" }` with the status.
- **`person`** is the `sub` from the identity header you were given; Citadel trusts you to name the
  person you're acting for, and checks they have your app enabled.

## The turn API

Runs one agent turn for one of your people, on **their** linked Claude (in their own container, or
on the host for the server's owner), and streams its events back. There is no fallback to anyone
else's plan. Citadel keeps a meter (contraption, person, session name, start, end, outcome, token
counts), the session names, and for 14 days the turn's audit: the system text and prompt as sent
(with any messages sent during the turn), the reply's text, the model that ran, whether it ran
blind, how many images went with it (never the images) and your verdict. Each text over 100,000
characters is cut there, with a note saying how much. Your home scheme's Taskmaster reads the audit with its `contraption_turns` tool (ask it), and so does
the scheme's weekly app turns check (a minion Citadel schedules by itself once the scheme is home to an app, skipped
in a week with no turns); its members may read it through Citadel's API; nobody else does (no other minion), and it is never logged anywhere else, though Citadel's own
database backups hold it as long as they are kept. It holds no tool calls or tool results.
Deleting a session deletes its audit rows (tested).

### Start a turn: `POST /api/contraptions/turns`

Body up to 4,000,000 bytes:

```json
{
  "person": 3,
  "session": "acolyte",
  "fresh": false,
  "prompt": "Move my dentist to Thursday, same time.",
  "system": "You are Acolyte, …",
  "model": "haiku",
  "compactWindow": 40000,
  "mcp": [{ "name": "mandate", "path": "/apps/mandate/mcp", "headers": { "Authorization": "Bearer <a token you minted for this turn>" } }],
  "agents": { "max": 3, "model": "haiku" },
  "webSearch": false,
  "machines": true,
  "media": false,
  "timeoutSec": 180
}
```

| Field | Required | Rules and default |
|---|---|---|
| `person` | yes | A user id ≥ 1, enabled for your app |
| `session` | yes | `^[\w.:@-]{1,100}$`, your name for the conversation, per person |
| `prompt` | yes | Non-blank text |
| `fresh` | | `true` starts a new conversation under the same name; default `false` |
| `system` | | Text appended to the agent's system prompt; default none. Name your tools in it in full (`mcp__<server>__<tool>`): the agent can only call them by that name, and Citadel adds a line saying so after your text |
| `model` | | `^[\w.\[\]-]{1,60}$`; default the registry's `default_model`, else Claude Code's default. Per call, so each turn may pick its own |
| `compactWindow` | | Tokens before the conversation compacts: 10,000 to 1,000,000, default 40,000 |
| `mcp` | | Up to 10 servers: `name` (`^[A-Za-z0-9_-]{1,40}$`, unique), `path` (on your port, starting with `/`, at most 200 printable characters), `headers` (an object of header names matching `^[A-Za-z0-9-]{1,100}$` to values of at most 8,192 characters with no line breaks) |
| `agents` | | `false` (default) or `{ max, model }`: lets the agent start Grunts (the Agent tool), at most `max` (1 to 10, default 1) at once, nested ones included; `model` defaults to the turn's |
| `webSearch` | | `true` adds WebSearch and WebFetch for the agent and its Grunts; default `false`. WebFetch puts a web page in front of the model, so keep your write tools behind the person's explicit asks on such turns |
| `machines` | | `false` leaves out the person's online machines and the system prompt's note on them; default `true`. For a turn that must see only its prompt, such as a blind grader |
| `blind` | | `true` makes a turn whose context names no person or app: it runs in a random empty folder under `/tmp`, `system` is the whole system prompt (not an addition), and it is always fresh (no resume), without the person's machines, and on Claude only (a Codex model is refused, and "Enable Codex override" is ignored). **Not fully blind:** Claude Code still puts the person's Claude account email in the model's context (it fetches it from Anthropic with the person's token; no flag or setting turns it off, tested on 2.1.323), besides its own platform, OS and model lines. Your `mcp` server names and tool descriptions are yours: keep them neutral too. Default `false` |
| `keep` | | `true` keeps this turn for replay tests (Citadel #836) if it is among its session's first 5: the prompt exactly as you sent it, the agent's tool calls with their results, its reply, and a hash of `system`, in your home scheme's shared folder under `.replay/<app>/`. That folder is hidden from the Files view and only the scheme's minions read it, through the `citadel:replay` skill, when someone changes your agent's prompt or tools. Files go after 30 days, when you delete the session, and when the person turns "App chats for replay tests" off in Settings → Your account, which also stops keeping theirs. Nothing is kept for an app with no home scheme, and `keep` with `blind` is refused (`400`). The person's switch is a floor, not consent: send `keep` only for players who agreed to their chats being used to improve your app. Default `false` |
| `images` | | Up to 8 paths of image files inside your own `DATA_DIR` (absolute, or relative to it). Citadel shrinks each to at most 1568 px on the long side (never enlarges), re-encodes it as JPEG and puts it before the prompt in the turn's first message, on any turn including `blind: true`. Symlinks and `..` are resolved first: a path that lands outside `DATA_DIR` is refused with HTTP `400`. Caps, checked before the turn starts: more than 8 images, or more than 40 MB of files in total, is HTTP `413` and the message says whether it was the count or the total size; an unreadable or missing file is `400`. Claude turns only: with a Codex model, or the Codex override, the turn ends with `bad_request`. Nothing is kept beyond what a turn already keeps. Default none |
| `media` | | `true` gives the agent Citadel's image and sound tools, spending the person's own OpenRouter money, or their Codex plan for PNGs ("Media" below); default `false`. Your own `mcp` servers can't be called `citadel` then |
| `timeoutSec` | | 1 to 900, default 180 |

Each `mcp` server is reached as `http://127.0.0.1:$PORT<path>` (streamable HTTP) with your headers
as sent, from wherever the turn runs (containers share the host's network). The path is the raw
path on your port, so include your base path if your server routes under it. Check your own token
there: Citadel passes it through and never reads it.

**What the agent can use** (tested): your MCP servers' tools (`mcp__<name>__<tool>`), the person's
own machines that are online unless `machines` is `false` (their MCP servers, as `mcp__<machine>`;
a server of yours with the same name wins and the machine is left out), Agent if `agents` is set, WebSearch and WebFetch
if `webSearch` is `true`, and `mcp__citadel__generate_image`, `edit_image`, `generate_audio` and `generate_speech` if `media` is `true` (and `generate_image_codex` when the person has Codex). Nothing else: no shell, no files, no Citadel or scheme tools, no user
settings, CLAUDE.md, memory, skills or plugins. Each (contraption, person) gets an empty scratch
folder as its working directory.

**Models and Codex.** A Codex model id (`gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-luna`) runs the turn on
Codex in the person's container when they've linked Codex; otherwise the turn falls back to your
`default_model` (or Claude Code's default if that's a Codex id too). A person who switched on
"Enable Codex override" in Citadel's settings gets every turn on Codex, a Claude pick mapped by
tier (Opus/Fable to `gpt-6-astra`, Haiku to `gpt-6-luna`, the rest to `gpt-6.1-sol`). The events
are the same either way, and a session moves between the two with its history carried over. So
the model that runs may not be the one you asked for: `start` and `end` say which ran (tested).

**Sessions.** A name maps to one conversation per (contraption, person) and resumes it on the next
turn. `fresh: true`, or a conversation Citadel can no longer find (the person relinked their
Claude), starts a new one under the name, and the old transcript is deleted. Different names run
at once; one name runs one turn at a time (tested). No other contraption or person ever resumes
your sessions (tested).

### The answer: server-sent events

A body that isn't JSON gets a plain HTTP error (415, 400, 413) before the stream starts. Otherwise
the answer is `200 text/event-stream`, and every outcome, refusals included, is an event. The
last event is always `end` or `error`, then the stream closes.

| Event | Data |
|---|---|
| `start` | `{ turn, session, claudeSession, provider, model }`. `turn` is the id for cancel and messages. `provider` is `claude` or `codex`, and `model` the one that runs, after any fallback or override: as you asked (`haiku`), or `null` for Claude Code's default |
| `text` | `{ delta, parent: null, message }`: the top-level agent's words, streamed. A new `message` id is a new model message (a new paragraph either side of a tool call); never glue two messages' deltas. Grunts' words are never streamed |
| `tool` | `{ id, name, input, parent }`: `parent` is `null` at the top level, or the `id` of the Agent call whose Grunt made this call |
| `tool_result` | `{ id, ok, parent }`, never the tool's output (your tool produced it). A failed call (`ok: false`) adds `error`: the error text the agent saw, up to 2000 characters, so a call refused before it reached your tool (a timeout or refusal in the agent's MCP client or Citadel's relay) still says why |
| `media` | One per media tool call, before its `tool_result` ("Media" below) |
| `compacted` | `{}`: the conversation was compacted |
| `taken` | `{ id }`: the agent read a mid-turn message, `id` as its send returned |
| `end` | `{ stop, usage: { input, output, cacheRead, cacheWrite }, provider, model }`; usage adds up every reply in the turn, and `model` is the full name the agent reported (`claude-haiku-…`), else as in `start` |
| `error` | `{ code, message }`, `message` written for a person |

A Grunt that starts its own Grunt shows that Agent call under its own row, but the inner Grunt's
tool calls don't arrive.

| `error` code | When |
|---|---|
| `bad_request` | A field broke the rules above; `message` names it |
| `not_enabled` | The person doesn't have your app enabled |
| `no_plan` | They haven't linked their Claude in Citadel, or their sign-in was refused: they relink in Settings → Claude |
| `limit` | Your `turn_cap` for them today is used up, or their plan's usage limit was hit |
| `busy` | A turn is already running in that session |
| `timeout` | It ran past `timeoutSec` and was stopped |
| `canceled` | You cancelled it, or hung up before it started |
| `failed` | Anything else (the agent ended without a reply; a preview copy of Citadel, which runs no turns) |

**Hanging up** (closing the request) cancels the turn. **While your service restarts** (an
install, deploy, rollback, stop or restart), new turns wait to start until it is back (after a
deploy, until it passes its health check); running ones get up to 3 minutes to finish before the restart goes ahead and cuts them (tested).

### Cancel: `POST /api/contraptions/turns/<turn>/cancel`

`200 { "ok": true }`; the turn ends with `error` `canceled` (stopped with SIGTERM, then SIGKILL
after 2 s; tested). `404` when you have no such turn running.

### Message a running turn: `POST /api/contraptions/turns/<turn>/messages`

Body `{ "person": 3, "text": "…" }`, the turn's own person (tested).

| Answer | Meaning |
|---|---|
| `200 { "steered": true, "id": "<uuid>" }` | It went into the turn: the agent reads it between tool calls, or answers it after its reply in the same turn. `taken` with this `id` says it did; no `taken` by `end` or `error` means it never got there |
| `200 { "steered": false, "reason": "replied" }` | The reply is already out: send it as the next turn |
| `200 { "steered": false, "reason": "ended" }` | The turn has ended: send it as the next turn |
| `400` | No `person` or blank `text` |
| `403` | Not the turn's own person |
| `404` | No such turn of yours |

### Verdict: `POST /api/contraptions/turns/<turn>/verdict`

Optional. After you check a turn's reply, say whether you used it, so your scheme's Taskmaster can see
in the audit whether the model's words reached your people. Body `{ "verdict": "pass" }`
when the reply passed your check and you used it, or `{ "verdict": "fallback", "reason": "named a
person" }` when you used your own rule text in its place. `reason` is optional, up to 2000
characters; say which check failed, not the player's words. A later call replaces the earlier one.

| Answer | Meaning |
|---|---|
| `200 { "ok": true }` | Saved |
| `400` | `verdict` isn't `pass` or `fallback`, or `reason` is too long |
| `404` | No such turn of yours, or its audit is already gone (14 days, or its session was deleted) |

`<turn>` is the `turn` from the `start` event; it works once the turn has ended (tested).

### Sessions

- `GET /api/contraptions/sessions?person=3` → `[{ "name", "lastUsed", "busy" }]`, newest first;
  `lastUsed` in milliseconds since the epoch, `busy` while a turn runs in it.
- `DELETE /api/contraptions/sessions/<name>?person=3` (name URL-encoded) → `200 { "ok": true }`:
  forgets the name and deletes its transcript from the person's Claude folder (tested). `409
  { "error": "busy" }` while a turn runs in it; `404` when there's no such session.
- Both: `400` for a bad `person`, `403 { "error": "not_enabled" }` when your app isn't enabled for
  them.

### Media: images and sounds on the person's OpenRouter

A turn with `media: true` gets four tools from a server Citadel adds, named `citadel`:
`generate_image`, `edit_image` (an image already in the folder, changed as the prompt says),
`generate_audio` (`kind: "effect"` or `"music"`) and `generate_speech` (text read aloud by a
text-to-speech model: `model`, `input`, optional `voice`, `response_format` `mp3`/`wav`/`pcm`,
`instructions`, `speed`, and `out`). `input` reaches OpenRouter byte for byte, so inline
pronunciation markup (Fish's `<|phoneme_start|>…<|phoneme_end|>`, SSML, IPA) goes through
untouched; input over the model's limit is refused, never cut, and the cost is checked from its
length in UTF-8 bytes (tested, #808). They're the same tools minions have, run on the
Citadel server with the OpenRouter key the turn's `person` connected on their account page and
booked against their monthly cap: a call that would pass the cap, or could cost over $0.50, is
refused before anything is spent. The key never reaches the turn, the agent or your app.
They're offered even to a person who never connected OpenRouter, so the agent can say why it can't
make anything; every call is then refused with `openrouter_not_connected` (tested).

When the person has Codex set up in Citadel (their container signed in, or the server login's Codex
container), the turn also gets `generate_image_codex`: a PNG from Codex's built-in image generation
(OpenAI gpt-image) on their own ChatGPT plan, with no per-image charge. It takes `prompt`, `out`
(`.png`), `refs` (up to 5 images in the folder, to edit or take style from), `background:
"transparent"` (Codex's own transparency, no matte) and `overwrite`, and takes a minute or two. Its
description tells the agent to use it first for a PNG and fall back to `generate_image` when it's
refused with `codex_over_pace`. It writes to the same folder with a note and sends the same `media`
event, with `"model": "codex image_gen"`, `"cost_usd": 0` and no `left_usd` (tested with a stand-in
for Codex; no real Codex run was made).

Only turn it on where the person asked for generated art or sound (a spell-alert maker, say): it's
their money, and drawing in code is the default everywhere else.

**Where files go.** Each (contraption, person) has a media folder on the Citadel server. A tool's
`out` is a path inside it (`frost-alert.png`, `auras/frost-2.png`), and `image` and `refs` name files
already there, so a later turn in any session can edit an earlier take. Each file gets a
`<file>.json` note beside it (prompt, model, cost). With your key, for a person your app is enabled
for (`400` bad `person`, `403` not enabled):

| Call | Answer |
|---|---|
| `GET /api/contraptions/media?person=3` | `{ files: [{ path, bytes, modified }] }`, newest first, notes left out (tested) |
| `GET /api/contraptions/media/<path>?person=3` | The bytes with their content type; `<path>.json` is the note. `400` for a path outside the folder, `404` for none (tested) |
| `DELETE /api/contraptions/media/<path>?person=3` | `{ ok: true }`, the file and its note gone (tested) |

Files are swept 30 days after they were written. Copy what a person keeps into your own storage:
the folder is a work bench, not a library.

**The `media` event.** One per call, before that call's `tool_result` (tested):

```
event: media
data: { "tool": "generate_image", "ok": true, "files": [{ "path": "frost-alert.png", "bytes": 81234, "type": "image/png" }], "model": "black-forest-labs/flux-3-image-klein", "cost_usd": 0.009, "left_usd": 9.41 }

event: media
data: { "tool": "generate_image", "ok": false, "code": "openrouter_not_connected", "message": "…" }
```

A success may add `warnings` (text). It carries no `tool` event `id`, and may arrive just before
or after the call's `tool` event; it's always before the `tool_result`. The agent's error text
starts with the same `code`.

| `code` | Meaning |
|---|---|
| `openrouter_not_connected` | The person never connected OpenRouter: link them to `account_url` |
| `openrouter_key_refused` | OpenRouter refused their key; they connect it again at `account_url` |
| `over_cap` | It would pass their monthly cap; `message` says when it resets |
| `over_call_limit` | It could cost over $0.50 |
| `openrouter_refused` | OpenRouter said no: out of credit, or a limit they set on OpenRouter |
| `bad_request` | A bad argument; the agent usually fixes it and retries |
| `codex_over_pace` | `generate_image_codex` only: the person's Codex use is ahead of pace for their 5-hour or weekly limit, so it's left for their own work; the agent uses `generate_image` instead |
| `codex_not_ready` | `generate_image_codex` only: Codex can't run for them right now (not signed in, or their container isn't set up for it) |
| `failed` | OpenRouter or Codex didn't answer, or the call broke |

**Before a turn:** `GET /api/contraptions/openrouter?person=3` → `{ connected: false, account_url }`
or `{ connected: true, failed, cap_usd, spent_usd, left_usd, resets, account_url }`, never the key. `account_url` is Citadel's account page for them as a path on Citadel's host
(`/c/#/p/<scheme>/account`), or `null` when they see no scheme.

**Transparent images.** `background: "transparent"` on either image tool. A model with a transparent
background of its own (seedream, gpt-image-1, gpt-image-2.5 and up, gpt-5-image, riverflow) makes
real alpha; Citadel reads that from the model's endpoints on each call. Anything else (the Flux
default, Recraft, Gemini, gpt-image-2) is asked for a plain black background, and Citadel takes the
black out on the server: opacity from brightness. Right for glows and spell effects, wrong for icons
with dark parts, so ask for `bytedance-seed/seedream-5-0-flash` (about $0.02) for icons. `out` must
be `.png` (`.webp` too on a model with its own). The note's `background` says which ran (tested).

**Iterating on sound.** No OpenRouter audio model takes a clip to continue, extend or vary (checked
2026-11-14). Music on Lyria takes a `seed`: the same seed with a tweaked prompt keeps more of the
last clip. Effects iterate on the prompt alone; trim and fade on your side.

## Spend on outside APIs: `POST /api/contraptions/spend`

Your server pays for something Citadel can't see (Azure Speech, a paid data feed)? Report each
cost and it shows in your home scheme's monthly bill, per service, beside Claude usage and
OpenRouter. Citadel's own OpenRouter media and Claude turns are counted already: don't report those.

```
POST /api/contraptions/spend
Authorization: Bearer <contraption.key>
{ "service": "azure-speech", "usd": 0.42, "units": 31000, "note": "chapter 4" }
→ 200 { "month_usd": 61.8, "cap_usd": 80, "over_cap": false }
```

- `service`: 1 to 64 characters, lowercase and stable (`azure-speech`); the bill groups by it.
  `usd`: above 0, at most 10,000. `units` (any number of 0 or more) and `note` (500 characters) are
  optional and only kept for the record.
- Booked to the contraption's home scheme, to the calendar month in UTC. No home scheme: 409.
  A body that isn't valid: 400. Report after the paid call, with the cost you worked out yourself.
- A scheme can set a monthly cap (the usage popover, or `PUT /api/projects/<id>/spend {cap_usd}`).
  The first report that takes the month to the cap warns the scheme's members once that month
  (`over_cap: true` from then on). **Nothing stops**: the report is still booked, and you decide
  whether to keep going.
- Minions report theirs with the `report_spend` tool.

## Asks: bug reports, feature asks and data

`POST /api/contraptions/asks` sends a person's report to your home scheme, as them (tested):

```json
{ "person": 3, "kind": "feature", "text": "…", "summary": "One line", "item": "Fire aura", "files": [{ "name": "clip.peekclip", "data": "<base64>" }] }
```

| Field | Rules |
|---|---|
| `person` | Enabled for your app, else 403 |
| `kind` | `bug`, `feature` or `data` |
| `text` | Required for `bug` and `feature`, at most 10,000 characters; optional for `data` |
| `summary` | One line, at most 200 characters, shown in the Taskmaster's chat under a header with the whole ask behind a toggle. Default: the text's first sentence |
| `item` | One line, at most 100: what the ask is about (an aura, a list), shown in the header |
| `files` | Up to 20, each `{ name, data }` with `data` base64; at most 16 MiB decoded in all (413 past it). The whole request body is capped at about 23 MB (16 MiB in base64 plus 1 MB) |
| `minion` | Optional: a minion number in your home scheme. A `bug` or `feature` ask goes straight to that minion instead of the Taskmaster (below); 400 with `data` or anything but a whole number from 1 |

- **Bug and feature** go into the home scheme Taskmaster's chat, waking it, labelled with your app,
  the person and whether they're a member of that scheme. A non-member's feature ask is a proposal
  only, built once a member says go; their bug reports are worked as usual. Answers `202 { scheme,
  member, proposal, files }`. Your app never sees the Taskmaster's reply.
- **Straight to a minion** (`minion: N`): the ask goes into minion #N's chat under the person's
  name, with the same header and summary, and wakes it as their message would: the turn runs as
  them; if a turn is running it waits for the next one. The Taskmaster isn't told or woken. `kind` stays required and only labels it
  (bug report or feature ask). Members of the home scheme only (admins count): a non-member gets
  403, since their feature ask is only a proposal. 404 when the home scheme has no minion #N (a
  number from another scheme counts as none); 409 when #N is dismissed, which stays dismissed until
  a person reopens it. A minion parked on `start_after` answers the ask but keeps its brief held.
  Answers `202 { scheme, minion, member: true, proposal: false, files }`. It shares the bug and
  feature rate limit, and isn't a go to land: only words a person types in Citadel are.
- **Data** only files: no message, no wake. It writes a `<time>-ask.json` beside the files holding
  `{ contraption, person, item, summary, text, files, at }`. It needs at least one of files, text,
  summary or item (400). Answers `202 { scheme, member, proposal: false, files, sidecar }`.
- **Files** land in the home scheme's shared folder at `inbox/<contraption>/<login>/`, names made
  safe, with `-2`, `-3`… on a clash. `files` and `sidecar` in the answer are those paths, relative
  to the shared folder.
- **Rate limits** per person: 10 bug and feature asks in 10 minutes, 60 data asks in 10 minutes,
  then 429. Held in memory, so a Citadel restart resets them.
- `409` when your app has no home scheme.

## Your home scheme and its minions

Your server can ask whether a person is a member of your home scheme, and follow the progress of
its minions, say the ones your asks started (tested). Both are `GET`s with your key, under the
rules above, `person` in the query string.

**`GET /api/contraptions/home?person=<sub>`** answers `200 { id, name, member }`: your home
scheme's id and name, and whether the person is a member (in the scheme, or an admin). 403 when
your app isn't enabled for them, 400 for a `person` that isn't a whole number, 409 when your app
has no home scheme.

**`GET /api/contraptions/minions/<n>?person=<sub>`** answers minion #n of your home scheme:

```json
{
  "number": 12, "title": "Rune tooltips", "status": "running", "state": null, "note": null,
  "line": "Showing the rune cost… · 1 of 6 done",
  "step": { "n": 2, "of": 6, "done": 1, "label": "Showing the rune cost" },
  "activity_at": 1762700000000, "card_waiting": false, "card_since": null,
  "link": "/c/#/p/5/t/12"
}
```

| Field | Meaning |
|---|---|
| `status` | `new` (no turn yet), `running` (a turn is under way), `idle`, `error` (its last turn failed) or `closed` (dismissed) |
| `state` | Where its last turn left things, as the minions list shows it: `ready`, `try`, `parked`, `blocked`, `outside`, `pending-deploy`, `limited` (waiting out a usage limit) or `null`. Cleared when the next turn starts, except `pending-deploy` |
| `note` | Its own one-line status (at most 60 characters), or `null` |
| `line` | The minions list's progress line: `Showing the rune cost… · 1 of 6 done` while running, `Paused at: … · 1 of 6 done`, `Done · 6/6 steps`, `Working… Running commands · 1 of 6 done` (a new turn that hasn't moved its plan yet), `Working… Ran the tests`, `Finished · 14 actions`; `null` before any work |
| `step` | Its task list: the step under way (`n`, or the count done when none is), the total (`of`), how many are `done`, and the step's `label` (`null` between steps); `null` with no task list |
| `activity_at` | When its row last changed (a new progress line, a status or state), in milliseconds since 1970 |
| `card_waiting`, `card_since` | Whether a question or plan card is waiting on a person, and when the oldest was posted (milliseconds), else `false` and `null` |
| `link` | Where it opens in Citadel, below |

No chat text: `line`, `step` and `note` are what the minions list shows every member.

- **Members only:** a person who isn't a member of your home scheme gets 403, before anything about
  the minion, as does one your app isn't enabled for. Minion state is the scheme's business, so
  show it to whoever is looking only once Citadel says they may see it.
- 404 when your home scheme has no minion #n (a number from another scheme counts as none), 400
  for a number that isn't a whole number from 1, 409 with no home scheme.
- **Several at once:** `GET /api/contraptions/minions?person=<sub>&n=12,14,15` answers
  `200 { minions: [...] }`, each as above, in the order asked with repeats dropped; numbers your
  home scheme hasn't are left out. 1 to 50 numbers, else 400.
- **Polling:** both answer with an `ETag`. Send it back as `If-None-Match` and an unchanged answer
  is `304` with no body. Every few seconds while a minion is running, and a minute or so when
  it's idle, is plenty: the line changes as its steps do.
- **The link:** `/c/#/p/<scheme id>/t/<n>`, `link` in the answer, opens minion #n's chat in
  Citadel. Open it with `target="_top"`: your page runs inside Citadel's frame, and the link
  should replace Citadel's window, not your frame. Only members can open it, so show it only to
  them (`member` from `/home`).

## Your home scheme's CI files

Your server can read what your home scheme's CI runs keep in Citadel's CI store (the
`citadel:ci-store` skill): say the newest Windows build, to update your players' apps from. These
are the same routes the scheme's members use, called with your key under the rules above, and they
act for no one, so they take no `person` (tested):

- **`GET /api/projects/<scheme id>/ci-files`** lists the files, newest first, as
  `200 { files: [{ id, workflow, run_id, sha, ref, name, kind, target, size, sha256, created_at, url, … }], usage, rules }`.
  Filter with `workflow` (the file name, like `windows.yml`), `kind` (`build`, `report` or
  `release`), `target`, `name`, `run` and `commit` (a prefix).
- **`GET /api/projects/<scheme id>/ci-files/latest?…`**, the same filters, redirects (302) to the
  newest match's own URL, or with `json=1` answers `200 { file }`. 404 when nothing matches.
- **`GET <file's url>`** (`/api/projects/<scheme id>/ci-files/<id>/<name>`) answers the bytes.
  A file's URL stays the same until the store's rules delete it.

Only your home scheme: another scheme's id gets 403, as does any scheme when your app has none.
The scheme id is your registry entry's `home_scheme` (`id` from `/api/contraptions/home`); it
doesn't change, so keeping it in your config is fine. No key gets 401. Reading only: uploads
come from the scheme's CI jobs.

The newest build `windows.yml` made for target `windows`:

```js
const key = (await readFile(join(process.env.CITADEL_KEYS, 'contraption.key'), 'utf8')).trim();
const headers = { Authorization: `Bearer ${key}` };
const q = new URLSearchParams({ workflow: 'windows.yml', kind: 'build', target: 'windows', json: '1' });
const r = await fetch(`${process.env.CITADEL_URL}/api/projects/${SCHEME_ID}/ci-files/latest?${q}`, { headers });
if (r.status === 404) return null; // no build yet
const { file } = await r.json(); // { name, sha, sha256, size, created_at, url, … }
const bytes = await fetch(`${process.env.CITADEL_URL}${file.url}`, { headers }); // the file itself
```

Without `json=1`, `fetch` follows the redirect and keeps the `Authorization` header (same
origin), so one call gets the bytes; with it you can skip a download whose `sha256` you already
have.

## The relay: calling another contraption

`GET | PUT | POST | DELETE /api/contraptions/relay/<to>/<path>` from your server, with your bearer
key and `X-Citadel-Person: <user id>`. The query string is kept. Checks, in order (tested):

1. your key and the loopback rule (401, 403);
2. `<to>` registered and not you, else 404 `no_route`;
3. a valid `X-Citadel-Person`, else 400;
4. the person has both apps enabled, else 403 `not_enabled`;
5. `/<path>` under one of `<to>`'s `relay_paths`, else 404 `no_route`;
6. the body: JSON only (415), at most 64 KiB (413), none on a GET (400).

`<to>` gets the request at `/apps/<to>/<path>` with only `Content-Type`, `Accept` and a fresh
`X-Citadel-Identity` signed with **its own** key, carrying `from` (your name) and `fromTitle`
(tested). Your key and your `X-Citadel-*` headers never reach it. Its status, `Content-Type` and
body come back untouched, redirects included (not followed). 502 when it's down, 504 after 10 s
with no answer (tested); 503 when Citadel can't open `<to>`'s signing key. Citadel keeps no body.

To be called, have an admin list your paths in `relay_paths` (like `/app-api/`), and check `from`
on every one of them.

Mandate alone may call `scheme-<id>` at `/mandate-hook`, to tell a scheme its person ticked one of
the scheme's items.

## Jobs on a person's machine: `/api/contraptions/jobs`

Your server can queue a container job (usually for a GPU) on a machine lent to your home scheme
whose owner's `machine-agent.json` has a `jobs` block. The owner gets a go card in your home
scheme's Taskmaster chat and answers "Run in job hours", "Run now", "Always allow this kind" or
"No"; jobs run one at a time per machine, in its job hours (23:00 to 08:00 Pacific by default)
unless the owner said "now". A change to the kind (anything but its name) asks again.

- **`POST /api/contraptions/jobs`** `{ machine, kind, inputs?, limit_min?, when?, reason?, person? }`
  answers `201` with the job (below).
  - `kind`: `{ name, image, command: [args], reads?: [folder names], gpu? (true), network? (false), resumable? (false), max_limit_h }`.
    `image` is fully qualified and pinned by digest (`registry/name@sha256:<64 hex>`).
  - `inputs`: file paths inside your `DATA_DIR` (absolute or relative to it), at most 50 and 2 GB
    in all; they land read-only in the container's `/in`.
  - `when`: `"hours"` (default) or `"now"`, which needs `reason` and always asks the owner.
  - `person`: the Citadel user id it's for, shown on the card.
- **`GET /api/contraptions/jobs/<id>`** answers the job, plus `results: "jobs/<id>"`.
- **`POST /api/contraptions/jobs/<id>/stop`**: a waiting job ends at once; a running one is stopped
  on the machine.

A job: `{ id, machine, state, waits, kind, inputs, limit_s, when, reason, go, go_by, paused_by,
run_s, gpu_busy_s, gpu_pct, vram_mb, log_tail, exit_code, error, outputs: [{ path, size, uploaded }],
upload_bytes, created_at, started_at, ended_at }`. `state` is one of `needs-go`, `queued`,
`starting`, `running`, `paused`, `uploading`, `done`, `failed`, `stopped`, `refused`; `waits` says
why a queued one hasn't started ("machine offline", "outside job hours (opens 23:00 PST)",
"behind job #N", "machine paused"). Poll `GET` for the end; there is no callback yet.

What the job writes to `/out` lands in your `DATA_DIR/jobs/<id>/` (2 GB per job, 20 GB of results
per scheme; results older than 14 days are deleted). Another app's job answers 404. No home scheme
gets 409; a machine not lent to it, or without a `jobs` block, 404.

## Saved secrets: `GET /api/contraptions/secrets/<name>`

A password or key a person saved in Citadel (Settings → Your account → Secrets, or a minion's secret card),
for your server to use on their behalf: never ask for one in your own pages, and never put one in your
repo or `citadel-app.json`. From your server, with your bearer key:
`GET /api/contraptions/secrets/AZURE_SPEECH_KEY?person=3` → `{ "name": "AZURE_SPEECH_KEY", "scope":
"person" | "scheme", "value": "…" }` (tested).

- The person's own secret of that name first, then your home scheme's.
- Names are a letter then letters, digits or underscores, at most 64, case-insensitive
  (`azure_key` is `AZURE_KEY`).
- 404 when neither has it, 403 when the person isn't one of yours.
- Keep the value in memory, never in a log, a page or your data dir.

## Embeddings: `POST /api/contraptions/embed`

For searching your own data by meaning, with the same local model Citadel's memory uses
(Qwen3-Embedding-0.6B on perigee's CPU, so nothing leaves the box). From your server, with your
bearer key: `{ "texts": ["…", "…"] }` → `{ "model": "Qwen3-Embedding-0.6B-Q8_0", "vectors":
[[…], […]] }`, one unit-length vector (1,024 numbers) per text, in order (tested). Rank by the dot
product.

- 1 to 16 non-empty texts of at most 4,000 characters each, else 400 (tested): chunk longer things
  yourself. 503 when the embedding service is down.
- Store `model` with each vector, and embed everything again when it changes: vectors from two
  models don't compare.
- The model wants an instruction on the **query** side only, as part of the text:
  `Instruct: Given a question about my notes, retrieve the notes that answer it\nQuery: <the question>`.
  Embed what you index without it.
- It's CPU work shared with Citadel, about 7 CPU-seconds per 500 tokens of text, so index in the background, a
  batch at a time, never while a person waits.

## Sessions reading a person's data: `/app-api/read`

Citadel's minions and Taskmasters have a `contraption_read` tool. When a person asks one about
their own data in your app, Citadel calls your server directly (not through the relay), signed with
your key as that person, `from: scheme-<id>`. Only for the person whose own typed message the
session answers, with your app enabled. Implement both or neither:

- `GET $BASE_PATH/app-api/read` → `[{ "name", "description", "input_schema" }]`; names
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, `input_schema` a JSON Schema for the args.
- `POST $BASE_PATH/app-api/read/<command>` with the args as a JSON object (`{}` when none) → the
  command's JSON. Unknown command: 404. Not a read, or not for this caller: 403.

Nothing under `/app-api/read` may change data. Citadel waits 15 s and passes back at most 64 KB,
marked cut, so give commands args that narrow the answer. No `/app-api/read` (404) tells the session
your app offers no reads.

## Big uploads: `/apps/_citadel/uploads/<name>`

For files past the proxy's 20 MiB (a trip's videos, a folder of photos): the page sends them to Citadel in
chunks, Citadel puts each finished file in your `DATA_DIR`, then tells your server. Your server never
handles the bytes. In the page, `ui/upload.js`'s `mountUpload()` does all of it (a drop zone with file
and folder pickers, progress, pause and resume; [upload.md](upload.md)); these are its calls, on your own
host only, under the same gate as your pages (signed in, your app enabled for them, same origin):

- `POST /apps/_citadel/uploads/<name>` `{ "name", "size", "folder"? }` → 201 `{ id, offset: 0, size, chunk }`.
  `folder` is a path under the person's uploads (`"Japan 2026/day 1"`, at most 8 deep, no part starting
  with a dot). 507 when the file would take the server's disk below its floor (50 GB free, counting
  the uploads already under way).
- `GET …/<id>` → `{ id, offset, size }`: how many bytes Citadel has.
- `PUT …/<id>?offset=<n>` with the next bytes (at most 16 MiB; the kit sends 8) → `{ id, offset, size }`.
  A wrong offset, or a chunk still landing, is a 409: GET and go on from its offset. A connection that
  breaks off keeps what arrived. The last chunk's answer is the finished file:
  `{ done: true, path, name, size, app: { status, answer } }`.
- `DELETE …/<id>` → 204, what arrived deleted. An upload untouched for 3 days goes the same way.

The finished file lands at `DATA_DIR/uploads/<login>/<folder>/<name>`: the name cleaned (no slashes,
leading dots or brackets), and never over a file already there (`IMG_1 (2).jpg`). Then Citadel calls
your server, signed as the person who sent it:

- `POST $BASE_PATH/app-api/uploaded` `{ "path", "name", "size", "folder" }`, `path` relative to
  `DATA_DIR` (`"uploads/cara/Japan 2026/IMG_1.jpg"`). Move it, import it or leave it there; it's yours.
  Your answer (JSON or text, 64 KB at most, within 15 s) goes back to the page as
  `app: { status, answer }`, so the page can show what you made of it. No such route, or a failure, still
  leaves the file in place (`status` 404, or 502 when you didn't answer).

Someone else's upload id is a 404, as is one for another app. Citadel never logs a file's name or
contents.

## What Citadel serves your pages

Under `/apps/_citadel/`, no login, `Cache-Control: no-cache` with an ETag, live on every Citadel
deploy:

| Path | Exports |
|---|---|
| `theme.css` | The `--citadel-*` tokens, light and dark |
| `rail.js`, `rail.d.ts` | `mountRail`, `hideRail`, `showRail`, `openRail`, `closeRail`, `leaveEdge`, `hasRail`, `railItems`, `opensApart`, `installMode`, `chromeIntent` |
| `drawers.js`, `drawers.d.ts` | `initDrawers`, `NARROW`, `EDGE`, `classify`, `settleOpen`, `edgeSide` |
| `appswitch.js` | Loaded by the rail (the Alt+` switcher) |
| `reorder.js` | Loaded by the rail: drag (or Alt+Up and Alt+Down) to put your apps in your own order, saved to `PUT /api/me/order/apps` |
| `ui/base.css` | The `cui-*` parts |
| `ui/markdown.js` | `renderMarkdown`, `markdownElement`, `updateMarkdown`, `markdownLine`, `slug`, `copyText` |
| `ui/chat.js` | `mountChat`, `renderChat`, `chatModel`, `stepMark`, `gruntName`, `duration` |
| `ui/composer.js` | `mountComposer`, `fitHeight`, `listEnter`, `continueList` |
| `ui/tip.js` | `mountTips`, `placeTip`, `TipCache` |
| `ui/status.js` | `statusSlot`, `steadyLabel`, `toast`, `statusSlotHtml`, `statusTextHtml`, `statusWorkingHtml`, `steadyLabelHtml` |
| `ui/dialog.js` | `mountDialogs` |
| `ui/optimistic.js` | `optimistic` |
| `ui/upload.js` | `mountUpload`, `startUpload`, `droppedFiles`, `formatBytes` |

Each `ui/*.js` has a `.d.ts` beside it. Exports, classes and token names only ever get added: a
contract test holds them. How to use each one is in this skill's SKILL.md table and the references
it links. `ui/chat.js` takes the turn API's events above as they come.

The rail draws from `GET /apps/_citadel/api/mine` on your own host (the browser's own login, not
your key): `{ name, citadel, apps: [{ name, title, icon, up }] }`, the person's name, Citadel's
address (null when you're on Citadel's host), and the apps enabled for them, `up` false when its
service doesn't answer. Their icons come from `/apps/_citadel/icon/<name>`, fetched by Citadel.

## Heavy steps and disk use

**Heavy steps.** A service or timer step that eats CPU or memory for a while (an encode, an index
rebuild, a big import) runs through `$CITADEL_HEAVY`, so it takes one of the box's few heavy slots
that minions' builds and test suites share, and waits in line when they are full:

```sh
"$CITADEL_HEAVY" ffmpeg -i in.wav out.opus     # from a timer's command or your own child process
```

- Your app shows in the line and in the slots' history as `<name> (app)`. The step's output, stdin
  and exit status pass through.
- **A hold is capped at 10 minutes.** Past it the step gets SIGTERM, then SIGKILL 30 s later, and
  the command exits 124. Split long work into steps that each fit, and call `$CITADEL_HEAVY` once
  per step.
- **All apps together hold at most one slot.** A second app's step waits for the first to end
  before it joins the line, so apps never keep minions waiting for more than one slot.
- 75: no slot came free within an hour. Retry later.
- Never `flock` Citadel's `.heavy` folder yourself: `$CITADEL_HEAVY` is the supported way in.

**Disk use.** Citadel measures each app's `DATA_DIR` in the background (from 2 minutes after a
restart, then every 30 minutes, at idle priority) and shows it in Settings → Contraptions. Set
`disk_warn_gb` in `citadel-app.json` to mark the card when you pass it. Your server can read its
own figure, which costs nothing on the request:

```
GET /api/contraptions/disk
Authorization: Bearer <contraption.key>
→ 200 { "data_bytes": 12884901888, "measured_at": "2026-11-17T01:30:00.000Z", "warn_gb": 100,
        "free_bytes": 812345678848, "total_bytes": 2000398934016 }
```

- `data_bytes`, `measured_at` and `warn_gb` are from the last measure: all `null` before the first one,
  and `data_bytes` is `null` while `DATA_DIR` doesn't exist. `free_bytes` and `total_bytes` are the
  disk under `DATA_DIR`, read now.
- Big uploads are refused below 50 GB free ("Big uploads"); check `free_bytes` before a big write of your own.

## Running and deploying: `citadel-app.json`

Put `citadel-app.json` at your repo's root. Citadel writes `citadel-app-<name>.service` (and
`citadel-app-<name>-<job>.service`/`.timer` per timer) from it; you never write a unit.

```json
{
  "build": ["npm ci"],
  "build_timeout": 20,
  "start": ["node", "src/server.ts"],
  "workdir": ".",
  "env": { "VAPID_KEYS": "~/.config/myapp/vapid.json" },
  "timers": { "backup": { "command": ["node", "tools/backup.ts", "${DATA_DIR}"], "on_calendar": "*-*-* 03:30:00" } },
  "health": "/apps/myapp/health",
  "disk_warn_gb": 100
}
```

| Field | Rules |
|---|---|
| `start` (required) | 1 to 50 words; the first is an absolute path or a program name, found on `PATH` above (so `node` is your `.mise.toml`'s). An argument starting `~/` is under the home folder; `${VAR}` expands from the environment |
| `workdir` | A folder inside the repo, default the root |
| `env` | `NAME: "one line"` (at most 1,000 characters); `~/` at the start of a value is the home folder. Can't set `PORT`, `DATA_DIR`, `CITADEL_KEYS`, `CITADEL_URL`, `BASE_PATH`, `PATH` or `CITADEL_HEAVY` |
| `timers` | Up to 5 jobs named `^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?$`, each `{ command, on_calendar, workdir? }`; systemd calendar syntax (`daily`, `*-*-* 03:30:00`); same environment; a run missed while the box was off happens at boot |
| `health` | A path on your port as your server sees it (include your base path) that answers 2xx once up. Without it, an open port counts |
| `build` | Up to 20 shell commands, run in the repo root in order at nice 10, with `PATH` as above and none of Citadel's variables (no `PORT`, `DATA_DIR`). Each runs in a heavy slot (shown as `<name> deploy`) in its own systemd unit, `citadel-build-<name>.service`, so a Citadel restart doesn't kill it. Any failing fails the deploy |
| `build_timeout` | Whole minutes for the whole build, 1 to 60, default 20. Time waiting in line for a heavy slot doesn't count |
| `disk_warn_gb` | A number of GB above 0: Settings marks the app once its `DATA_DIR` passes it ("Heavy steps and disk use") |
| `migrations` | Up to 20 paths in the repo (folders or files) that change your data's shape, like `["src/migrations", "src/schema.ts"]`. A Roll back to last green past a commit that touched one is refused (below) |

The service restarts 5 s after any exit and starts with the box. Citadel never reads or writes
your `DATA_DIR` beyond creating it when missing.

**Deploying.** An admin sets `repo`, `branch` and `folder` and installs the service once. After
that your home scheme's Taskmaster and minions have `deploy_contraption`. A land handed off
with `hand_off_land` deploys it by itself and reports the outcome, and auto-deploy covers main
5 minutes after it last moved, so the tool is for redeploys outside a land. It deploys what is on
GitHub, so push first. A deploy (tested):

1. checks out the branch's new commit in the idle one of two checkouts, `~/apps/.<name>/a` and
   `/b` (the folder, `~/apps/<name>`, is a link to the live one; a deploy turns a plain folder into
   `a` first), and refuses, changing nothing, on local changes or untracked files that aren't
   ignored in either, commits the branch doesn't have, another branch or another origin (keep build
   output in `.gitignore`);
2. runs the build there, while the live build keeps running untouched;
3. holds new turns, waits up to 3 minutes for running ones, points the folder at the new checkout,
   rewrites the units and restarts the service;
4. waits up to 60 s for the health path to answer, twice a few seconds apart.

If 2 fails, nothing changed and nothing restarts (`failed`); the log names how the step ended (its
exit status, or the signal that killed it, like `killed by SIGKILL`) and quotes its last lines.
Deploys of one app never overlap: a second waits for (or is refused while) the first runs. If Citadel
itself restarts mid-deploy, the build keeps running in its unit; once Citadel is back, the deploy
starts again (once), waiting for that build to end first. If 3 or 4 fail, it points the folder
back at the old checkout and restarts that as it was built, with no rebuild (`rolled back`); a
first deploy has nothing to roll back to (`failed`). Each checkout keeps its own build output, so
an app takes about twice the disk. Anything the app writes belongs in its `DATA_DIR`, never the
repo folder: the next deploy runs from the other checkout. To undo the layout by hand: deploy
until `a` is the live one (`b`'s git lives in `a`), stop the app, `rm ~/apps/<name>` (the link),
`mv ~/apps/.<name>/a ~/apps/<name>`, `rm -rf ~/apps/.<name>`, `git -C ~/apps/<name> worktree
prune`, and install it again. The tool returns what happened and the end
of the log. After a good deploy it checks the two things every contraption ships with (Cara,
2026-11-09: "both of these should be the default behavior for new contraptions"):

- **A rail icon.** An empty registry `icon` is set to your manifest's first PNG icon that loads.
- **A web manifest that installs you as your own app** (rules in references/installing.md).

What's still missing comes back first in the tool's answer as **To do** lines, shows under the
deploy in Settings, and goes to your home scheme's Taskmaster as a to-do (once per new list, and not
when that Taskmaster deployed it itself). It never fails the deploy, so a first shell can ship.

**Roll back to last green.** While your app runs a commit newer than your home scheme's last green
(the newest commit on its default branch whose every CI workflow passed), its Releases card offers
**Roll back to last green**. Any member can press it: it deploys that commit as above (steps 1 to 4,
the same two checkouts), refusing one off the branch or past a change to a `migrations` path, since
code that old may not read data a newer one wrote (Cara, 2026-11-18: "App lists its migrations").
Once it is live, auto-deploy leaves the app there until main has a newer green commit, and a
minion's or Taskmaster's `deploy_contraption` is refused meanwhile; a person's Deploy on the card ships main at
once. Your home scheme's Taskmaster is told either way. With no CI, there is no last green and no
button.

Service status, start, stop, restart, its journal and installing over a hand-made unit are
admin-only (Settings → Contraptions, or Citadel's Taskmaster's `contraption_service`).

### Release targets: `targets`

Any scheme's `citadel-app.json` on the default branch, not only a contraption's, may tune the
release targets Citadel finds on its own (the Releases page and each minion's Deploying row). Each
entry names a found target by its `id` (the Releases page shows it, e.g. `ci:windows:release`):

```json
{ "targets": [
  { "id": "main", "hidden": true },
  { "id": "ci:windows:release", "name": "Windows", "paths": ["companion/"],
    "release": { "name": "Build {n}", "number": "run", "needs": ["desktop.yml"] } }
] }
```

`name`, `link` and `hidden` rename, relink or hide it; `paths` names the folders it ships, so only
changes there count. `release.name` (with `{n}`) and `release.number` (`run` or `count`) set how its
releases are named. `release.needs` lists workflow files that must also be green on the same commit
before a build counts as reaching people (#1019): a CI target whose installer only goes out once
another workflow passes lists that workflow here, or its minions leave Deploying too early.

**A target is live only when the people it's for can get that version** (Cara, 2026-11-18:
"Released should mean actually released"). Check each target against the path people really
update by: a PC updater, an app's update banner, a store, a download link. If that path waits on
anything after the build (another workflow, a publish step, a feed), the target must wait on it
too: `release.needs` for another workflow. Citadel doesn't wait on every workflow by default,
because a newer push often cancels a run, schedules and path filters skip commits, and an unrelated
red would hold a real release. So name what your updater gates on.

## Limits at a glance

| What | Limit |
|---|---|
| Proxied request body | 20 MiB |
| Big upload | any size, in chunks of at most 16 MiB; refused below 50 GB free on the server; kept 3 days untouched |
| `/app-api/uploaded` timeout, answer | 15 s, 64 KB |
| Identity header lifetime | 60 s |
| Turn request body | 4,000,000 bytes |
| Turn `timeoutSec` | 1 to 900, default 180 |
| Turn `mcp` servers | 10 |
| Turn `agents.max` | 1 to 10 |
| Turns a day | the registry's `turn_cap`, per person |
| Media call | $0.50 worst case, within the person's own monthly cap ($0 on Codex, within their Codex pace); files kept 30 days |
| Restart wait for running turns | 3 minutes |
| Turn audit kept, text kept, verdict reason | 14 days, 100,000 characters each, 2000 characters |
| Ask files | 20 files, 16 MiB decoded |
| Ask text, summary, item | 10,000, 200, 100 characters |
| Asks per person per 10 minutes | 10 bug/feature, 60 data |
| Minions in one list read | 50 |
| Relay body, timeout | 64 KiB, 10 s |
| Embed call | 16 texts of 4,000 characters |
| `/app-api/read` timeout, answer | 15 s, 64 KB |
| Open paths, relay paths | 20 each |
| Timers | 5 |
| Build | 1 to 60 minutes, default 20, not counting the wait for a heavy slot |
| `$CITADEL_HEAVY` hold | 10 minutes; one slot for all apps together |
| Disk measure | every 30 minutes |
| Job inputs, results | 50 files and 2 GB; 2 GB per job, 20 GB per scheme, kept 14 days |
| Job limit | the kind's `max_limit_h`, at most the machine's (12 h unless its owner says more) |
| Health wait | 60 s |

## What changed since 2026-11-02

Newest first.

- **2026-11-18:** Roll back to last green on your Releases card, and `migrations` in
  `citadel-app.json` to stop one going back past a data change ("Running and deploying").
- **2026-11-18:** The rule for release targets: a target is live only when its people can get that version ("Release targets").
- **2026-11-18:** A release target can wait on other workflows: `targets[].release.needs` in
  `citadel-app.json` ("Release targets").
- **2026-11-18:** Downloads from your server load in the frame: a plain `<a href>` with no
  `download` or `target`, answered with `Content-Disposition: attachment`. `<a download>` into your
  host fails in Chrome when Citadel is opened at its other hostname ("Downloads", contraption-ui rule 25).

- **2026-11-16:** Jobs on a person's machine, usually for its GPU: `POST /api/contraptions/jobs`, `GET` and `stop` on one, with the owner's go card in your home scheme's Taskmaster chat and results in `DATA_DIR/jobs/<id>/` ("Jobs on a person's machine").
- **2026-11-16:** `$CITADEL_HEAVY <command>` runs a heavy step of your service or timers in a shared
  slot, capped at 10 minutes a hold; `disk_warn_gb` in `citadel-app.json`, and
  `GET /api/contraptions/disk` for your `DATA_DIR` size and the free disk ("Heavy steps and disk
  use"). Deploy builds run in a heavy slot in their own unit, survive a Citadel restart, and a
  failed step's log names the signal and its last lines ("Running and deploying").
- **2026-11-16:** `GET /api/contraptions/secrets/<name>?person=` reads a password or key a person saved
  in Citadel, theirs first, then your home scheme's ("Saved secrets").
- **2026-11-16:** Citadel keeps each turn's text for 14 days for your home scheme's Taskmaster
  to read (`contraption_turns`), and `POST /api/contraptions/turns/<turn>/verdict` records whether your
  check passed the reply or you fell back to your own text ("Verdict").
- **2026-11-16:** `POST /api/contraptions/spend` books what an outside API cost to the home scheme's
  monthly bill, with an optional cap that warns without stopping ("Spend on outside APIs").
- **2026-11-16:** Big uploads: files of any size from the page into your `DATA_DIR/uploads/<login>/`,
  in resumable chunks, then `POST /app-api/uploaded` ("Big uploads"); `ui/upload.js` is the drop zone.
- **2026-11-14:** `media: true` on a turn gives the agent image and sound tools on the person's own
  OpenRouter key and cap, with a media folder you read through `/api/contraptions/media`, a `media`
  event per call and `GET /api/contraptions/openrouter` to check before a turn ("Media"). A person with
  Codex also gets `generate_image_codex`, PNGs on their ChatGPT plan.
- **2026-11-14:** Each contraption is served on its own host, `<name>.citadel.zip`, signed in through
  Citadel with no second login ("Requests from browsers", "Your own host"). Allow Citadel's hosts to
  frame you (no `X-Frame-Options`, no `frame-ancestors 'self'`). Your installed app, service worker,
  storage and push subscriptions start over once on the new host. The rail reads
  `/apps/_citadel/api/mine`.

- **2026-11-13:** Your server reads your home scheme's CI files (`/api/projects/<id>/ci-files`,
  `/latest` and each file's URL) with your key.
- **2026-11-13:** A failed call's `tool_result` event carries `error`, the error text the agent saw
  (up to 2000 characters).
- **2026-11-10:** `POST /api/contraptions/embed` turns texts into vectors with Citadel's local
  embedding model, for search by meaning over your own data.
- **2026-11-09:** `GET /api/contraptions/home` says whether a person is a member of your home
  scheme, and `GET /api/contraptions/minions/<n>` (or `?n=` for several) gives members a minion's
  status, state, step and waiting card, with ETags for cheap polling.
- **2026-11-09:** Every contraption ships a rail icon and a web manifest: the starter has both
  (stand-in icons to redraw), a deploy fills an empty registry icon from your manifest, and what's
  still missing is a To do for your home scheme's Taskmaster rather than a warning in the log.
- **2026-11-08:** Asks take `minion: N` to go straight to one of your home scheme's minions,
  members only, with no Taskmaster in the path.
- **2026-11-08:** Turns' `start` and `end` say which `provider` and `model` ran, and `machines:
  false` leaves the person's machines out of a turn. `ui/optimistic.js`'s `optimistic({ key, apply, send, undo, label })` for clicks
  that show their result at once and roll back with a Retry toast; `toast()` takes `action` and
  `onHide`. `ui/dialog.js`'s `mountDialogs()` and the `cui-dialog` part.
- **2026-11-07:** Using an app renews a Citadel session older than 7 days (a `Set-Cookie` on
  gated answers), so active people stay signed in.
- **2026-11-05:**
  - Turns take **messages mid-turn**: `POST /api/contraptions/turns/<turn>/messages` and the
    `taken` event; `end`'s usage adds up every reply.
  - `webSearch: true` on a turn adds WebSearch and WebFetch.
  - Turns run on **Codex** for a Codex model id or a person's Codex override.
  - **Restarts wait for turns:** install, deploy, rollback, stop and restart hold new turns and
    give running ones up to 3 minutes. A cancelled turn is killed 2 s after SIGTERM.
  - Asks take `summary` and `item`, and the Taskmaster's chat shows them collapsed.
  - `kind: "data"` asks file with a `<time>-ask.json` sidecar, waking no one.
  - The install check after a deploy also wants a name, an installable `display`, and 192 and
    512 px PNG icons.
  - `ui/markdown.js` puts a Copy button on fenced code blocks.
- **2026-11-04:**
  - Turns get the person's own online **machines** as MCP servers.
  - `contraption_read` and the `/app-api/read` contract.
  - A deploy checks the app installs as its own app.
  - `ui/tip.js` (tooltips) and `ui/status.js` (`statusSlot`, `steadyLabel`, `toast`).
  - The rail retries a greyed-out app every 15 s, and an installed app's rail opens other apps in
    its own window.
- **2026-11-03:** Your service restarts after any exit (`Restart=always`), not only a failure, so
  a server that exits 0 comes back too. `cui-switch`, `cui-busy` and skeletons in `ui/base.css`;
  `mountChat`'s `block()` gets the whole `tool_result` data.
- **2026-11-02**, possibly already in a copy from that day:
  - `text` events carry `message`; `tool`, `tool_result` and `text` carry `parent`.
  - Citadel UI served at `/apps/_citadel/ui/` (`markdown.js`, `chat.js`, `composer.js`,
    `base.css`), with the contract test.
  - Install and deploy create a missing `DATA_DIR`. Units run with the build's toolchain
    (`ExecSearchPath`, `MISE_TRUSTED_CONFIG_PATHS`).
  - Apps open inside Citadel's window, framed beside the rail.
