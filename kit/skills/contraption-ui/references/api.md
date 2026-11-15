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
- [Sessions reading a person's data: `/app-api/read`](#sessions-reading-a-persons-data-app-apiread)
- [What Citadel serves your pages](#what-citadel-serves-your-pages)
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
| `DATA_DIR` | `~/.local/share/<name>`, created empty (0700) on install or deploy if missing; never touched otherwise (tested) |
| `CITADEL_KEYS` | Your key folder |
| `CITADEL_URL` | Where your server calls Citadel: `http://127.0.0.1:8573` on the live box. Read it; don't hard-code it |
| `PATH` | mise's shims, `~/.local/bin`, then the system's |
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

On every request, open path or not:

- **Any `X-Citadel-*` header the client sent is removed first**, so a client can never claim an
  identity (tested, on gated paths, open paths and websockets).
- Citadel's `cc_session` and `cc_app` cookies are taken out of `Cookie`; your own cookies pass
  through. A `Set-Cookie` from you naming either, or with a `Domain=`, is dropped; your other cookies
  reach the browser, host-only (tested). On gated requests Citadel may add its own `Set-Cookie` renewing a session older than 7
  days (tested).
- `Authorization` passes through untouched: it's yours.
- Request bodies up to 20 MiB; bigger gets 413 (tested). Answers stream as they come: server-sent
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

## The identity header

```
X-Citadel-Identity: v1.<base64url(JSON claims)>.<base64url(Ed25519 signature over "v1." + the claims part)>
```

| Claim | Meaning |
|---|---|
| `app` | Your name. Refuse a header naming another app |
| `sub` | The person's Citadel user id: stable, the key for their data |
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
else's plan. Citadel keeps no prompt, reply or tool content: only a meter (contraption, person,
session name, start, end, outcome, token counts) and the session names (tested).

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
  "timeoutSec": 180
}
```

| Field | Required | Rules and default |
|---|---|---|
| `person` | yes | A user id ≥ 1, enabled for your app |
| `session` | yes | `^[\w.:@-]{1,100}$`, your name for the conversation, per person |
| `prompt` | yes | Non-blank text |
| `fresh` | | `true` starts a new conversation under the same name; default `false` |
| `system` | | Text appended to the agent's system prompt; default none |
| `model` | | `^[\w.\[\]-]{1,60}$`; default the registry's `default_model`, else Claude Code's default. Per call, so each turn may pick its own |
| `compactWindow` | | Tokens before the conversation compacts: 10,000 to 1,000,000, default 40,000 |
| `mcp` | | Up to 10 servers: `name` (`^[A-Za-z0-9_-]{1,40}$`, unique), `path` (on your port, starting with `/`, at most 200 printable characters), `headers` (an object of header names matching `^[A-Za-z0-9-]{1,100}$` to values of at most 8,192 characters with no line breaks) |
| `agents` | | `false` (default) or `{ max, model }`: lets the agent start Grunts (the Agent tool), at most `max` (1 to 10, default 1) at once, nested ones included; `model` defaults to the turn's |
| `webSearch` | | `true` adds WebSearch and WebFetch for the agent and its Grunts; default `false`. WebFetch puts a web page in front of the model, so keep your write tools behind the person's explicit asks on such turns |
| `machines` | | `false` leaves out the person's online machines and the system prompt's note on them; default `true`. For a turn that must see only its prompt, such as a blind grader |
| `timeoutSec` | | 1 to 900, default 180 |

Each `mcp` server is reached as `http://127.0.0.1:$PORT<path>` (streamable HTTP) with your headers
as sent, from wherever the turn runs (containers share the host's network). The path is the raw
path on your port, so include your base path if your server routes under it. Check your own token
there: Citadel passes it through and never reads it.

**What the agent can use** (tested): your MCP servers' tools (`mcp__<name>__<tool>`), the person's
own machines that are online unless `machines` is `false` (their MCP servers, as `mcp__<machine>`;
a server of yours with the same name wins and the machine is left out), Agent if `agents` is set, and WebSearch and WebFetch
if `webSearch` is `true`. Nothing else: no shell, no files, no Citadel or scheme tools, no user
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

### Sessions

- `GET /api/contraptions/sessions?person=3` → `[{ "name", "lastUsed", "busy" }]`, newest first;
  `lastUsed` in milliseconds since the epoch, `busy` while a turn runs in it.
- `DELETE /api/contraptions/sessions/<name>?person=3` (name URL-encoded) → `200 { "ok": true }`:
  forgets the name and deletes its transcript from the person's Claude folder (tested). `409
  { "error": "busy" }` while a turn runs in it; `404` when there's no such session.
- Both: `400` for a bad `person`, `403 { "error": "not_enabled" }` when your app isn't enabled for
  them.

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
  feature rate limit, and isn't a go to merge: only words a person types in Citadel are.
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

Each `ui/*.js` has a `.d.ts` beside it. Exports, classes and token names only ever get added: a
contract test holds them. How to use each one is in this skill's SKILL.md table and the references
it links. `ui/chat.js` takes the turn API's events above as they come.

The rail draws from `GET /apps/_citadel/api/mine` on your own host (the browser's own login, not
your key): `{ name, citadel, apps: [{ name, title, icon, up }] }`, the person's name, Citadel's
address (null when you're on Citadel's host), and the apps enabled for them, `up` false when its
service doesn't answer. Their icons come from `/apps/_citadel/icon/<name>`, fetched by Citadel.

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
  "health": "/apps/myapp/health"
}
```

| Field | Rules |
|---|---|
| `start` (required) | 1 to 50 words; the first is an absolute path or a program name, found on `PATH` above (so `node` is your `.mise.toml`'s). An argument starting `~/` is under the home folder; `${VAR}` expands from the environment |
| `workdir` | A folder inside the repo, default the root |
| `env` | `NAME: "one line"` (at most 1,000 characters); `~/` at the start of a value is the home folder. Can't set `PORT`, `DATA_DIR`, `CITADEL_KEYS`, `CITADEL_URL`, `BASE_PATH` or `PATH` |
| `timers` | Up to 5 jobs named `^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?$`, each `{ command, on_calendar, workdir? }`; systemd calendar syntax (`daily`, `*-*-* 03:30:00`); same environment; a run missed while the box was off happens at boot |
| `health` | A path on your port as your server sees it (include your base path) that answers 2xx once up. Without it, an open port counts |
| `build` | Up to 20 shell commands, run in the repo root in order at nice 10, with `PATH` as above and none of Citadel's variables (no `PORT`, `DATA_DIR`). Any failing fails the deploy |
| `build_timeout` | Whole minutes for the whole build, 1 to 60, default 20 |

The service restarts 5 s after any exit and starts with the box. Citadel never reads or writes
your `DATA_DIR` beyond creating it when missing.

**Deploying.** An admin sets `repo`, `branch` and `folder` and installs the service once. After
that your home scheme's Taskmaster and minions have `deploy_contraption`. A land handed off
with `hand_off_land` deploys it by itself and reports the outcome, and auto-deploy covers main
5 minutes after it last moved, so the tool is for redeploys outside a land. It deploys what is on
GitHub, so push first. A deploy (tested):

1. clones the repo if the folder is missing; otherwise fetches and fast-forwards the branch, and
   refuses, changing nothing, on local changes, untracked files that aren't ignored, other commits,
   another branch or another origin (keep build output in `.gitignore`);
2. runs the build;
3. holds new turns, waits up to 3 minutes for running ones, rewrites the units and restarts the
   service;
4. waits up to 60 s for the health path to answer, twice a few seconds apart.

If 2 to 4 fail, it resets to the commit it ran before, builds that and restarts it (`rolled back`);
a first deploy has nothing to roll back to (`failed`). The tool returns what happened and the end
of the log. After a good deploy it checks the two things every contraption ships with (Cara,
2026-11-09: "both of these should be the default behavior for new contraptions"):

- **A rail icon.** An empty registry `icon` is set to your manifest's first PNG icon that loads.
- **A web manifest that installs you as your own app** (rules in references/installing.md).

What's still missing comes back first in the tool's answer as **To do** lines, shows under the
deploy in Settings, and goes to your home scheme's Taskmaster as a to-do (once per new list, and not
when that Taskmaster deployed it itself). It never fails the deploy, so a first shell can ship.

Service status, start, stop, restart, its journal and installing over a hand-made unit are
admin-only (Settings → Contraptions, or Citadel's Taskmaster's `contraption_service`).

## Limits at a glance

| What | Limit |
|---|---|
| Proxied request body | 20 MiB |
| Identity header lifetime | 60 s |
| Turn request body | 4,000,000 bytes |
| Turn `timeoutSec` | 1 to 900, default 180 |
| Turn `mcp` servers | 10 |
| Turn `agents.max` | 1 to 10 |
| Turns a day | the registry's `turn_cap`, per person |
| Restart wait for running turns | 3 minutes |
| Ask files | 20 files, 16 MiB decoded |
| Ask text, summary, item | 10,000, 200, 100 characters |
| Asks per person per 10 minutes | 10 bug/feature, 60 data |
| Minions in one list read | 50 |
| Relay body, timeout | 64 KiB, 10 s |
| Embed call | 16 texts of 4,000 characters |
| `/app-api/read` timeout, answer | 15 s, 64 KB |
| Open paths, relay paths | 20 each |
| Timers | 5 |
| Build | 1 to 60 minutes, default 20 |
| Health wait | 60 s |

## What changed since 2026-11-02

Newest first.

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
