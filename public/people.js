// Settings tabs for who is in Citadel: a scheme's members, everyone (admins only), and your own account.
import { account, api, h, icon, view } from './core.js';
import { settingsTabs } from './settings.js';

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
      h('span', { class: 'text' }, h('span', { class: 'name' }, m.name), h('span', { class: 'meta' }, m.owner ? `${m.login} · owner` : m.login)),
      owns && !m.owner && h('button', {
        type: 'button', class: 'secondary small',
        onclick: async () => {
          if (!confirm(`Take ${m.name} out of ${p.name}? They stop seeing it at once.`)) return;
          render(await api(`api/projects/${p.id}/members/${m.id}`, { method: 'DELETE' }).catch(fail) ?? members, people);
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
    account?.admin && h('p', { class: 'muted small' }, 'To add someone new to Citadel, invite them under People first.'));
}

/** The link an invite or reset token makes, with a Copy button: shown once, since only its hash is kept. */
function linkBox(who, token, what) {
  const url = `${location.origin}${location.pathname}#/invite/${token}`;
  const copy = h('button', { type: 'button', class: 'secondary small' }, 'Copy');
  copy.onclick = async () => {
    await navigator.clipboard.writeText(url);
    copy.textContent = 'Copied';
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
    const state = u.disabled ? 'disabled' : !u.has_password ? (u.invite_open ? 'invited' : 'invite expired') : u.invite_open ? 'reset link open' : '';
    const patch = async (body) => render(await api(`api/people/${u.id}`, { method: 'PATCH', body }).then(() => api('api/people')).catch(fail) ?? people);
    const turns = h('input', { type: 'checkbox', checked: u.server_login, onchange: (e) => patch({ server_login: e.target.checked }) });
    const self = u.id === account?.id;
    return h('div', { class: 'person-row' },
      h('span', { class: 'text' },
        h('span', { class: 'name' }, u.name, u.admin ? ' · admin' : ''),
        h('span', { class: 'meta' }, [u.login, state].filter(Boolean).join(' · '))),
      h('label', { class: 'small turns-toggle', title: 'Their messages start and steer turns on the server\'s Claude login. Off: their messages wait in the chat.' }, turns, 'Turns'),
      h('button', {
        type: 'button', class: 'secondary small',
        onclick: async () => {
          const r = await api(`api/people/${u.id}/invite`, { method: 'POST' }).catch(fail);
          if (r) { show(u, r.token, u.has_password ? 'Password reset' : 'Invite'); render(await api('api/people')); }
        },
      }, u.has_password ? 'Reset link' : 'New invite'),
      !self && h('button', { type: 'button', class: 'secondary small', onclick: () => patch({ disabled: !u.disabled }) }, u.disabled ? 'Enable' : 'Disable'),
      !self && h('button', {
        type: 'button', class: 'secondary small',
        onclick: async () => {
          if (!confirm(`Remove ${u.name} from Citadel? Schemes they own become yours; their messages stay.`)) return;
          await api(`api/people/${u.id}`, { method: 'DELETE' }).catch(fail);
          render(await api('api/people'));
        },
      }, 'Remove'));
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
      'Turns: whether their messages start and steer turns on this server\'s Claude login. Leave it off for anyone but you: ',
      'a Claude subscription is for one person, so others wait for per-person Claude accounts. Without it they can still read, write and add minions; their messages wait in the chat.'));
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
      account?.turns ? '' : ' Your messages don\'t start turns yet: they wait in the chat until you can link your own Claude account.']),
    form);
}
