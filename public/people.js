// Settings tabs for who is in Citadel: a scheme's members, everyone (admins only), and your own account.
import { account, ago, api, h, noAutofill, icon, view } from './base.js';
import { gloss } from './help-words.js';
import { codexToggle, codexWindowsBlock, renderUsage, setCodex } from './core.js';
import { settingsHelp, settingsRow, settingsTabs, settingsTitle } from './settings.js';
import { hideButton } from './hidden.js';
import { copyText } from './ui/markdown.js';
import { optimistic } from './ui/optimistic.js';
import { loadingLine } from './ui/state.js';

function head(title, meta) {
  return h('div', { class: 'ticket-head' }, h('div', { class: 'row' }, ...settingsTitle(), h('span', { class: 'spacer' }), h('a', { class: 'close-view', href: `#/p/${view.projectId}`, title: 'Back to the Taskmaster', 'aria-label': 'Close' }, icon('close'))), settingsTabs(), h('div', { class: 'meta' }, meta));
}

// Rows left open, by key, across the redraws every change here causes.
const openRows = new Set();
function personRow(key, opts, ...body) {
  const [row] = settingsRow({ ...opts, open: openRows.has(key) }, ...body);
  row.addEventListener('toggle', () => openRows[row.open ? 'add' : 'delete'](key));
  return row;
}

const page = (...children) => h('section', { class: 'artifacts-main people-main' }, ...children);
const fail = (err) => alert(err.message);

/** What Citadel did for a member on the scheme's GitHub repo (#310), or nothing. */
function githubLine(m) {
  const g = m.github;
  if (!g) return '';
  const repo = h('a', { href: `https://github.com/${g.slug}`, target: '_blank', rel: 'noopener' }, g.slug);
  const line =
    g.state === 'added'
      ? ['Can push to ', repo, ' (Citadel added them)']
      : g.state === 'existing'
        ? ['Can push to ', repo]
        : g.state === 'waiting'
          ? ['Gets push access to ', repo, ' once they link GitHub in Settings → Your account']
          : g.state === 'invited'
            ? ['Invited to ', repo, ': they accept on ', h('a', { href: `https://github.com/${g.slug}/invitations`, target: '_blank', rel: 'noopener' }, 'GitHub')]
            : ['No push access to ', repo];
  return h('span', { class: 'meta' }, ...line, g.error ? h('span', { class: 'error' }, ` · ${g.error}`) : '');
}

/** Main panel: who is in this scheme. Anyone in it (or an admin) adds and removes people (#621). */
export function membersPage() {
  const p = view.project;
  const owns = !!account;
  const list = h('div', { class: 'people-list settings-rows' });
  const pick = h('select', { 'aria-label': 'Person to add' });
  const add = h('form', { class: 'row people-add' }, pick, h('button', { type: 'submit' }, 'Add'));
  const addRow = h('div', { class: 'settings-rows', hidden: true }, settingsRow({ icon: 'plugplus', hue: 'done', title: 'Add someone', summary: 'Someone already in Citadel' }, add)[0]);
  let shown = [];
  // Adding and removing show at once; the server's list replaces ours when it answers. A refusal puts the list
  // back as it was, unless a later click changed it, then reloads it, since a GitHub refusal still took the
  // person out of the scheme.
  const change = (next, send, label, people) => {
    let was, mine;
    optimistic({
      key: `members:${p.id}`,
      apply: () => {
        was = shown;
        render((mine = next(shown)), people);
      },
      send,
      undo: () => {
        if (shown === mine) render(was, people);
        api(`api/projects/${p.id}/members`).then(
          (members) => render(members, people),
          () => {},
        );
      },
      label,
    }).then(
      (members) => render(members, people),
      () => {},
    );
  };
  const render = (members, people) => {
    shown = members;
    const inIt = new Set(members.map((m) => m.id));
    list.replaceChildren(
      ...members.map((m) =>
        personRow(
          `m:${m.id}`,
          { icon: 'user', hue: m.owner ? 'held' : 'accent', title: m.name, summary: m.owner ? `${m.login} · owner` : m.login },
          githubLine(m) || h('p', { class: 'muted small' }, m.owner ? 'Owns this scheme.' : 'No GitHub push access set up for them here.'),
          owns &&
            !m.owner &&
            h(
              'div',
              { class: 'settings-row-actions' },
              h(
                'button',
                {
                  type: 'button',
                  class: 'secondary small',
                  onclick: () => {
                    if (!confirm(`Take ${m.name} out of ${p.name}? They stop seeing it at once.`)) return;
                    change(
                      (list) => list.filter((x) => x.id !== m.id),
                      () => api(`api/projects/${p.id}/members/${m.id}`, { method: 'DELETE' }),
                      `take ${m.name} out of ${p.name}`,
                      people,
                    );
                  },
                },
                'Remove',
              ),
            ),
        ),
      ),
    );
    const others = people.filter((x) => !inIt.has(x.id));
    pick.replaceChildren(...others.map((x) => h('option', { value: x.id }, `${x.name} (${x.login})`)));
    addRow.hidden = !owns || !others.length;
    add.onsubmit = (e) => {
      e.preventDefault();
      const who = people.find((x) => x.id === Number(pick.value));
      if (!who) return;
      change(
        (list) => [...list, { id: who.id, name: who.name, login: who.login, owner: false }],
        () => api(`api/projects/${p.id}/members`, { method: 'POST', body: { person: who.id } }),
        `add ${who.name} to ${p.name}`,
        people,
      );
    };
  };
  Promise.all([api(`api/projects/${p.id}/members`), api('api/people')])
    .then(([members, people]) => render(members, people))
    .catch(fail);
  return page(
    head('Members', settingsHelp('Only the people here see this scheme, its minions and its files.', 'Anyone in it adds minions, chats, and changes its members and settings.')),
    h('h3', { class: 'settings-section' }, `In ${p.name}`),
    list,
    addRow,
    h('h3', { class: 'settings-section' }, 'Just for you'),
    h(
      'div',
      { class: 'settings-rows' },
      settingsRow(
        { part: 'hide-scheme', icon: 'eye', hue: 'muted', title: 'Hide this scheme', summary: 'Out of your lists, badges and notifications' },
        settingsHelp('Hiding takes the scheme out of your scheme lists, Needs-you badges and notifications.', 'You stay in it, and its link still opens it.'),
        hideButton(p),
      )[0],
    ),
    account?.admin && settingsHelp('To add someone new to Citadel, invite them under People first.'),
  );
}

/** The link an invite or reset token makes, with a Copy button: shown once, since only its hash is kept. */
function linkBox(who, token, what, origin = location.origin) {
  const url = `${origin}${location.pathname}#/invite/${token}`;
  const copy = h('button', { type: 'button', class: 'secondary small' }, 'Copy');
  copy.onclick = async () => {
    copy.textContent = (await copyText(url)) ? 'Copied' : "Couldn't copy";
  };
  return h('div', { class: 'machine-setup' }, h('div', { class: 'row' }, h('strong', {}, `${what} link for ${who.name}`), h('span', { class: 'spacer' }), copy), h('p', { class: 'small' }, 'Send it to them yourself. It works once, for 7 days, and is shown only now; if it gets lost, make a new one.'), h('pre', {}, url));
}

/** Main panel, admins only: invite people, make reset links, and decide who may use the server's Claude login. */
export function peoplePage() {
  const name = h('input', { name: 'name', placeholder: 'Their name', required: true, maxlength: 40, autocomplete: 'off' });
  const login = h('input', { name: 'login', placeholder: 'lowercase, no spaces', maxlength: 32, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' });
  name.oninput = () => {
    login.placeholder =
      name.value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '') || 'lowercase, no spaces';
  };
  const status = h('span', { class: 'muted', role: 'status' });
  const link = h('div');
  const list = h('div', { class: 'people-list settings-rows' });
  const show = (who, token, what, origin) => link.replaceChildren(linkBox(who, token, what, origin));
  let shown = [];
  const render = (people) => (
    (shown = people),
    list.replaceChildren(
      ...people.map((u) => {
        // An admin with no password of their own signs in with the shared one (COORDINATOR_PASSWORD).
        const state = u.disabled ? 'disabled' : u.invite_open ? (u.has_password ? 'reset link open' : 'invited') : u.has_password ? '' : u.admin ? 'shared password only' : 'invite expired';
        // Shows at once and sends behind; a refusal puts the old value back, unless a later click changed it again.
        const patch = (body, label) => {
          const now = () => shown.find((x) => x.id === u.id);
          const was = Object.fromEntries(Object.keys(body).map((k) => [k, (now() ?? u)[k]]));
          const set = (vals) => now() && render(shown.map((x) => (x.id === u.id ? { ...x, ...vals } : x)));
          optimistic({
            key: `person:${u.id}`,
            sets: `person:${u.id}:${Object.keys(body)}`,
            apply: () => set(body),
            send: () => api(`api/people/${u.id}`, { method: 'PATCH', body }),
            undo: () => Object.entries(body).every(([k, v]) => now()?.[k] === v) && set(was),
            label,
          });
        };
        const turns = u.server_login_owner && h('input', { type: 'checkbox', checked: u.server_login, onchange: (e) => patch({ server_login: e.target.checked }, `switch ${u.name}'s turns to ${e.target.checked ? 'the server login' : 'their own Claude'}`) });
        const claude = u.server_login ? `Claude: server login${u.claude_accounts > 1 ? ` (${u.claude_accounts})` : ''}` : u.claude === 'linked' ? `Claude linked${u.claude_accounts > 1 ? ` (${u.claude_accounts})` : ''}` : u.claude === 'expired' ? 'Claude needs linking again' : 'Claude not linked';
        const self = u.id === account?.id;
        // One status chip leads the row (#492): the first thing that needs someone, else Ready.
        const [tone, word, tip] = u.disabled
          ? ['neutral', 'Disabled', 'They cannot sign in']
          : state === 'invite expired'
            ? ['danger', 'Invite expired', 'Make a new invite for them']
            : state === 'invited'
              ? ['info', 'Invited', 'They have not set a password yet']
              : !u.server_login && u.claude !== 'linked'
                ? ['warn', 'Needs linking', `${claude}: their messages wait in the chat until they link it in Your account`]
                : u.github?.failed
                  ? ['warn', 'Needs linking', 'GitHub needs linking again']
                  : ['ok', 'Ready', 'They can sign in and their messages start turns'];
        const hue = { ok: 'done', warn: 'waiting', danger: 'danger', info: 'accent' }[tone] ?? 'muted';
        return personRow(
          `u:${u.id}`,
          { icon: 'user', hue, title: `${u.name}${u.admin ? ' · admin' : ''}`, summary: `${word} · ${u.login}` },
          h('p', { class: 'muted small', title: tip }, [state, claude, u.week && `week ${Math.round(u.week.utilization * 100)}%`, u.github ? `GitHub @${u.github.login}${u.github.failed ? ' (needs linking again)' : ''}` : 'GitHub not linked'].filter(Boolean).join(' · ')),
          h(
            'span',
            { class: 'settings-row-actions' },
            turns && h('label', { class: 'small turns-toggle', title: "Your messages start and steer turns on the server's Claude login. Off: they run on the Claude you link in Your account." }, turns, gloss('turn', 'Turns')),
            h(
              'button',
              {
                type: 'button',
                class: 'secondary small',
                onclick: async () => {
                  const r = await api(`api/people/${u.id}/invite`, { method: 'POST' }).catch(fail);
                  if (r) {
                    show(u, r.token, u.has_password ? 'Password reset' : 'Invite', r.origin);
                    render(await api('api/people'));
                  }
                },
              },
              u.has_password ? 'Reset link' : u.admin ? 'Set-password link' : 'New invite',
            ),
            !self && h('button', { type: 'button', class: 'secondary small', onclick: () => patch({ disabled: !u.disabled }, `${u.disabled ? 'enable' : 'disable'} ${u.name}`) }, u.disabled ? 'Enable' : 'Disable'),
            !self &&
              h(
                'button',
                {
                  type: 'button',
                  class: 'secondary small',
                  onclick: () => {
                    if (!confirm(`Remove ${u.name} from Citadel? Schemes they own become yours; their messages stay.`)) return;
                    let at = -1;
                    optimistic({
                      key: `person:${u.id}`,
                      apply: () => {
                        at = shown.findIndex((x) => x.id === u.id);
                        render(shown.filter((x) => x.id !== u.id));
                      },
                      send: () => api(`api/people/${u.id}`, { method: 'DELETE' }),
                      undo: () => at >= 0 && !shown.some((x) => x.id === u.id) && render(shown.toSpliced(Math.min(at, shown.length), 0, u)),
                      label: `remove ${u.name}`,
                    });
                  },
                },
                'Remove',
              ),
          ),
        );
      }),
    )
  );
  const form = h('form', { class: 'machine-add' }, h('label', {}, 'Name', name), h('label', {}, 'Login', login), h('button', { type: 'submit' }, 'Invite'), status);
  form.onsubmit = async (e) => {
    e.preventDefault();
    status.textContent = 'Inviting…';
    try {
      const r = await api('api/people', { method: 'POST', body: { name: name.value.trim(), login: login.value.trim() || undefined } });
      show(r.person, r.token, 'Invite', r.origin);
      name.value = login.value = '';
      status.textContent = '';
      render(await api('api/people'));
    } catch (err) {
      status.textContent = err.message;
    }
  };
  api('api/people').then(render).catch(fail);
  // A limited GitHub link GitHub handed an expiring token: only an admin can fix the App, so it shows here (#670).
  const refused = h('div');
  api('api/github/refused')
    .then(
      (r) =>
        r &&
        refused.replaceChildren(
          h(
            'div',
            { class: 'github-refused', role: 'status' },
            h('p', {}, h('b', {}, `Citadel refused ${r.name}'s limited GitHub link`), ` (${new Date(r.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}). `, r.fix),
            r.settings_url ? h('p', {}, h('a', { href: r.settings_url, target: '_blank', rel: 'noopener' }, "Open the App's settings on GitHub")) : '',
          ),
        ),
    )
    .catch((err) => refused.replaceChildren(h('p', { class: 'error', role: 'status' }, `Couldn't check for refused GitHub links (${err.message}); reload the page to try again.`)));
  return page(
    head('People', settingsHelp('Everyone who can sign in to Citadel.', 'Each person sees only the schemes they own or were added to, and can make schemes of their own.')),
    refused,
    h('div', { class: 'settings-rows' }, settingsRow({ part: 'invite-someone', icon: 'plugplus', hue: 'done', title: 'Invite someone', summary: 'Name and login; you send them the link' }, form)[0]),
    link,
    h('h3', { class: 'settings-section' }, 'Everyone'),
    list,
    settingsHelp("Each person's messages start turns on their own Claude plan, which they link in Your account.", "Until they do, they can still read, write and add minions; their messages wait in the chat. Turns: whether your messages run on this server's own Claude login, which is your subscription."),
  );
}

/**
 * One account card as a row that opens (#995): the card's own heading moves into the row's title, its status chip into
 * the summary, kept in step as the card redraws itself.
 */
function accountRow(ic, hue, title, card, fallback = '', { part } = {}) {
  const [row, sum] = settingsRow({ part, icon: ic, hue, title }, card);
  const sync = () => {
    const chip = card.querySelector(':scope > h3 .link-chip');
    // A card whose load failed holds only its error: say so while the row is closed.
    const err = !chip && card.querySelector('.error');
    sum.replaceChildren(chip ? chip.cloneNode(true) : err ? "Couldn't load: open for details" : fallback);
  };
  new MutationObserver(sync).observe(card, { childList: true, subtree: true, characterData: true });
  sync();
  return row;
}

/** Main panel: your own name, login and password. */
export function accountPage() {
  const current = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const next = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 10, maxlength: 200 });
  const again = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 10, maxlength: 200 });
  const status = h('span', { class: 'muted', role: 'status' });
  const form = h(
    'form',
    { class: 'account-form' },
    h('input', { name: 'login', autocomplete: 'username', value: account?.login ?? '', hidden: true }),
    h('label', {}, 'Current password', current),
    h('label', {}, 'New password', next),
    h('label', {}, 'New password again', again),
    h('div', { class: 'row' }, h('button', { type: 'submit' }, 'Change password'), status),
  );
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (next.value !== again.value) return void (status.textContent = 'The two new passwords differ.');
    status.textContent = 'Saving…';
    try {
      await api('api/me/password', { method: 'PUT', body: { current: current.value, password: next.value } });
      form.reset();
      status.textContent = 'Changed.';
    } catch (err) {
      status.textContent = err.message;
    }
  };
  return page(
    head('Your account', [`Signed in as ${account?.name} (login ${account?.login ?? '—'})`, account?.admin ? ', an admin.' : '.', account?.turns ? '' : " Your messages don't start turns yet: they wait in the chat until you link your Claude below."]),
    h(
      'div',
      { class: 'settings-rows' },
      accountRow('spark', 'accent', 'Claude', claudeCard(), '', { part: 'claude-login' }),
      accountRow('key', 'running', 'Codex', codexCard()),
      accountRow('branch', 'ink', 'GitHub', githubCard(), '', { part: 'github-login' }),
      accountRow('globe', 'held', 'OpenRouter', openrouterCard()),
      accountRow('vault', 'done', 'Secrets', secretsCard(), 'Passwords and keys for minions and apps', { part: 'secrets' }),
      accountRow('check', 'teal', 'App chats for replay tests', replayCard(), 'Whether apps may keep your first few turns'),
      // Last, and closed until asked for (Cara picked "Password behind a button").
      settingsRow({ part: 'password', icon: 'lock', hue: 'muted', title: 'Password', summary: 'Change the password you sign in with' }, form)[0],
    ),
  );
}

/** Kept app chats (#836): a person's way to keep their app chats out of replay tests. */
function replayCard() {
  const box = h('input', { type: 'checkbox', checked: account?.keepChats !== false });
  box.onchange = () => {
    const keep = box.checked;
    const set = (v) => {
      box.checked = v;
      if (account) account.keepChats = v;
    };
    optimistic({
      key: 'replay',
      sets: 'replay',
      apply: () => set(keep),
      send: () => api('api/me/replay', { method: 'PUT', body: { keep } }),
      undo: () => set(!keep),
      label: keep ? 'keep your app chats for replay tests' : 'stop keeping your app chats',
    });
  };
  return h(
    'div',
    { class: 'account-card replay-card' },
    h('h3', {}, 'App chats for replay tests'),
    h('label', { class: 'toggle' }, box, 'Keep my first few turns of app chats when the app asks'),
    h(
      'p',
      { class: 'muted small' },
      "An app can keep the first five turns of a chat (what you typed, what its agent did and said) in its scheme's files for 30 days, so its developers can rerun them when they change the agent's prompt. They aren't listed in Files, and deleting the chat deletes them. Turning this off deletes what was kept of yours and keeps nothing more.",
    ),
  );
}

/** A plan's week as of its last turn: "41%, resets Mon 9:00 AM", or null before its first turn. */
const weekText = (w) => (w ? `${Math.round(Math.min(1, Math.max(0, w.utilization)) * 100)}%${w.resetsAt ? `, resets ${new Date(w.resetsAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}` : null);

/** A window's use as of its account's last turn: "41%". */
const pctText = (w) => `${Math.round(Math.min(1, Math.max(0, w.utilization)) * 100)}%`;
const clock = (ms) => new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

/** One account's meters: "5 hours 41% · week 62%, resets Thu 9:00 AM", or nothing before its first turn. */
const meterText = (u) => [u?.session && `5 hours ${pctText(u.session)}`, u?.weekly && `week ${weekText(u.weekly)}`].filter(Boolean).join(' · ');

/**
 * Your own Claude plan (#213): turns you start run on it, in a container of your own on the server. Up to three
 * accounts (#779): new and cold turns go to the one whose week resets soonest, or the one pinned (#793).
 */
function claudeCard() {
  const card = h('div', { class: 'account-card' }, loadingLine('Loading Claude…'));
  let poll = null;
  const render = (st) => {
    clearTimeout(poll);
    if (!card.isConnected && poll) return;
    const title = (chip, cls = '') => h('h3', {}, 'Claude', h('span', { class: `link-chip ${cls}` }, chip));
    const errLine = st.error ? h('p', { class: 'error', role: 'status' }, st.error) : '';
    const act = (label, method, path, body, cls = '') =>
      h(
        'button',
        {
          type: 'button',
          class: `small ${cls}`,
          onclick: async (e) => {
            e.target.disabled = true;
            render(await api(path, { method, body }).catch((err) => ({ ...st, error: err.message })));
          },
        },
        label,
      );
    const link = (label, account) => act(label, 'POST', 'api/me/claude', account ? { account } : {});
    const accounts = st.accounts ?? [];
    const unlink = (a) =>
      h(
        'button',
        {
          type: 'button',
          class: 'secondary small',
          onclick: async () => {
            const last = accounts.length < 2;
            if (!confirm(last ? 'Unlink your Claude? Citadel signs you out and deletes your container and its files; your messages wait in the chat until you link again.' : `Unlink ${a.email ?? `account ${a.n}`}? Citadel signs it out and deletes its folder; your turns carry on with your other accounts.`)) return;
            render(await api(`api/me/claude?account=${a.n}&unlink=1`, { method: 'DELETE' }).catch((err) => ({ ...st, error: err.message })));
          },
        },
        'Unlink',
      );
    const note = h(
      'p',
      { class: 'muted small' },
      'Turns you start run on your plan and count against its limits. ',
      st.host
        ? 'Each extra account signs in with Anthropic on the server, in a folder of its own: Citadel never sees a password or token, only the one-time code you paste here. '
        : 'Every account signs in with Anthropic inside your own container on the server: Citadel never sees a password or token, only the one-time code you paste here. ',
      "Link only accounts of your own: sharing one breaks Anthropic's terms.",
    );
    // One failed poll is tried again while the card shows: a restart or a dropped request mustn't end it (#1856).
    const again = (ms = 2000) => (poll = setTimeout(() => api('api/me/claude').then(render, () => card.isConnected && again(5000)), ms));
    if (st.state === 'starting') {
      again();
      return card.replaceChildren(title('Starting', 'off'), errLine, h('p', {}, st.host ? "Starting Anthropic's sign-in." : "Starting your container and Anthropic's sign-in. The first time builds Citadel's image, which can take a few minutes."));
    }
    if (st.state === 'waiting for code') {
      const code = h('input', { placeholder: 'Paste the code here', autocomplete: 'off', spellcheck: 'false', required: true, maxlength: 2000 });
      const send = h('button', { type: 'submit' }, 'Finish signing in');
      const form = h('form', { class: 'row' }, code, send);
      form.onsubmit = async (e) => {
        e.preventDefault();
        send.disabled = true;
        send.textContent = 'Signing in…';
        render(
          // Refused: the sign-in may be gone (a restart, another tab), so show what there is now (#1856).
          await api('api/me/claude/code', { method: 'POST', body: { code: code.value.trim() } }).catch((err) =>
            api('api/me/claude').then(
              (now) => ({ ...now, error: err.message }),
              () => ({ ...st, error: err.message }),
            ),
          ),
        );
      };
      return card.replaceChildren(
        title(st.linking > 1 || accounts.length ? `Signing in account ${st.linking}` : 'Signing in', 'off'),
        errLine,
        h('p', {}, '1. ', h('a', { href: st.url, target: '_blank', rel: 'noopener noreferrer' }, "Open Anthropic's sign-in"), ' and sign in with your Claude account.'),
        h('p', {}, '2. Paste the code it shows you:'),
        form,
        h('div', { class: 'row' }, act('Cancel', 'DELETE', `api/me/claude?account=${st.linking}`, undefined, 'secondary')),
        note,
      );
    }
    if (!accounts.length) {
      return card.replaceChildren(title('Not linked', 'off'), errLine, h('p', {}, 'Link your Claude plan so the turns your messages start run on it. Until then your messages wait in the chat.'), h('div', { class: 'row' }, link('Link Claude')), note);
    }
    const usageFor = (n) => st.usage?.accounts?.find((a) => a.n === n)?.usage ?? (n === (st.usage?.account ?? st.inUse) ? st.usage : null);
    // Pin and Unpin (#793) show at once and send behind; a refusal puts the pin back.
    const pin = (a, on) =>
      h(
        'button',
        {
          type: 'button',
          class: 'secondary small',
          title: on ? "New minions and cold wakes run on this account while it's ready" : 'Let Citadel pick again: soonest weekly reset first',
          onclick: () =>
            optimistic({
              sets: `claude-use:${account?.id}`,
              apply: () => render({ ...st, pinned: on ? a.n : undefined, ...(on && a.ready ? { inUse: a.n } : {}) }),
              send: () =>
                api('api/me/claude/use', { method: 'POST', body: { account: on ? a.n : null } }).then((next) => {
                  render(next);
                  renderUsage(next.usage);
                }),
              undo: () => render(st),
              label: on ? `pin ${a.email ?? `account ${a.n}`}` : 'unpin',
            }),
        },
        on ? 'Pin' : 'Unpin',
      );
    const now = Date.now();
    const rows = accounts.map((a) => {
      const own = st.host && a.n === 1;
      const same = st.usage?.accounts?.find((x) => x.n === a.n)?.same;
      const [chip, cls] = a.expired ? ['Needs linking again', 'warn'] : a.limitedUntil > now ? [`Limited until ${clock(a.limitedUntil)}`, 'warn'] : a.n === st.pinned ? ['Pinned', 'use'] : a.n === st.inUse ? ['Next up', 'use'] : ['Ready', 'ok'];
      return h(
        'li',
        { class: `acct${a.n === st.inUse ? ' in-use' : ''}` },
        h('span', { class: 'n' }, String(a.n)),
        h('span', { class: 'who' }, h('strong', {}, own ? 'Server login' : a.email || `Account ${a.n}`), h('span', { class: `link-chip ${cls}` }, chip), same ? h('span', { class: 'link-chip warn' }, `Same Claude account as ${same}`) : '', a.plan ? h('span', { class: 'muted small' }, a.plan) : ''),
        h('span', { class: 'acts' }, a.expired && !own ? link('Link again', a.n) : '', accounts.length < 2 ? '' : a.n === st.pinned ? pin(a, false) : a.expired ? '' : pin(a, true), own ? '' : unlink(a)),
        h('span', { class: 'meters' }, meterText(usageFor(a.n)) || 'No turns on it yet'),
      );
    });
    const ready = accounts.filter((a) => a.ready).length;
    const allExpired = accounts.every((a) => a.expired);
    const full = accounts.length >= 3;
    const chip = st.host ? ['Server login', 'ok'] : allExpired ? ['Needs linking again', 'warn'] : accounts.length > 1 ? [`${ready} of ${accounts.length} ready`, ready ? 'ok' : 'warn'] : ['Linked', 'ok'];
    return card.replaceChildren(
      title(...chip),
      errLine,
      allExpired ? h('p', {}, 'Anthropic stopped accepting your sign-in (signed out or expired). Your messages wait in the chat until you link again.') : '',
      accounts.length > 1
        ? h(
            'p',
            { class: 'small' },
            st.pinned ? `Pinned to account ${st.pinned}: new minions and cold wakes run on it while it's ready. If it hits a limit they carry on with another, and come back once it resets. ` : "New minions and cold wakes go to the account whose week resets soonest, so its allowance isn't lost at the reset. ",
            'A minion that ran in the last hour stays on its account while it has room, since moving it rereads its whole conversation; once that account is nearly out for the week, it moves at its next turn. A usage limit moves turns at once, mid-turn included.',
          )
        : '',
      h('ol', { class: 'acct-list' }, rows),
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            type: 'button',
            class: 'small',
            disabled: full,
            title: full ? 'Three accounts at most' : 'Sign in another Claude account of yours',
            onclick: (e) => {
              e.target.disabled = true;
              api('api/me/claude', { method: 'POST', body: {} })
                .then(render)
                .catch((err) => render({ ...st, error: err.message }));
            },
          },
          'Link another account',
        ),
        full ? h('span', { class: 'muted small' }, 'Three at most') : '',
      ),
      note,
    );
  };
  api('api/me/claude')
    .then(render)
    .catch((err) => card.replaceChildren(h('p', { class: 'error' }, err.message)));
  return card;
}

/** Your own Codex (#330): a second-opinion reviewer on your ChatGPT plan, signed in inside your Claude container. */
function codexCard() {
  const card = h('div', { class: 'account-card' }, loadingLine('Loading Codex…'));
  let poll = null;
  const render = (st) => {
    clearTimeout(poll);
    if (!card.isConnected && poll) return;
    const title = (chip, cls = '') => h('h3', {}, 'Codex', h('span', { class: `link-chip ${cls}` }, chip));
    const errLine = st.error ? h('p', { class: 'error', role: 'status' }, st.error) : '';
    const act = (label, method, cls = '', ask = '', path = 'api/me/codex') =>
      h(
        'button',
        {
          type: 'button',
          class: `small ${cls}`,
          onclick: async (e) => {
            if (ask && !confirm(ask)) return;
            e.target.disabled = true;
            render(await api(path, { method }).catch((err) => ({ ...st, error: err.message })));
          },
        },
        label,
      );
    const note = h('p', { class: 'muted small' }, 'Self-review asks Codex for a second opinion on your ChatGPT plan, counting against its limits. ', 'You sign in with OpenAI inside your own container on the server: Citadel never sees your password or token.');
    const again = (ms = 2000) => (poll = setTimeout(() => api('api/me/codex').then(render, () => card.isConnected && again(5000)), ms));
    if (st.override !== undefined) setCodex(st.override);
    // Josh, 2026-11-05: the override lives here, beside the sign-in, not in view all the time.
    const override =
      st.override && (st.state === 'linked' || st.override.on)
        ? h(
            'div',
            { class: 'codex-override' },
            codexToggle(),
            h(
              'p',
              { class: 'muted small' },
              'Runs your minions, Taskmasters and apps on Codex instead of Claude until you turn it off: handy when your Claude usage runs out. A Claude model picked for a minion runs as the Codex model of the same tier, and each conversation carries over word for word both ways. The left panel offers it too once your Claude usage passes 90%.',
            ),
          )
        : '';
    if (st.state === 'no container') {
      return card.replaceChildren(title('Needs your Claude', 'off'), errLine, h('p', { class: 'muted' }, 'Codex signs in inside your own Claude container, so link your Claude above first.'), override);
    }
    if (st.state === 'starting') {
      again();
      return card.replaceChildren(title('Starting', 'off'), errLine, h('p', {}, "Starting your container and OpenAI's sign-in. After an update this rebuilds Citadel's image, which can take a few minutes."));
    }
    if (st.state === 'waiting') {
      again();
      return card.replaceChildren(
        title('Signing in', 'off'),
        errLine,
        h('p', {}, '1. ', h('a', { href: st.url, target: '_blank', rel: 'noopener noreferrer' }, "Open OpenAI's sign-in"), ' and sign in with your ChatGPT account.'),
        h('p', {}, '2. Enter this code there (it lasts 15 minutes): ', h('code', {}, st.code)),
        h('p', { class: 'muted small' }, "This page carries on by itself once you're signed in. If OpenAI refuses the code, turn on device code sign-in for Codex in ChatGPT's security settings."),
        h('div', { class: 'row' }, act('Cancel', 'DELETE', 'secondary')),
        override,
        note,
      );
    }
    if (st.state === 'linked') {
      return card.replaceChildren(
        title('Linked', 'ok'),
        errLine,
        h('p', {}, 'Signed in with ChatGPT.'),
        st.override ? codexWindowsBlock() : '',
        h('div', { class: 'row' }, act('Sign out', 'DELETE', 'secondary', "Sign out of Codex? Self-review stops asking it, and your turns can't run on it, until you sign in again.", 'api/me/codex?unlink=1')),
        override,
        note,
      );
    }
    return card.replaceChildren(title('Not linked', 'off'), errLine, h('p', {}, 'Sign in to Codex with your ChatGPT plan, and self-review gets a second opinion from another model family.'), h('div', { class: 'row' }, act('Link Codex', 'POST')), override, note);
  };
  api('api/me/codex')
    .then(render)
    .catch((err) => card.replaceChildren(h('p', { class: 'error' }, err.message)));
  return card;
}

/**
 * Saved secrets (#838): your own, and those of the schemes you're in, by name. A value goes in (Add, Replace) and
 * never comes back out, not even to you; turns get them as $CITADEL_SECRET_<NAME>, contraptions by name.
 */
function secretsCard() {
  const card = h('div', { class: 'account-card secrets-card' }, loadingLine('Loading secrets…'));
  let schemes = [];
  const where = (s) => (s.scope === 'scheme' ? { scope: 'scheme', project: s.project } : { scope: 'person' });
  const valueInput = () => h('input', { type: 'password', ...noAutofill('secret-value', 'new-password'), spellcheck: 'false', placeholder: 'The value', required: true, 'data-draft': true, 'aria-label': 'The value' });
  const row = (s, st) => {
    const status = h('span', { class: 'muted small', role: 'status' });
    const replace = h('button', { type: 'button', class: 'secondary small' }, 'Replace');
    const del = h('button', { type: 'button', class: 'secondary small' }, 'Delete');
    const el = h(
      'div',
      { class: 'secret-item', 'data-key': `${s.scope}|${s.project ?? ''}|${s.name}` },
      h('div', { class: 'row' }, h('code', {}, s.name), h('span', { class: 'muted small' }, `${s.scope === 'scheme' ? `${s.project_name} (scheme)` : 'yours'} · ${s.updated_by ? `${s.updated_by}, ` : ''}${ago(s.updated_at)}`), h('span', { class: 'spacer' }), replace, del),
      status,
    );
    replace.onclick = () => {
      const value = valueInput();
      const form = h('form', { class: 'row secret-form' }, value, h('button', { type: 'submit', class: 'small' }, 'Save'), h('button', { type: 'button', class: 'secondary small', onclick: () => form.remove() }, 'Cancel'));
      form.onsubmit = async (e) => {
        e.preventDefault();
        status.textContent = 'Saving…';
        try {
          await api('api/secrets', { method: 'PUT', body: { ...where(s), name: s.name, value: value.value } });
          value.value = ''; // saved: the reload must not open this form again
          load();
        } catch (err) {
          status.textContent = err.message;
        }
      };
      el.querySelector('.secret-form')?.remove();
      el.insertBefore(form, status);
      value.focus();
    };
    del.onclick = () => {
      if (!confirm(`Delete the secret ${s.name}? Turns and apps that use it stop getting it.`)) return;
      const without = { person: st.person.filter((x) => x !== s), schemes: st.schemes.filter((x) => x !== s) };
      optimistic({ apply: () => render(without), send: () => api('api/secrets', { method: 'DELETE', body: { ...where(s), name: s.name } }), undo: () => render(st), label: `delete ${s.name}` }).then(load, () => {});
    };
    return el;
  };
  const addForm = () => {
    const name = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'AZURE_SPEECH_KEY', required: true, pattern: '[A-Za-z][A-Za-z0-9_]{0,63}', 'data-draft': true, 'aria-label': 'Name' });
    const value = valueInput();
    const whose = h('select', { 'aria-label': 'Whose' }, h('option', { value: '' }, 'Mine'), ...schemes.map((p) => h('option', { value: p.id }, `${p.name} (scheme)`)));
    const status = h('span', { class: 'muted small', role: 'status' });
    const form = h('form', { class: 'secret-add' }, h('label', {}, 'Name', name), h('label', {}, 'Value', value), h('label', {}, 'Whose', whose), h('div', { class: 'row' }, h('button', { type: 'submit', class: 'small' }, 'Add'), status));
    form.onsubmit = async (e) => {
      e.preventDefault();
      status.textContent = 'Saving…';
      try {
        await api('api/secrets', { method: 'PUT', body: { ...(whose.value ? { scope: 'scheme', project: Number(whose.value) } : { scope: 'person' }), name: name.value, value: value.value } });
        form.reset(); // its own save is the only thing that clears it
        status.textContent = '';
        load();
      } catch (err) {
        status.textContent = err.message;
      }
    };
    return form;
  };
  let add = null; // built once: a reload for another secret's Replace or Delete must not empty a half-typed new one
  const render = (st) => {
    const all = [...st.person, ...st.schemes];
    // A half-typed Replace on another secret is opened again on its new row.
    const typed = new Map([...card.querySelectorAll('.secret-item')].map((el) => [el.dataset.key, el.querySelector('.secret-form input')?.value]).filter(([, v]) => v));
    add ??= addForm();
    const was = document.activeElement;
    card.replaceChildren(
      h('h3', {}, 'Secrets'),
      h('p', { class: 'small' }, 'Passwords and keys for minions and apps, saved here instead of typed into a chat. A minion gets them as ', h('code', {}, '$CITADEL_SECRET_<NAME>'), ": yours in turns that run as you, a scheme's in every turn in it. Values are kept encrypted and never shown again."),
      all.length
        ? h(
            'div',
            { class: 'secret-list' },
            all.map((s) => {
              const el = row(s, st);
              const v = typed.get(el.dataset.key);
              if (v) {
                [...el.querySelectorAll('button')][0].onclick();
                el.querySelector('.secret-form input').value = v;
              }
              return el;
            }),
          )
        : h('p', { class: 'muted small' }, 'None saved yet.'),
      add,
    );
    if (was && add.contains(was)) was.focus(); // the add form is moved, not rebuilt, but a move drops focus
  };
  const load = () =>
    Promise.all([api('api/secrets'), api('api/projects')])
      .then(([st, projects]) => {
        schemes = projects.filter((p) => p.member);
        render(st);
      })
      .catch((err) => card.replaceChildren(h('p', { class: 'error' }, err.message)));
  load();
  return card;
}

/** Your own OpenRouter key and monthly cap (#717): minions working for you make images and sounds on it, never past the cap. */
function openrouterCard() {
  const card = h('div', { class: 'account-card openrouter-card' }, loadingLine('Loading OpenRouter…'));
  const usd = (n) => `$${Number(n).toFixed(2)}`;
  const ext = (href, text) => h('a', { href, target: '_blank', rel: 'noopener' }, text);
  const title = (chip, cls = '') => h('h3', {}, 'OpenRouter', h('span', { class: `link-chip ${cls}` }, chip));
  const keysPage = () => ext('https://openrouter.ai/settings/keys', "OpenRouter's keys page");
  const capInput = (value) => h('input', { type: 'number', name: 'cap', min: '1', max: '1000', step: '1', value: String(value), inputmode: 'decimal', class: 'cap-input', 'aria-label': 'Monthly cap in dollars' });
  // Connecting asks OpenRouter whether the key works, so it shows busy on this card until it answers.
  const connectForm = (st, again) => {
    const key = h('input', { type: 'password', ...noAutofill('openrouter-key', 'new-password'), spellcheck: 'false', placeholder: 'sk-or-v1-…', required: true });
    const cap = capInput(st.cap_usd ?? st.default_cap_usd ?? 10);
    const status = h('span', { class: 'muted small', role: 'status' });
    const button = h('button', { type: 'submit', class: 'small' }, again ? 'Connect again' : 'Connect');
    const form = h('form', { class: 'openrouter-form' }, h('label', {}, 'Key', key), h('label', {}, 'Monthly cap ($)', cap), h('div', { class: 'row' }, button, status));
    form.onsubmit = async (e) => {
      e.preventDefault();
      button.disabled = true;
      status.textContent = 'Checking the key with OpenRouter…';
      try {
        render(await api('api/me/openrouter', { method: 'POST', body: { key: key.value.trim(), cap: Number(cap.value) } }));
      } catch (err) {
        status.textContent = err.message;
        button.disabled = false;
      }
    };
    return form;
  };
  const render = (st) => {
    const note = h('p', { class: 'muted small' }, 'The key is kept encrypted on the server and never shown again, not even to you; minions never see it. ', "For a hard stop on OpenRouter's side too, give the key a credit limit on ", keysPage(), '.');
    if (!st.connected) {
      return card.replaceChildren(
        title('Not connected', 'off'),
        h('p', {}, 'Optional. Connect your own OpenRouter key and minions working for you can make images, sounds and speech (generate_image, edit_image, generate_audio, generate_speech). Each call is paid from your key, and Citadel refuses any call that could take you past your monthly cap.'),
        h('p', { class: 'small' }, 'Make a key on ', keysPage(), ', then paste it here.'),
        connectForm(st, false),
        note,
      );
    }
    const disconnect = h(
      'button',
      {
        type: 'button',
        class: 'secondary small',
        onclick: () => {
          if (!confirm("Disconnect OpenRouter? Citadel forgets the key; minions working for you can't make media until you connect again.")) return;
          optimistic({ apply: () => render({ connected: false, default_cap_usd: st.cap_usd }), send: () => api('api/me/openrouter', { method: 'DELETE' }), undo: () => render(st), label: 'disconnect OpenRouter' }).then(render, () => {});
        },
      },
      'Disconnect',
    );
    if (st.failed) {
      return card.replaceChildren(
        title('Needs connecting again', 'warn'),
        h('p', {}, "OpenRouter stopped accepting this key (deleted or disabled there, or the server's secret changed). Minions can't make media for you until you connect a working key."),
        connectForm(st, true),
        h('div', { class: 'row' }, disconnect),
        note,
      );
    }
    // The cap's new number shows at once; a refusal puts the old one back.
    const cap = capInput(st.cap_usd);
    const capForm = h('form', { class: 'openrouter-cap' }, h('label', {}, 'Monthly cap ($)', cap), h('button', { type: 'submit', class: 'small secondary' }, 'Save cap'));
    capForm.onsubmit = (e) => {
      e.preventDefault();
      const next = Math.round(Number(cap.value) * 100) / 100;
      if (!(next > 0)) return;
      optimistic({
        key: 'openrouter-cap',
        sets: 'openrouter-cap',
        apply: () => render({ ...st, cap_usd: next, left_usd: Math.max(0, next - st.spent_usd) }),
        send: () => api('api/me/openrouter', { method: 'PATCH', body: { cap: next } }),
        undo: () => render(st),
        label: 'save your OpenRouter cap',
      }).then(render, () => {});
    };
    const orLimit = st.or_limit != null ? `${usd(st.or_limit)}${st.or_limit_reset ? ` (${st.or_limit_reset})` : ''}` : h('span', {}, 'None set: add one on ', keysPage(), ' for a hard stop');
    return card.replaceChildren(
      title('Connected', 'ok'),
      h(
        'dl',
        { class: 'kv' },
        h('dt', {}, 'This month'),
        h('dd', {}, `${usd(st.spent_usd)} of ${usd(st.cap_usd)} spent, ${usd(st.left_usd)} left`),
        h('dt', {}, 'Cap resets'),
        h('dd', {}, st.resets),
        h('dt', {}, 'Limit on OpenRouter'),
        h('dd', {}, orLimit),
        h('dt', {}, 'Connected'),
        h('dd', {}, new Date(st.linked_at).toLocaleDateString(undefined, { dateStyle: 'medium' })),
      ),
      capForm,
      h('div', { class: 'row' }, disconnect),
      note,
    );
  };
  api('api/me/openrouter')
    .then(render)
    .catch((err) => card.replaceChildren(h('p', { class: 'error' }, err.message)));
  return card;
}

/** Your GitHub link: turns you start push and open pull requests as you (src/github-link.ts). */
function githubCard() {
  const card = h('div', { class: 'account-card' }, loadingLine('Loading GitHub…'));
  const render = ({ configured, full, limited, install_url, error, link }) => {
    const title = (chip, cls = '') => h('h3', {}, 'GitHub', h('span', { class: `link-chip ${cls}` }, chip));
    const errLine = error ? h('p', { class: 'error', role: 'status' }, error) : '';
    // Two ways to link (#464): the OAuth App's full access, and the GitHub App's limited one. Linking again replaces the link.
    const linkBtn = (label, kind, cls = '') => h('a', { class: `button small ${cls}`, href: `api/github/link?project=${view.projectId}${kind === 'limited' ? '&kind=limited' : ''}` }, label);
    const ext = (href, text) => h('a', { href, target: '_blank', rel: 'noopener' }, text);
    const install = "installs Citadel's GitHub App"; // text only: the one install link is installBlock (#1557)
    // GitHub hands the install link's state to the App's Setup URL, which brings the person back to this scheme (#670).
    // The one install link, in every state that doesn't already show it as step 1 of the two steps (#1557).
    const installBlock = install_url
      ? h(
          'div',
          { class: 'link-install' },
          h('a', { class: 'button small secondary install-app', href: `${install_url}?state=${view.projectId}`, target: '_blank', rel: 'noopener' }, 'Install the GitHub app on a repo ↗'),
          h('p', { class: 'muted small' }, 'On GitHub pick your account, choose "Only select repositories" and pick the repo. If the app is already installed, the same page opens its settings, where you add repos. Only a repo\'s owner (or an org admin) can install it there. Installing alone doesn\'t link you.'),
        )
      : '';
    const kinds = h(
      'ul',
      { class: 'muted small link-kinds' },
      full ? h('li', {}, h('b', {}, 'Full access'), ': Citadel can act on every repo your GitHub account can reach.') : '',
      limited ? h('li', {}, h('b', {}, 'Limited'), ": Citadel can act only on repos where the repo's owner ", install, ' and you already have access. Nothing else in your account.') : '',
    );
    const linkRow = (again = '') =>
      h(
        'div',
        { class: 'row' },
        full ? linkBtn(`Link GitHub${again}${limited ? ' (full access)' : ''}`, 'full') : '',
        // Both the same weight: neither grant is the one Citadel nudges people toward.
        limited ? linkBtn(`Link GitHub${again}${full ? ' (limited)' : ''}`, 'limited') : '',
      );
    const unlink = h(
      'button',
      {
        type: 'button',
        class: 'secondary small',
        onclick: async () => {
          if (!confirm('Unlink your GitHub? Citadel forgets the token and revokes it on GitHub; your turns stop pushing until you link again.')) return;
          render((await api('api/me/github', { method: 'DELETE' }).catch(fail)) ?? { configured, full, limited, install_url, error: null, link });
        },
      },
      'Unlink',
    );
    const note = h(
      'p',
      { class: 'muted small' },
      'The link lasts until you unlink it here or revoke "Citadel" on GitHub under ',
      ext('https://github.com/settings/applications', 'Settings → Applications'),
      '. ',
      "Links are kept encrypted with the server's session secret: if an admin changes that secret, everyone links again.",
    );
    if (!configured) {
      return card.replaceChildren(title('Not set up', 'off'), errLine, h('p', { class: 'muted' }, "An admin hasn't set up Citadel's GitHub linking yet (see the README), so turns push with the server's own GitHub login."));
    }
    // Installing the App links nothing by itself (#670): say the order, install on your own repos, then link.
    const steps = limited
      ? h(
          'div',
          { class: 'link-steps' },
          h('p', { class: 'small' }, h('b', {}, 'Limited, in two steps'), full ? ' (full access is one: just press its button)' : '', ':'),
          h(
            'ol',
            { class: 'small' },
            h('li', {}, "Install Citadel's GitHub App (the button above)", ' on your own repos. On GitHub, choose "Only select repositories" to pick which. Skip this for repos someone else owns: their owner installs it.'),
            h('li', {}, `Press Link GitHub${full ? ' (limited)' : ''} below and authorize Citadel on GitHub. GitHub usually brings you straight on to this step.`),
          ),
        )
      : '';
    if (!link) {
      return card.replaceChildren(title('Not linked', 'off'), errLine, h('p', {}, "Link your GitHub so turns you start push branches and open pull requests as you. Until then they run and commit, but can't push."), kinds, installBlock, steps, linkRow(), note);
    }
    if (link.failed) {
      return card.replaceChildren(
        title('Needs linking again', 'warn'),
        errLine,
        h('p', {}, `GitHub stopped accepting Citadel's link for @${link.login} (revoked on GitHub, or the server's secret changed). Your turns can't push until you link again.`),
        kinds,
        installBlock,
        h('div', { class: 'row' }, ...linkRow(' again').childNodes, unlink),
      );
    }
    const repoLinks = (link.reach ?? []).flatMap((slug, i) => [i ? ', ' : '', ext(`https://github.com/${slug}`, slug)]);
    const reach = !link.limited ? 'Every repo your GitHub account can reach' : !link.reach ? ['Only repos where the owner ', install, " (GitHub didn't say which just now)"] : link.reach.length ? repoLinks : 'No repos yet';
    const other = link.limited ? (full ? linkBtn('Switch to full access', 'full', 'secondary') : '') : limited ? linkBtn('Switch to limited', 'limited', 'secondary') : '';
    return card.replaceChildren(
      title(link.limited ? 'Linked, limited' : limited ? 'Linked, full access' : 'Linked', 'ok'),
      errLine,
      h(
        'dl',
        { class: 'kv' },
        h('dt', {}, 'Pushes and PRs as'),
        h('dd', {}, ext(`https://github.com/${link.login}`, `@${link.login}`)),
        h('dt', {}, 'Commits as'),
        h('dd', {}, `${link.name || link.login} <${link.email}>`),
        h('dt', {}, 'Can reach'),
        h('dd', {}, reach),
        h('dt', {}, 'Linked'),
        h('dd', {}, new Date(link.linked_at).toLocaleDateString(undefined, { dateStyle: 'medium' })),
      ),
      installBlock,
      link.limited ? h('p', { class: 'muted small' }, "Someone else's repo missing from the list: its owner installs Citadel's GitHub App on it.") : '',
      h('div', { class: 'row' }, other, unlink),
      note,
    );
  };
  api('api/me/github')
    .then(render)
    .catch((err) => card.replaceChildren(h('p', { class: 'error' }, err.message)));
  return card;
}
