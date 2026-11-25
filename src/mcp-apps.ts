// The MCP tools for apps and contraptions (make_app, deploys, releases, app reads and turns): definitions and handlers. mcp.ts keeps the tool lists and their order.
import { setTimeout as sleep } from 'node:timers/promises';
import { APP_NAME } from './appname.ts';
import { pacificStamp } from './pacific.ts';
import type { AuditTurn } from './mcp-types.ts';
import { copyText, readText, NO_ICON, deployText, serviceText, contraptionText, contraptionPath, RISKS, type DeployInfo, type ServiceInfo, type ContraptionInfo, type CopyResult } from './mcp-text.ts';
import { C, call, NOT_HERE } from './mcp-call.ts';

const CONTRAPTION_FIELDS = {
  title: { type: 'string', description: 'What people see, at most 60 characters.' },
  port: { type: 'integer', description: "The port its own service listens on, on Citadel's machine (1024-65535)." },
  icon: { type: ['string', 'null'], description: "Its rail icon, a path on its service from its base, starting with /, like /icon.svg (the contraption-ui starter's). Every contraption has one: left empty, the rail shows its first letter until a deploy fills it from its web manifest's icons." },
  default_model: { type: ['string', 'null'], description: 'The model its turns use unless it names one, like haiku.' },
  open_paths: { type: 'array', items: { type: 'string' }, description: 'Paths on its service anyone may open without signing in (at most 20), like /link.' },
  relay_paths: {
    type: 'array',
    items: { type: 'string' },
    description: "Path prefixes other contraptions may call on it for a person, through Citadel's relay (at most 20), like /app-api/. Empty: none. List a path only once its code checks the `from` claim, or it takes a relayed call as the person acting in its own UI.",
  },
  home_scheme: { type: ['integer', 'null'], description: "The id of the scheme its people's bug reports and feature asks go to." },
  turn_cap: { type: ['integer', 'null'], description: 'Most turns a day across its people; null for no cap.' },
  repo: { type: ['string', 'null'], description: 'The GitHub repo deploy_contraption builds it from, as owner/name, like caraminden/mandate. Only a repo set here is ever built.' },
  branch: { type: ['string', 'null'], description: 'The branch it deploys; null for main.' },
  folder: { type: ['string', 'null'], description: 'Where its repo is checked out; null for ~/apps/<name>.' },
  restart_risk: { type: 'string', enum: RISKS, description: 'What its Stop and Restart risk: safe, interrupts (users in the middle of something), loses_data (a person types its name to run them), or unassessed (the default).' },
  restart_note: { type: 'string', description: 'A line for whoever is about to Stop or Restart it, at most 300 characters; "" clears it.' },
};

/** Wait up to an hour for the deploy at `path` (builds take minutes), then hand back so the turn can follow again. */
async function followDeploy(path: string): Promise<string> {
  const until = Date.now() + 60 * 60_000;
  let d = await call<DeployInfo | null>('GET', path);
  while (d?.state === 'running' && Date.now() < until) {
    await sleep(5000);
    d = await call<DeployInfo | null>('GET', path);
  }
  return d?.state === 'running' ? `${deployText(d)}\nStill running after an hour: call deploy_contraption again with follow: true to keep waiting.` : deployText(d);
}

/** make_app and its member switch (#1136): every scheme's Taskmaster, for its own scheme, on a member's turn. */
export const APP_TOOLS = [
  {
    name: 'make_app',
    description: `Make a new ${APP_NAME} app (a contraption at /apps/<name>/) for this scheme, when a member asks for one. One call does it all: it starts a minion whose branch already holds a working app in apps/<name>/ of this scheme's repo (a server that checks who is signed in, migrations, a nightly backup, a health path, a first page on ${APP_NAME} UI, tests, and CI when the scheme has a runner), registers the app to deploy from that folder, switches it on for every member of this scheme, and briefs the minion to ship it and then build the idea. Returns the minion's number and the app's port. Refused for a name that's taken, on a turn no member of this scheme asked for, or when the scheme has no GitHub repo. Switch it on or off for other people with set_app_person.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Its name, kept for good: in its address and folder. Lowercase letters, digits and dashes, like trip-notes.' },
        title: { type: 'string', maxLength: 60, description: 'What people see, like Trip Notes: letters, digits, spaces and simple punctuation, at most 60.' },
        idea: { type: 'string', maxLength: 4000, description: "What it's for, in the asker's own words (at most 4,000 characters): it goes into the app's CLAUDE.md and the minion's brief." },
      },
      required: ['name', 'title', 'idea'],
    },
  },
  {
    name: 'adopt_app',
    description: `Register and deploy an app whose code is already in this scheme's own repo (not make_app, which writes a new one): a citadel-app.json on main at the repo root or in a folder. It registers the app (port, icon, this scheme as home), switches it on for every member, deploys it and returns the deploy's outcome. Refused for a name that's taken, on a turn no member of this scheme asked for, with no citadel-app.json at that path on main, or for another repo. Switch it on or off for other people with set_app_person.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Its name, kept for good: in its address. Lowercase letters, digits and dashes, like trip-notes.' },
        title: { type: 'string', maxLength: 60, description: 'What people see, like Trip Notes: letters, digits, spaces and simple punctuation, at most 60.' },
        folder: { type: 'string', description: 'The folder of its citadel-app.json in the repo, like apps/trip-notes; "" or "." for the repo root.' },
        repo: { type: 'string', description: "Optional owner/name; refused unless it is this scheme's own repo." },
      },
      required: ['name', 'title', 'folder'],
    },
  },
  {
    name: 'set_app_person',
    description: `Switch one of this scheme's apps on or off for a person, by login: on shows it in their rail and lets them open it, off takes at their next request. On a turn a member of this scheme asked for.`,
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The app, like trip-notes.' }, login: { type: 'string' }, enabled: { type: 'boolean' } },
      required: ['name', 'login', 'enabled'],
    },
  },
];

// Settings → Contraptions as tools (#246): the same admin routes, for this Taskmaster on a turn an admin asked for (#255).
export const CONTRAPTION_TOOLS = [
  {
    name: 'list_contraptions',
    description: `List the registered contraptions (personal apps reached through ${APP_NAME}, each with its own service): their settings, who they are enabled for, and their key folder. Only on a turn a ${APP_NAME} admin asked for.`,
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'register_contraption',
    description: `Register a contraption, as an admin does in Settings → Contraptions: it writes fresh keys (identity.pub and contraption.key) into its key folder for its own service to read, and returns where. Enable it for people with set_contraption_person. Only on a turn a ${APP_NAME} admin asked for.`,
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'A short slug, kept for good: lowercase letters, digits and dashes, like mandate.' }, ...CONTRAPTION_FIELDS },
      required: ['name', 'title', 'port'],
    },
  },
  {
    name: 'update_contraption',
    description: `Change a contraption's settings; only the fields given change, and null or "" clears an optional one. Its name stays. Only on a turn a ${APP_NAME} admin asked for.`,
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, ...CONTRAPTION_FIELDS }, required: ['name'] },
  },
  {
    name: 'set_contraption_person',
    description: `Enable or disable a contraption for one person, by login. Disabling takes at their next request. Only on a turn a ${APP_NAME} admin asked for.`,
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, login: { type: 'string' }, enabled: { type: 'boolean' } },
      required: ['name', 'login', 'enabled'],
    },
  },
  {
    name: 'rotate_contraption_keys',
    description: `Replace a contraption's identity key pair and contraption key: both files in its key folder are rewritten and the old keys stop working at once, so its service must restart to read the new ones. Only on a turn a ${APP_NAME} admin asked for.`,
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'contraption_service',
    description: `A contraption's systemd user service, which ${APP_NAME} writes and runs itself as citadel-app-<name> (plus citadel-app-<name>-<job> for timers its citadel-app.json names). status: its state, its manifest's problems and any hand-installed unit for it. install: write its units from the manifest in its folder, reload, enable and (re)start them; refused while a hand-installed unit for it runs or is enabled, unless replace is true, which stops and disables those first (their files stay). start, stop, restart: its service (status shows its restart and stop risk first; read it before stopping or restarting; install, stop and restart first wait up to 3 minutes for its running agent turns, holding new ones). logs: the last lines of its journal. Only on a turn a ${APP_NAME} admin asked for.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        action: { type: 'string', enum: ['status', 'install', 'start', 'stop', 'restart', 'logs'] },
        replace: { type: 'boolean', description: 'install only: stop and disable hand-installed units for it first.' },
        lines: { type: 'integer', description: 'logs only: how many lines, default 100, at most 1000.' },
        confirm: { type: 'string', description: 'stop and restart only: the contraption\'s name, required when its risk is "may lose data". Ask the person to type the name first; never fill it in yourself.' },
      },
      required: ['name', 'action'],
    },
  },
];

/** Publishing a home contraption's Android release into its feed (#663): a scheme that has home contraptions. */
export const PUBLISH_RELEASE = () => ({
  name: 'publish_release',
  description: `Publish a contraption's Android release, as the Deploy button on its card on the Releases page does, on the ${APP_NAME} server (so it works from a container turn too). It takes the newest signed release APK newer than the published build (from the CI store, or the run's GitHub artifact), checks it is signed with the same key as the published APK (refused if not: phones won't update across keys), copies it into the contraption's android/ feed and points latest.json at it, so installed phones see the update. With no such APK yet but a version bumped on main, it starts the release workflow instead; call it again once that run has signed. Who published which build from which run is kept and told to the scheme's Taskmaster.${C().HOME_CONTRAPTIONS.length ? ` This scheme's contraptions: ${C().HOME_CONTRAPTIONS.join(', ')}.` : ''}`,
  inputSchema: {
    type: 'object',
    properties: {
      contraption: { type: 'string', ...(C().HOME_CONTRAPTIONS.length ? { enum: C().HOME_CONTRAPTIONS } : {}) },
    },
    required: ['contraption'],
  },
});

/** A desktop app's build, published to its update feed on Citadel (#1148, src/desktop-feed.ts). */
export const PUBLISH_DESKTOP = {
  name: 'publish_desktop',
  description: `Publish a Windows desktop app's build to its update feed on the ${APP_NAME} server, for apps run by the kit's desktop launcher (the citadel:desktop-app skill). Give the build as path (a .zip, .tar.gz or .tgz of the app's folder that you made) or ci_file (a file id in this scheme's CI store; ci_files lists them). It gets the next build number; PCs running the app download it in the background, check its SHA-256 and switch on the start after next, keeping the old build if the new one doesn't start. A ci target with "desktop" in citadel-app.json publishes its green runs by itself; this is for builds made elsewhere and for a first build. The reply has the feed's URL and the first-install zip's.`,
  inputSchema: {
    type: 'object',
    properties: {
      app: { type: 'string', description: 'The app\'s name: lower case letters, digits and dashes ("peek"). Its install folder and launcher are named after it.' },
      path: { type: 'string', description: 'The build you made, as you would link it.' },
      ci_file: { type: 'integer', description: 'Or a file in the CI store, by id.' },
      exe: { type: 'string', description: 'The exe to start, inside the build ("App.exe", "bin/App.exe"); found when the build has one .exe at its top.' },
      started: { type: 'string', enum: ['file', 'alive'], description: 'How the launcher knows the build started: "file" (default) when the app writes the file named by CITADEL_STARTED_FILE once its window is up; "alive" when it is still running 30 seconds later.' },
      title: { type: 'string', description: "Its name on the PC, for the launcher's messages." },
      version: { type: 'string', description: 'What the scheme calls this build ("1.4.2").' },
    },
    required: ['app'],
  },
};

/** A home contraption's Android release key, made on the server once a member approves (#837). */
export const MAKE_RELEASE_KEY = () => ({
  name: 'make_release_key',
  description: `Ask for a contraption's Android release key: posts a card in this chat that any member of this scheme approves, which makes the key on the ${APP_NAME} server (a keystore and a random password in ~/.config/citadel-android, readable only by ${APP_NAME}) and starts its first APK build. Call it when you're told a Capacitor app has no release key yet. Neither the key nor its password ever comes back to you or goes in a chat or a repo. A key is never replaced, so it is refused for an app that has one. Members can also press Make release key on the app's card on the Releases page. Link every mention of the card, as with propose_plan.${C().HOME_CONTRAPTIONS.length ? ` This scheme's contraptions: ${C().HOME_CONTRAPTIONS.join(', ')}.` : ''}`,
  inputSchema: {
    type: 'object',
    properties: {
      contraption: { type: 'string', ...(C().HOME_CONTRAPTIONS.length ? { enum: C().HOME_CONTRAPTIONS } : {}) },
    },
    required: ['contraption'],
  },
});

/** Deploying a contraption from its repo: for Citadel's Taskmaster on an admin's turn, and a contraption's home scheme. */
export const DEPLOY_CONTRAPTION = () => ({
  name: 'deploy_contraption',
  description: `Deploy a contraption from its GitHub repo, as ${APP_NAME} runs it: its folder is a link to one of two checkouts beside it, and a deploy fetches the branch into the other one (refused if either has local changes, or the live one has commits the branch doesn't), runs the build steps in its citadel-app.json there (niced, with a time limit) while the old build keeps running, then points the folder at it, rewrites its units and restarts it, and checks its health. A failed build changes nothing and restarts nothing. Before the restart it waits up to 3 minutes for the contraption's running agent turns to end (holding new ones until it is healthy again); past that it restarts anyway and names the turns it cut. If the new build doesn't come up healthy, it points back at the old checkout and restarts that, with no rebuild. Waits for the outcome (builds can take minutes) and returns what it did and the end of the log. Once deployed it checks the app has a rail icon (filling an empty one from its web manifest) and installs as its own app, and lists what's missing first as To do: a deploy never fails on those, but they are work to finish. Push the commit to the registered branch first: it deploys what is on GitHub, not a worktree.${C().HOME_CONTRAPTIONS.length ? ` This scheme may deploy: ${C().HOME_CONTRAPTIONS.join(', ')}. A land handed off with hand_off_land deploys them already: call this only to redeploy outside a land.` : ` Only on a turn a ${APP_NAME} admin asked for.`}`,
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', ...(C().HOME_CONTRAPTIONS.length && !C().APP_INSTRUCTIONS ? { enum: C().HOME_CONTRAPTIONS } : {}) },
      follow: { type: 'boolean', description: 'true: start nothing, just wait for the deploy already running (after this tool said it was still running).' },
    },
    required: ['name'],
  },
});

export const MANDATE_ITEM = {
  name: 'mandate_item',
  description: `Put an item in Mandate (the to-do app) for the person whose own message this turn answers, or clear one. Only that person: a put is refused on a turn started by GitHub, a system message, a Taskmaster or minion relay, a wake or a resume, and for someone not on this scheme or without Mandate. It shows on their Today with this scheme's name and links back to this chat. Put the same key again to update it. Clear it as soon as its cause is gone (done, landed, fixed, no longer needed), on whichever turn finds that out: clearing an item this chat put works on any turn, and one left open keeps nagging them. alert: true rings like an alarm on their phone, so use it only for a real problem that needs them now, never for good news or an FYI (a green build, a land, a deploy). When they tick, untick, delete or restore it, a "[Mandate]: …" message arrives in this chat. Returns Mandate's answer: 200 { key, state, mine } (state open, ticked, deleted, cleared or none; mine lists fields they edited, which your puts no longer change), or 400 bad_request, 403 off (they switched this scheme's items off) or 429 limit.`,
  inputSchema: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Your name for the item, unique in this chat: letters, digits and . _ : - (e.g. pr-13). The same key updates the same item.' },
      title: { type: 'string', description: 'What to do, 1 to 500 characters. Required unless clear.' },
      day: { type: ['string', 'null'], description: 'YYYY-MM-DD in their time zone; leave out for Anytime.' },
      time: { type: ['string', 'null'], description: 'HH:MM, only with day; they get a push an hour before.' },
      at: { type: ['string', 'null'], description: 'Instead of day and time: an ISO 8601 instant with offset.' },
      alert: { type: 'boolean', description: 'true: it matters now. Shows first on Today and pushes to their phone at once. No day, time or at.' },
      clear: { type: 'boolean', description: 'true: remove the item from Mandate (the key is freed). Everything but key is ignored.' },
    },
    required: ['key'],
  },
};

/** Reading the asking person's data in a contraption (#295): every minion and Taskmaster; the server checks whom for. */
export const CONTRAPTION_READ = {
  name: 'contraption_read',
  description: `Read the data of the person whose own message this turn answers in one of their ${APP_NAME} apps (contraptions such as mandate), as them, read-only. Use it when they ask about their own data in an app. Without command it lists the app's read commands (name, description, input schema); with command it runs one with args and returns its JSON. Refused on a turn started by GitHub, a system message, a Taskmaster or minion relay, a wake or a resume, and for an app they haven't enabled. Answers past 64 KB are cut.`,
  inputSchema: {
    type: 'object',
    properties: {
      app: { type: 'string', description: "The contraption's name, like mandate." },
      command: { type: 'string', description: 'A read command the app lists. Leave out to list them.' },
      args: { type: 'object', description: "The command's input, matching its input schema." },
    },
    required: ['app'],
  },
};

/** A private copy of an app's live data for this turn (src/app-copy.ts): a home scheme's minions. */
export const COPY_APP_DATA = () => ({
  name: 'copy_app_data',
  description: `Get a private, throwaway copy of the live data of one of this scheme's apps (${C().HOME_CONTRAPTIONS.join(', ')}), to try a migration or a check on: its SQLite databases, each consistent while the app keeps running. It returns the folder, yours to change; the live folder isn't touched, and the copy is deleted when this turn ends. Asking again replaces it with a fresh copy. Works in a container turn. It holds everyone's rows, so print counts and checks, never rows, and copy none of it elsewhere. Only on a turn a member of this scheme asked for.`,
  inputSchema: {
    type: 'object',
    properties: {
      app: { type: 'string', description: "The contraption's name.", ...(C().HOME_CONTRAPTIONS.length ? { enum: C().HOME_CONTRAPTIONS } : {}) },
      files: { type: 'boolean', description: 'true: its other files too, except .env and key files, links and backups/' },
    },
    required: ['app'],
  },
});

/** The scheme's contraption turn audit (#844), for its Taskmaster: what each app's model calls were sent and answered. */
export const CONTRAPTION_TURNS = () => ({
  name: 'contraption_turns',
  description: `Read this scheme's contraption turn audit: every model call its apps (${C().HOME_CONTRAPTIONS.join(', ')}) made in the last 14 days, newest first, with whom it was for, the model, whether it ran blind, the system text, prompt and output, and the app's verdict (passed, or fell back to its rule text, with its reason). Use it to check an app's prompts and replies, or why it fell back. Without turn it lists up to 30 turns with each text cut short; with turn it returns that one whole. The payloads hold players' own words: read them here, and never copy them into a file, a commit, a handoff or another scheme.`,
  inputSchema: {
    type: 'object',
    properties: {
      app: { type: 'string', description: "Only this app's turns.", ...(C().HOME_CONTRAPTIONS.length ? { enum: C().HOME_CONTRAPTIONS } : {}) },
      before: { type: 'integer', description: 'Turns older than this turn id: the next page.' },
      turn: { type: 'integer', description: 'One turn by id, with its texts whole.' },
    },
  },
});
const AUDIT_CUT = 400;
function turnText(t: AuditTurn, whole: boolean): string {
  const at = pacificStamp(t.at);
  const verdict = t.verdict === 'pass' ? 'passed' : t.verdict === 'fallback' ? 'fell back' : 'no verdict';
  const head = [`Turn ${t.id}`, t.contraption, `for ${t.person ?? 'someone removed'}`, at, t.model, t.blind && 'blind', t.outcome && t.outcome !== 'end' && t.outcome, verdict + (t.verdict_reason ? `: ${t.verdict_reason}` : '')];
  const text = (label: string, v: string) => `${label}: ${whole || v.length <= AUDIT_CUT ? v : `${v.slice(0, AUDIT_CUT)}… (${v.length} characters: turn ${t.id} for all)`}`;
  return [head.filter(Boolean).join(' · '), ...(whole ? [text('System', t.system)] : []), text('Prompt', t.prompt), text('Output', t.output), ...(t.images ? [`${t.images} image(s) sent, not kept`] : [])].join('\n');
}

/** Answers this family's tools; NOT_HERE for any other. */
export async function runAppsTool(name: string, args: Record<string, unknown>): Promise<string | typeof NOT_HERE> {
  switch (name) {
    case 'list_contraptions': {
      const all = await call<ContraptionInfo[]>('GET', '/api/contraptions');
      return all.length ? all.map(contraptionText).join('\n') : 'No contraptions registered yet.';
    }
    case 'make_app': {
      const m = await call('POST', `/api/projects/${C().PROJECT}/apps`, { name: args.name, title: args.title, idea: args.idea });
      return `Made ${m.name}: #${m.minion} ships it and builds the idea (its branch already holds the app, ${m.files} files${m.workflow ? ', its CI workflow included' : ', no CI workflow: this scheme has no runner'}). It is registered on port ${m.port}, deploys from apps/${m.name}/, and is on for this scheme's members. Name the minion as #${m.minion} in your reply.`;
    }
    case 'adopt_app': {
      const a = await call<{ name: string; port: number; subdir?: string; icon?: string; deployError?: string }>('POST', `/api/projects/${C().PROJECT}/apps/adopt`, { name: args.name, title: args.title, folder: args.folder ?? '', repo: args.repo });
      const head = `Adopted ${a.name}: registered on port ${a.port}, deployed from ${a.subdir ?? 'the repo root'}, icon ${a.icon || 'left empty for the deploy to fill'}, on for this scheme's members.`;
      if (a.deployError) return `${head}\nIt did not deploy: ${a.deployError}\nIt stays registered: call deploy_contraption for ${a.name} to try again.`;
      return `${head}\n${await followDeploy(`/api/contraptions/${encodeURIComponent(a.name)}/deploy`)}`;
    }
    case 'set_app_person': {
      if (typeof args.login !== 'string' || !args.login) throw new Error('login is required');
      const r = await call<{ name: string; people: string[] }>('PUT', `/api/projects/${C().PROJECT}/apps/${encodeURIComponent(String(args.name))}/people/${encodeURIComponent(`@${args.login}`)}`, { enabled: args.enabled });
      return `${args.enabled ? 'On' : 'Off'} for ${args.login}. ${r.name} is on for: ${r.people.join(', ') || 'no one'}.`;
    }
    case 'register_contraption': {
      const c = await call<ContraptionInfo>('POST', '/api/contraptions', args);
      return `Registered. Its service reads its keys from the key folder.${c.icon ? '' : `\n${NO_ICON}`}\n${contraptionText(c)}`;
    }
    case 'update_contraption': {
      const { name, ...fields } = args;
      return `Saved.\n${contraptionText(await call<ContraptionInfo>('PATCH', contraptionPath(args), fields))}`;
    }
    case 'set_contraption_person': {
      if (typeof args.login !== 'string' || !args.login) throw new Error('login is required');
      const c = await call<ContraptionInfo>('PUT', `${contraptionPath(args)}/people/${encodeURIComponent(`@${args.login}`)}`, { enabled: args.enabled });
      return `${args.enabled ? 'Enabled' : 'Disabled'} for ${args.login}.\n${contraptionText(c)}`;
    }
    case 'mandate_item': {
      if (typeof args.key !== 'string' || !/^[A-Za-z0-9._:-]{1,120}$/.test(args.key)) throw new Error('key is required: letters, digits and . _ : - only, like pr-13');
      const path = `/api/mandate/items/${args.key}`;
      if (args.clear !== true && (typeof args.title !== 'string' || !args.title.trim())) throw new Error('title is required (or clear: true)');
      const { key, clear, ...fields } = args;
      const r = await call(clear === true ? 'DELETE' : 'PUT', path, clear === true ? undefined : fields);
      return `Mandate answered ${r.status}: ${typeof r.answer === 'string' ? r.answer : JSON.stringify(r.answer)}`;
    }
    case 'contraption_turns': {
      const q = new URLSearchParams();
      if (args.app) q.set('app', String(args.app));
      // One turn: the page just above it, so its first row is the turn if it is this scheme's.
      if (args.turn) q.set('before', String(Number(args.turn) + 1));
      else if (args.before) q.set('before', String(Number(args.before)));
      const r = await call<{ turns: AuditTurn[]; keep_days: number; more?: boolean }>('GET', `/api/projects/${C().PROJECT}/contraption-turns?${q}`);
      if (args.turn) {
        const t = r.turns[0];
        return t?.id === Number(args.turn) ? turnText(t, true) : `No turn ${args.turn} in this scheme's audit (kept ${r.keep_days} days).`;
      }
      if (!r.turns.length) return `No turns in the last ${r.keep_days} days.`;
      return r.turns.map((t) => turnText(t, false)).join('\n\n') + (r.more ? `\n\nOlder turns: before: ${r.turns.at(-1)!.id}.` : '');
    }
    case 'contraption_read': {
      if (typeof args.app !== 'string' || !args.app) throw new Error('app is required, like mandate');
      const r = await call<Parameters<typeof readText>[2]>('POST', `/api/contraption-read/${encodeURIComponent(args.app)}`, { command: args.command, args: args.args });
      return readText(args.app, args.command as string | undefined, r);
    }
    case 'copy_app_data': {
      if (typeof args.app !== 'string' || !args.app) throw new Error('app is required, like mandate');
      return copyText(args.app, await call<CopyResult & { dir: string }>('POST', `/api/app-copy/${encodeURIComponent(args.app)}`, { files: args.files }));
    }
    case 'make_release_key': {
      const { href } = await call('POST', `/api/tickets/${C().TICKET}/release-key`, { contraption: args.contraption });
      return `The release key card is in the chat; its link is ${href}. Link every mention of it, e.g. [the key card below](${href}). Any member of this scheme can approve it, and the answer comes as a message. Keep working on what doesn't depend on it.`;
    }
    case 'publish_desktop':
      return (await call<{ said: string }>('POST', `/api/projects/${C().PROJECT}/desktop/publish`, { app: args.app, path: args.path, ci_file: args.ci_file, exe: args.exe, started: args.started, title: args.title, version: args.version })).said;
    case 'publish_release':
      return (await call<{ said: string }>('POST', `/api/projects/${C().PROJECT}/releases/publish`, { contraption: args.contraption })).said;
    case 'deploy_contraption': {
      const path = `${contraptionPath(args)}/deploy`;
      if (args.follow !== true) await call('POST', path, {});
      return followDeploy(path);
    }
    case 'contraption_service': {
      const path = `${contraptionPath(args)}/service`;
      if (args.action === 'status') return serviceText(await call<ServiceInfo>('GET', path));
      if (args.action === 'logs') return (await call<{ log: string }>('GET', `${path}/logs?lines=${Number(args.lines) || 100}`)).log || 'No journal lines.';
      const r = await call<{ said: string[]; status: ServiceInfo }>('POST', path, { action: args.action, replace: args.replace === true, ...(args.confirm ? { confirm: args.confirm } : {}) });
      return `${r.said.join('\n')}\n${serviceText(r.status)}`;
    }
    case 'rotate_contraption_keys':
      return `New keys written; the old ones stopped working. Restart its service so it reads them.\n${contraptionText(await call('POST', `${contraptionPath(args)}/keys`, {}))}`;
    default:
      return NOT_HERE;
  }
}
