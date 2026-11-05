// Settings tabs for who is in Citadel: a scheme's members, everyone (admins only), and your own account.
import { account, api, codexToggle, h, icon, setCodex, view } from './core.js';
import { settingsTabs } from './settings.js';
import { hideButton } from './hidden.js';
import { copyText } from './ui/markdown.js';

/** Whether you may change this scheme's members and settings: its owner, or an admin. */
export const ownsScheme = (project) => !!account && (account.admin || project.owner_id === account.id);

function head(title, meta) {
  return h('div', { class: 'ticket-head' },
    h('div', { class: 'row' }, h('h2', {}, 'Settings'), h('span', { class: 'spacer' }),
      h('a', { class: 'close-view', href: `#/p/${view.projectId}`, title: 'Back to the Taskmaster', 'aria-label': 'Close' }, icon('close'))),
    settingsTabs(),
    h('div', { class: 'meta' }, meta));
}

const page = (...children) => h('section', { class: 'artifacts-main people-main' }, ...children);
const fail = (err) => alert(err.message);

/** What Citadel did for a member on the scheme's GitHub repo (#310), or nothing. */
function githubLine(m) {
  const g = m.github;
  if (!g) return '';
  const repo = h('a', { href: `https://github.com/${g.slug}`, target: '_blank', rel: 'noopener' }, g.slug);
  const line = g.state === 'added' ? ['Can push to ', repo, ' (Citadel added them)']
    : g.state === 'existing' ? ['Can push to ', repo]
    : g.state === 'waiting' ? ['Gets push access to ', repo, ' once they link GitHub in Settings → Your account']
    : g.state === 'invited' ? ['Invited to ', repo, ': they accept on ', h('a', { href: `https://github.com/${g.slug}/invitations`, target: '_blank', rel: 'noopener' }, 'GitHub')]
    : ['No push access to ', repo];
  return h('span', { class: 'meta' }, ...line, g.error ? h('span', { class: 'error' }, ` · ${g.error}`) : '');
}

/** Main panel: who is in this scheme. Its owner (or an admin) adds and removes people. */
export function membersPage() {
  const p = view.project;
  const owns = ownsScheme(p);
  const list = h('div', { class: 'people-list' });
  const pick = h('select', { 'aria-label': 'Person to add' });
  const add = h('form', { class: 'row people-add' }, pick, h('button', { type: 'submit' }, 'Add'));
  const render = (members, people) => {
    const inIt = new Set(members.map((m) => m.id));
    list.replaceChildren(...members.map((m) => h('div', { class: 'person-row' },
      h('span', { class: 'text' }, h('span', { class: 'name' }, m.name), h('span', { class: 'meta' }, m.owner ? `${m.login} · owner` : m.login), githubLine(m)),
      owns && !m.owner && h('button', {
        type: 'button', class: 'secondary small',
        onclick: async () => {
          if (!confirm(`Take ${m.name} out of ${p.name}? They stop seeing it at once.`)) return;
          // A GitHub refusal still took them out of the scheme: show it, then the list as it is now.
          render(await api(`api/projects/${p.id}/members/${m.id}`, { method: 'DELETE' }).catch((err) => (fail(err), api(`api/projects/${p.id}/members`))).catch(fail) ?? members, people);
        },
      }, 'Remove'))));
    const others = people.filter((x) => !inIt.has(x.id));
    pick.replaceChildren(...others.map((x) => h('option', { value: x.id }, `${x.name} (${x.login})`)));
    add.hidden = !owns || !others.length;
    add.onsubmit = async (e) => {
      e.preventDefault();
      render(await api(`api/projects/${p.id}/members`, { method: 'POST', body: { person: Number(pick.value) } }).catch(fail) ?? members, people);
    };
  };
  Promise.all([api(`api/projects/${p.id}/members`), api('api/people')]).then(([members, people]) => render(members, people)).catch(fail);
  return page(
    head('Members', owns
      ? 'Only the people here see this scheme, its minions and its files. Anyone in it can add minions and chat; only the owner changes its members and settings.'
      : 'Only the people here see this scheme, its minions and its files. Its owner adds and removes people.'),
    list, add,
    h('h3', { class: 'settings-label' }, 'Just for you'),
    h('p', { class: 'muted small' }, 'Hiding takes the scheme out of your scheme lists, Needs-you badges and notifications. You stay in it, and its link still opens it.'),
    hideButton(p),
    account?.admin && h('p', { class: 'muted small' }, 'To add someone new to Citadel, invite them under People first.'));
}

/** The link an invite or reset token makes, with a Copy button: shown once, since only its hash is kept. */
function linkBox(who, token, what) {
  const url = `${location.origin}${location.pathname}#/invite/${token}`;
  const copy = h('button', { type: 'button', class: 'secondary small' }, 'Copy');
  copy.onclick = async () => {
    copy.textContent = await copyText(url) ? 'Copied' : 'Couldn\'t copy';
  };
  return h('div', { class: 'machine-setup' },
    h('div', { class: 'row' }, h('strong', {}, `${what} link for ${who.name}`), h('span', { class: 'spacer' }), copy),
    h('p', { class: 'small' }, 'Send it to them yourself. It works once, for 7 days, and is shown only now; if it gets lost, make a new one.'),
    h('pre', {}, url));
}

/** Main panel, admins only: invite people, make reset links, and decide who may use the server's Claude login. */
export function peoplePage() {
  const name = h('input', { name: 'name', placeholder: 'Josh', required: true, maxlength: 40, autocomplete: 'off' });
  const login = h('input', { name: 'login', placeholder: 'josh', maxlength: 32, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' });
  name.oninput = () => { login.placeholder = name.value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '') || 'josh'; };
  const status = h('span', { class: 'muted', role: 'status' });
  const link = h('div');
  const list = h('div', { class: 'people-list' });
  const show = (who, token, what) => link.replaceChildren(linkBox(who, token, what));
  const render = (people) => list.replaceChildren(...people.map((u) => {
    // An admin with no password of their own signs in with the shared one (COORDINATOR_PASSWORD).
    const state = u.disabled ? 'disabled' : u.invite_open ? (u.has_password ? 'reset link open' : 'invited')
      : u.has_password ? '' : u.admin ? 'shared password only' : 'invite expired';
    const patch = async (body) => render(await api(`api/people/${u.id}`, { method: 'PATCH', body }).then(() => api('api/people')).catch(fail) ?? people);
    const turns = u.server_login_owner && h('input', { type: 'checkbox', checked: u.server_login, onchange: (e) => patch({ server_login: e.target.checked }) });
    const claude = u.server_login ? 'Claude: server login' : u.claude === 'linked' ? 'Claude linked' : u.claude === 'expired' ? 'Claude needs linking again' : 'Claude not linked';
    const self = u.id === account?.id;
    return h('div', { class: 'person-row' },
      h('span', { class: 'text' },
        h('span', { class: 'name' }, u.name, u.admin ? ' · admin' : ''),
        h('span', { class: 'meta' }, [u.login, state, claude, u.week && `week ${Math.round(u.week.utilization * 100)}%`, u.github ? `GitHub @${u.github.login}${u.github.failed ? ' (needs linking again)' : ''}` : 'GitHub not linked'].filter(Boolean).join(' · '))),
      h('span', { class: 'person-actions' },
      turns && h('label', { class: 'small turns-toggle', title: 'Your messages start and steer turns on the server\'s Claude login. Off: they run on the Claude you link in Your account.' }, turns, 'Turns'),
      h('button', {
        type: 'button', class: 'secondary small',
        onclick: async () => {
          const r = await api(`api/people/${u.id}/invite`, { method: 'POST' }).catch(fail);
          if (r) { show(u, r.token, u.has_password ? 'Password reset' : 'Invite'); render(await api('api/people')); }
        },
      }, u.has_password ? 'Reset link' : u.admin ? 'Set-password link' : 'New invite'),
      !self && h('button', { type: 'button', class: 'secondary small', onclick: () => patch({ disabled: !u.disabled }) }, u.disabled ? 'Enable' : 'Disable'),
      !self && h('button', {
        type: 'button', class: 'secondary small',
        onclick: async () => {
          if (!confirm(`Remove ${u.name} from Citadel? Schemes they own become yours; their messages stay.`)) return;
          await api(`api/people/${u.id}`, { method: 'DELETE' }).catch(fail);
          render(await api('api/people'));
        },
      }, 'Remove')));
  }));
  const form = h('form', { class: 'machine-add' },
    h('label', {}, 'Name', name), h('label', {}, 'Login', login),
    h('button', { type: 'submit' }, 'Invite'), status);
  form.onsubmit = async (e) => {
    e.preventDefault();
    status.textContent = 'Inviting…';
    try {
      const r = await api('api/people', { method: 'POST', body: { name: name.value.trim(), login: login.value.trim() || undefined } });
      show(r.person, r.token, 'Invite');
      name.value = login.value = '';
      status.textContent = '';
      render(await api('api/people'));
    } catch (err) {
      status.textContent = err.message;
    }
  };
  api('api/people').then(render).catch(fail);
  return page(
    head('People', 'Everyone who can sign in to Citadel. Each person sees only the schemes they own or were added to, and can make schemes of their own.'),
    form, link, list,
    h('p', { class: 'muted small' },
      'Each person\'s messages start turns on their own Claude plan, which they link in Settings → Your account. Until they do, they can still read, write and add minions; their messages wait in the chat. ',
      'Turns: whether your messages run on this server\'s own Claude login, which is your subscription.'));
}

/** Main panel: your own name, login and password. */
export function accountPage() {
  const current = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const next = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 10, maxlength: 200 });
  const again = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 10, maxlength: 200 });
  const status = h('span', { class: 'muted', role: 'status' });
  const form = h('form', { class: 'account-form' },
    h('input', { name: 'login', autocomplete: 'username', value: account?.login ?? '', hidden: true }),
    h('label', {}, 'Current password', current), h('label', {}, 'New password', next), h('label', {}, 'New password again', again),
    h('div', { class: 'row' }, h('button', { type: 'submit' }, 'Change password'), status));
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
    head('Your account', [`Signed in as ${account?.name} (login ${account?.login ?? '—'})`, account?.admin ? ', an admin.' : '.',
      account?.turns ? '' : ' Your messages don\'t start turns yet: they wait in the chat until you link your Claude below.']),
    form, claudeCard(), codexCard(), githubCard());
}

/** A plan's week as of its last turn: "41%, resets Mon 9:00 AM", or null before its first turn. */
const weekText = (w) => w ? `${Math.round(Math.min(1, Math.max(0, w.utilization)) * 100)}%${w.resetsAt ? `, resets ${new Date(w.resetsAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}` : null;

/** Your own Claude plan (#213): turns you start run on it, in a container of your own on the server. */
function claudeCard() {
  const card = h('div', { class: 'account-card' }, h('p', { class: 'muted' }, 'Loading Claude…'));
  let poll = null;
  const render = (st) => {
    clearTimeout(poll);
    if (!card.isConnected && poll) return;
    const title = (chip, cls = '') => h('h3', {}, 'Claude', h('span', { class: `link-chip ${cls}` }, chip));
    const errLine = st.error ? h('p', { class: 'error', role: 'status' }, st.error) : '';
    const week = weekText(st.usage?.weekly);
    const act = (label, method, path, body, cls = '') => h('button', {
      type: 'button', class: `small ${cls}`,
      onclick: async (e) => {
        e.target.disabled = true;
        render(await api(path, { method, body }).catch((err) => ({ ...st, error: err.message })));
      },
    }, label);
    const link = (label) => act(label, 'POST', 'api/me/claude');
    const unlink = h('button', {
      type: 'button', class: 'secondary small',
      onclick: async () => {
        if (!confirm('Unlink your Claude? Citadel signs you out and deletes your container and its files; your messages wait in the chat until you link again.')) return;
        render(await api('api/me/claude', { method: 'DELETE' }).catch((err) => ({ ...st, error: err.message })));
      },
    }, 'Unlink');
    const note = h('p', { class: 'muted small' }, 'Turns you start run on your plan and count against its limits. ',
      'You sign in with Anthropic inside your own container on the server: Citadel never sees your password or token, only the one-time code you paste here.');
    if (st.host) {
      return card.replaceChildren(title('Server login', 'ok'), h('p', {}, 'Your turns run on this server\'s own Claude login, so there\'s nothing to link.'),
        week ? h('dl', { class: 'kv' }, h('dt', {}, 'This week'), h('dd', {}, week)) : '');
    }
    if (st.state === 'starting') {
      poll = setTimeout(() => api('api/me/claude').then(render).catch(() => {}), 2000);
      return card.replaceChildren(title('Starting', 'off'), errLine,
        h('p', {}, 'Starting your container and Anthropic\'s sign-in. The first time builds Citadel\'s image, which can take a few minutes.'), override);
    }
    if (st.state === 'waiting for code') {
      const code = h('input', { placeholder: 'Paste the code here', autocomplete: 'off', spellcheck: 'false', required: true, maxlength: 2000 });
      const send = h('button', { type: 'submit' }, 'Finish signing in');
      const form = h('form', { class: 'row' }, code, send);
      form.onsubmit = async (e) => {
        e.preventDefault();
        send.disabled = true;
        send.textContent = 'Signing in…';
        render(await api('api/me/claude/code', { method: 'POST', body: { code: code.value.trim() } }).catch((err) => ({ ...st, error: err.message })));
      };
      return card.replaceChildren(title('Signing in', 'off'), errLine,
        h('p', {}, '1. ', h('a', { href: st.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open Anthropic\'s sign-in'), ' and sign in with your Claude account.'),
        h('p', {}, '2. Paste the code it shows you:'), form,
        h('div', { class: 'row' }, act('Cancel', 'DELETE', 'api/me/claude', undefined, 'secondary')), note);
    }
    if (st.state === 'expired') {
      return card.replaceChildren(title('Needs linking again', 'warn'), errLine,
        h('p', {}, `Anthropic stopped accepting your sign-in${st.email ? ` as ${st.email}` : ''} (signed out or expired). Your messages wait in the chat until you link again.`),
        h('div', { class: 'row' }, link('Link Claude again'), unlink), note);
    }
    if (st.state === 'linked') {
      return card.replaceChildren(title('Linked', 'ok'), errLine,
        h('dl', { class: 'kv' },
          h('dt', {}, 'Signed in as'), h('dd', {}, st.email || '—'),
          h('dt', {}, 'Plan'), h('dd', {}, st.plan || '—'),
          week && [h('dt', {}, 'This week'), h('dd', {}, week)]),
        h('div', { class: 'row' }, unlink), note);
    }
    return card.replaceChildren(title('Not linked', 'off'), errLine,
      h('p', {}, 'Link your Claude plan so the turns your messages start run on it. Until then your messages wait in the chat.'),
      h('div', { class: 'row' }, link('Link Claude')), note);
  };
  api('api/me/claude').then(render).catch((err) => card.replaceChildren(h('p', { class: 'error' }, err.message)));
  return card;
}

/** Your own Codex (#330): a second-opinion reviewer on your ChatGPT plan, signed in inside your Claude container. */
function codexCard() {
  const card = h('div', { class: 'account-card' }, h('p', { class: 'muted' }, 'Loading Codex…'));
  let poll = null;
  const render = (st) => {
    clearTimeout(poll);
    if (!card.isConnected && poll) return;
    const title = (chip, cls = '') => h('h3', {}, 'Codex', h('span', { class: `link-chip ${cls}` }, chip));
    const errLine = st.error ? h('p', { class: 'error', role: 'status' }, st.error) : '';
    const act = (label, method, cls = '', ask = '') => h('button', {
      type: 'button', class: `small ${cls}`,
      onclick: async (e) => {
        if (ask && !confirm(ask)) return;
        e.target.disabled = true;
        render(await api('api/me/codex', { method }).catch((err) => ({ ...st, error: err.message })));
      },
    }, label);
    const note = h('p', { class: 'muted small' }, 'Self-review asks Codex for a second opinion on your ChatGPT plan, counting against its limits. ',
      'You sign in with OpenAI inside your own container on the server: Citadel never sees your password or token.');
    const again = () => (poll = setTimeout(() => api('api/me/codex').then(render).catch(() => {}), 2000));
    if (st.override !== undefined) setCodex(st.override);
    // Josh, 2026-11-05: the override lives here, beside the sign-in, not in view all the time.
    const override = st.override && (st.state === 'linked' || st.override.on) ? h('div', { class: 'codex-override' }, codexToggle(),
      h('p', { class: 'muted small' }, 'Runs your minions, Taskmasters and apps on Codex instead of Claude until you turn it off: handy when your Claude usage runs out. A Claude model picked for a minion runs as the Codex model of the same tier, and each conversation carries over word for word both ways. The left panel offers it too once your Claude usage passes 90%.')) : '';
    if (st.state === 'no container') {
      return card.replaceChildren(title('Needs your Claude', 'off'), errLine,
        h('p', { class: 'muted' }, 'Codex signs in inside your own Claude container, so link your Claude above first.'), override);
    }
    if (st.state === 'starting') {
      again();
      return card.replaceChildren(title('Starting', 'off'), errLine,
        h('p', {}, 'Starting your container and OpenAI\'s sign-in. After an update this rebuilds Citadel\'s image, which can take a few minutes.'));
    }
    if (st.state === 'waiting') {
      again();
      return card.replaceChildren(title('Signing in', 'off'), errLine,
        h('p', {}, '1. ', h('a', { href: st.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open OpenAI\'s sign-in'), ' and sign in with your ChatGPT account.'),
        h('p', {}, '2. Enter this code there (it lasts 15 minutes): ', h('code', {}, st.code)),
        h('p', { class: 'muted small' }, 'This page carries on by itself once you\'re signed in. If OpenAI refuses the code, turn on device code sign-in for Codex in ChatGPT\'s security settings.'),
        h('div', { class: 'row' }, act('Cancel', 'DELETE', 'secondary')), override, note);
    }
    if (st.state === 'linked') {
      return card.replaceChildren(title('Linked', 'ok'), errLine,
        h('p', {}, 'Signed in with ChatGPT.'),
        h('div', { class: 'row' }, act('Sign out', 'DELETE', 'secondary', 'Sign out of Codex? Self-review stops asking it, and your turns can\'t run on it, until you sign in again.')), override, note);
    }
    return card.replaceChildren(title('Not linked', 'off'), errLine,
      h('p', {}, 'Sign in to Codex with your ChatGPT plan, and self-review gets a second opinion from another model family.'),
      h('div', { class: 'row' }, act('Link Codex', 'POST')), override, note);
  };
  api('api/me/codex').then(render).catch((err) => card.replaceChildren(h('p', { class: 'error' }, err.message)));
  return card;
}

/** Your GitHub link: turns you start push and open pull requests as you (src/github-link.ts). */
function githubCard() {
  const card = h('div', { class: 'account-card' }, h('p', { class: 'muted' }, 'Loading GitHub…'));
  const render = ({ configured, error, link }) => {
    const title = (chip, cls = '') => h('h3', {}, 'GitHub', h('span', { class: `link-chip ${cls}` }, chip));
    const errLine = error ? h('p', { class: 'error', role: 'status' }, error) : '';
    const linkBtn = (label) => h('a', { class: 'button small', href: `api/github/link?project=${view.projectId}` }, label);
    const unlink = h('button', {
      type: 'button', class: 'secondary small',
      onclick: async () => {
        if (!confirm('Unlink your GitHub? Citadel forgets the token and revokes it on GitHub; your turns stop pushing until you link again.')) return;
        render(await api('api/me/github', { method: 'DELETE' }).catch(fail) ?? { configured, error: null, link });
      },
    }, 'Unlink');
    const note = h('p', { class: 'muted small' }, 'The link lets Citadel act on every repo your GitHub account can reach, and lasts until you unlink it here or revoke "Citadel" on GitHub under Settings → Applications. ',
      'Links are kept encrypted with the server\'s session secret: if an admin changes that secret, everyone links again.');
    if (!configured) {
      return card.replaceChildren(title('Not set up', 'off'), errLine, h('p', { class: 'muted' }, 'An admin hasn\'t set up Citadel\'s GitHub OAuth App yet (see the README), so turns push with the server\'s own GitHub login.'));
    }
    if (!link) {
      return card.replaceChildren(title('Not linked', 'off'), errLine,
        h('p', {}, 'Link your GitHub so turns you start push branches and open pull requests as you. Until then they run and commit, but can\'t push.'),
        h('div', { class: 'row' }, linkBtn('Link GitHub')), note);
    }
    if (link.failed) {
      return card.replaceChildren(title('Needs linking again', 'warn'), errLine,
        h('p', {}, `GitHub stopped accepting Citadel's link for @${link.login} (revoked on GitHub, or the server's secret changed). Your turns can't push until you link again.`),
        h('div', { class: 'row' }, linkBtn('Link GitHub again'), unlink));
    }
    return card.replaceChildren(title('Linked', 'ok'), errLine,
      h('dl', { class: 'kv' },
        h('dt', {}, 'Pushes and PRs as'), h('dd', {}, `@${link.login}`),
        h('dt', {}, 'Commits as'), h('dd', {}, `${link.name || link.login} <${link.email}>`),
        h('dt', {}, 'Linked'), h('dd', {}, new Date(link.linked_at).toLocaleDateString(undefined, { dateStyle: 'medium' }))),
      h('div', { class: 'row' }, unlink), note);
  };
  api('api/me/github').then(render).catch((err) => card.replaceChildren(h('p', { class: 'error' }, err.message)));
  return card;
}
