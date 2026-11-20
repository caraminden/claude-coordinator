// "Show me where" links (#1122): the parts of Citadel people ask about, each a name that sits on its element as
// data-part, a plain-words label, and the page it lives on. A link is the page's address plus ?show=<name>: the page
// opens, scrolls the part into view and outlines it (public/show-part.js). test/show-parts.test.ts checks every name
// here is still on an element in public/, so a rename can't silently break links. Agents look names up with the
// `citadel-where` command on every turn's PATH (tools/citadel-where), which runs this file.
//
// Plain data and node built-ins only: turn-launch.ts pins a copy of this file beside the turn's tools.

/** `page` follows #/p/<scheme>: '' is the Taskmaster's chat, '/t/{minion}' a minion's chat, else a settings page. */
export type Part = { name: string; label: string; page: string; where: string; words?: string };

const CHAT = '';
const MINION = '/t/{minion}';
const RULES = '/approvals';

export const PARTS: Part[] = [
  // Any chat
  { name: 'message-box', label: 'The message box', page: CHAT, where: 'the bottom of every chat', words: 'composer type write send' },
  { name: 'attach', label: 'Attach images or files', page: CHAT, where: 'beside the message box', words: 'upload picture image file paperclip' },
  { name: 'point-at', label: 'Point at something', page: CHAT, where: 'the 🎯 beside Attach (Alt+Shift+P on any page; on a phone also the Overview drawer)', words: 'pick report this screenshot target point crop' },
  { name: 'more-ways-to-send', label: 'More ways to send', page: CHAT, where: 'the arrow beside Send', words: 'send menu later queue' },
  { name: 'usage-meter', label: 'The usage meter', page: CHAT, where: 'the top bar', words: 'usage limit spend weekly bar' },
  { name: 'minion-list', label: 'The minions list', page: CHAT, where: 'the Minions panel on the left', words: 'minions threads sidebar list' },
  { name: 'minions-tab', label: 'The Minions tab', page: CHAT, where: 'the top of the left panel', words: 'minions panel tab' },
  { name: 'orders-tab', label: 'The Orders tab', page: CHAT, where: 'beside the Minions tab', words: 'orders instructions rules skills memory properties schedules' },
  // A minion's chat
  { name: 'model-picker', label: "A minion's model", page: MINION, where: "beside Send in the minion's chat (the gear on a phone)", words: 'model opus sonnet fable haiku picker' },
  { name: 'effort-picker', label: "A minion's effort", page: MINION, where: "beside Send in the minion's chat (the gear on a phone)", words: 'effort thinking low medium high picker' },
  { name: 'ask-on-the-side', label: 'Ask on the side', page: MINION, where: "beside Send in a minion's chat", words: 'aside btw side question' },
  { name: 'minion-menu', label: "A minion's More menu", page: MINION, where: "the line of buttons under a minion's title (the ⋯ on a phone)", words: 'more menu stop dismiss reopen close leave' },
  { name: 'minion-note', label: "A minion's note", page: MINION, where: "the top of a minion's chat", words: 'note people only' },
  { name: 'pin-minion', label: 'Pin a minion', page: MINION, where: "the top of a minion's chat", words: 'pin top list' },
  // Orders → Minion rules
  { name: 'fast-mode', label: 'Fast mode', page: RULES, where: 'Orders → Minion rules → Shipping', words: 'fast ship now test behind land' },
  { name: 'how-changes-ship', label: 'How a change ships', page: RULES, where: 'Orders → Minion rules → Shipping', words: 'ship land pull request pr merge path' },
  { name: 'persons-go', label: "A person's go", page: RULES, where: 'Orders → Minion rules → Shipping', words: 'go approval high risk ship' },
  { name: 'try-it-first', label: 'Try it first', page: RULES, where: 'Orders → Minion rules → Shipping', words: 'preview try first' },
  { name: 'needs-approval', label: 'Needs approval', page: RULES, where: 'Orders → Minion rules → Approvals', words: 'approve deny permission tool calls' },
  { name: 'default-effort', label: 'Default effort', page: RULES, where: 'Orders → Minion rules → Minions', words: 'effort default' },
  { name: 'list-groups', label: 'List groups', page: RULES, where: 'Orders → Minion rules → Minions', words: 'groups list sidebar sort move' },
  { name: 'plugins', label: 'Plugins', page: RULES, where: 'Orders → Minion rules → Plugins', words: 'plugins folders devtools' },
  { name: 'screenshots', label: 'Screenshot widths', page: RULES, where: 'Orders → Minion rules → Checks', words: 'screenshots widths shots' },
  { name: 'ci-alerts', label: 'CI alerts', page: RULES, where: 'Orders → Minion rules → CI', words: 'ci alerts red tests' },
  // Instructions
  { name: 'scheme-instructions', label: 'Scheme instructions', page: '/instructions', where: 'Orders → Instructions', words: 'instructions scheme rules prompt' },
  { name: 'my-instructions', label: 'My instructions', page: '/my-instructions', where: 'Settings → My instructions', words: 'my own personal instructions' },
  { name: 'citadel-wide-instructions', label: 'Citadel-wide instructions', page: '/app-instructions', where: 'Settings → Citadel-wide (admins)', words: 'citadel wide global instructions' },
  // Settings
  { name: 'claude-login', label: 'Your Claude login', page: '/account', where: 'Settings → Your account', words: 'claude login link subscription account' },
  { name: 'github-login', label: 'Your GitHub login', page: '/account', where: 'Settings → Your account', words: 'github login account' },
  { name: 'secrets', label: 'Secrets', page: '/account', where: 'Settings → Your account', words: 'secrets keys passwords api' },
  { name: 'password', label: 'Change your password', page: '/account', where: 'Settings → Your account', words: 'password change sign in' },
  { name: 'notify-this-device', label: 'Notifications on this device', page: '/notifications', where: 'Settings → Notifications', words: 'notifications push notify bell' },
  { name: 'fable-cap', label: 'Weekly Fable cap', page: '/usage', where: 'Settings → Usage', words: 'fable cap weekly limit' },
  { name: 'hide-scheme', label: 'Hide this scheme', page: '/members', where: 'Settings → Members', words: 'hide scheme mute' },
  { name: 'invite-someone', label: 'Invite someone', page: '/people', where: 'Settings → People (admins)', words: 'invite person people add' },
];

/** The link that shows `part`, as a route in the chat: in scheme `scheme`, on minion `minion`'s chat where the part is in one (none without it). */
export function partLink(part: Part, scheme: number | string, minion?: number | string | null): string | null {
  if (part.page === MINION && !minion) return null;
  return `#/p/${scheme}${part.page === MINION ? `/t/${minion}` : part.page}?show=${part.name}`;
}

// The words of a question ("where is the fast mode?") that name no part.
const STOP = new Set(['where', 'is', 'are', 'the', 'a', 'an', 'my', 'i', 'can', 'do', 'how', 'to', 'find', 'it', 'its', 'out', 'point', 'me', 'show', 'of', 'in', 'on', 'for', 'button', 'setting', 'settings', 'change', 'turn', 'set',
  'them', 'they', 'this', 'that', 'what', 'which', 'with', 'from', 'at', 'you', 'your', 'we', 'our', 'there', 'see', 'get', 'go', 'thing', 'option']);

/** The parts that match `query`, best first: every word must hit the name, label, where or words, so a stray word finds nothing rather than the wrong part. */
export function findParts(query: string): Part[] {
  const words = (query.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !STOP.has(w));
  if (!words.length) return PARTS;
  const scored = PARTS.map((p) => {
    const hay = `${p.name.replace(/-/g, ' ')} ${p.label} ${p.where} ${p.words ?? ''}`.toLowerCase();
    const hits = words.filter((w) => hay.includes(w));
    const inName = words.filter((w) => p.name.includes(w) || p.label.toLowerCase().includes(w)).length;
    return { p, score: hits.length === words.length ? hits.length * 2 + inName : 0 };
  });
  const best = Math.max(...scored.map((s) => s.score));
  return best ? scored.filter((s) => s.score === best).map((s) => s.p) : [];
}

/** The scheme (and minion, by its own number unknown here: its internal id) a turn runs in, from its working folder. */
export function turnPlace(cwd: string): { scheme: string | null; ticketId: string | null } {
  return { scheme: /\/projects\/(\d+)(?:\/|$)/.exec(cwd)?.[1] ?? null, ticketId: /\/tickets\/(\d+)(?:\/|$)/.exec(cwd)?.[1] ?? null };
}

const USAGE = `citadel-where [--scheme N] [--minion N] [--all] <words>
Prints a markdown link that opens Citadel's page and outlines the part people asked about ("where is fast mode?").
  --scheme N  the scheme's id (default: from this turn's folder)
  --minion N  the minion's number, for parts in a minion's chat (default: this minion)
  --all       every named part`;

function main(argv: string[]): number {
  let scheme: string | null = null, minion: string | null = null, all = false;
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return void console.log(USAGE), 0;
    if (a === '--all') all = true;
    else if (a === '--scheme' || a === '--minion') {
      const v = argv[++i];
      if (!/^\d+$/.test(v ?? '')) return void console.error(`${a} takes a number\n${USAGE}`), 2;
      if (a === '--scheme') scheme = v; else minion = v;
    } else words.push(a);
  }
  if (!all && !words.length) return void console.error(USAGE), 2;
  const place = turnPlace(process.cwd());
  scheme ??= place.scheme;
  const hits = all ? PARTS : findParts(words.join(' '));
  if (!hits.length) {
    console.log(`No named part matches "${words.join(' ')}". Try fewer words, or --all to see every one. Describe it in words instead.`);
    return 1;
  }
  for (const p of hits) {
    // A minion's chat: the number given, else this turn's own minion by its internal id (#/t/<id> opens it).
    const link = p.page === MINION && !minion && place.ticketId ? `#/t/${place.ticketId}?show=${p.name}` : partLink(p, scheme ?? '<scheme id>', minion);
    console.log(link ? `[${p.label}](${link})  ${p.where}` : `${p.label}: ${p.where}. It's in a minion's chat: pass --minion N for a link.`);
  }
  if (!scheme) console.log('No scheme found from this folder: pass --scheme N.');
  return 0;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) process.exitCode = main(process.argv.slice(2));
