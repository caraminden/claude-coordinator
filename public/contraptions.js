// Settings → Contraptions, admins only: register personal apps, edit them, choose who each is
// enabled for, and rotate their keys (src/routes/contraptions.ts).
import { account, api, h, icon, view } from './core.js';
import { settingsTabs } from './settings.js';
import { showRail } from './rail.js';

const fail = (err) => alert(err.message);
const when = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

/** A unit's state in a few words. */
const unitState = (u) => (u.load === 'not-found' ? 'not installed' : `${u.active}${u.enabled ? `, ${u.enabled}` : ''}`);

/**
 * Its systemd user service, which Citadel writes and runs (#266): state, the buttons, and the journal on ask.
 * Fetched once the card is drawn; a boot check or preview answers 409 and the panel says why.
 */
function servicePanel(c) {
  const line = h('span', { class: 'small' }, 'Service: checking…');
  const notes = h('div', { class: 'small muted' });
  const log = h('pre', { hidden: true });
  const status = h('span', { class: 'muted small', role: 'status' });
  const buttons = h('span', { class: 'row service-buttons' });
  const base = `api/contraptions/${c.name}/service`;
  const show = (s) => {
    line.textContent = `Service ${s.unit}: ${s.installed ? unitState(s.service) : 'not installed'}`
      + (s.timers.length ? ` · timers ${s.timers.map((t) => `${t.unit.replace(/^citadel-app-/, '')} ${unitState(t)}`).join(', ')}` : '');
    notes.replaceChildren(
      ...(s.manifestError ? [h('div', {}, s.manifestError)] : []),
      ...s.hand.map((u) => h('div', {}, `Hand-installed ${u.path}: ${unitState(u)} (${u.why}).`)));
    const live = s.hand.some((u) => u.active === 'active' || u.active === 'activating' || /^enabled/.test(u.enabled));
    const btn = (label, action, extra = {}, ask) => {
      const b = h('button', { type: 'button', class: 'secondary small' }, label);
      b.onclick = async () => {
        if (ask && !confirm(ask)) return;
        status.textContent = `${label}…`;
        for (const x of buttons.querySelectorAll('button')) x.disabled = true;
        try {
          const r = await api(base, { method: 'POST', body: { action, ...extra } });
          status.textContent = r.said.join(' ');
          show(r.status);
        } catch (err) {
          status.textContent = err.message;
          for (const x of buttons.querySelectorAll('button')) x.disabled = false;
        }
      };
      return b;
    };
    const logs = h('button', { type: 'button', class: 'secondary small' }, 'Logs');
    logs.onclick = async () => {
      if (!log.hidden) return void (log.hidden = true);
      try {
        log.textContent = (await api(`${base}/logs?lines=100`)).log || 'No journal lines.';
        log.hidden = false;
      } catch (err) {
        status.textContent = err.message;
      }
    };
    buttons.replaceChildren(
      live
        ? btn('Install, replacing hand-installed', 'install', { replace: true }, `Stop and disable ${s.hand.map((u) => u.unit).join(', ')} and install ${s.unit} instead? Their files stay.`)
        : btn(s.installed ? 'Reinstall' : 'Install', 'install'),
      ...(s.installed ? [btn('Start', 'start'), btn('Restart', 'restart'), btn('Stop', 'stop', {}, `Stop ${c.title}? It stays down until started again (or the box restarts).`)] : []),
      logs);
  };
  // Its last deploy, followed while it runs.
  const deployLine = h('div', { class: 'small' });
  const deployLog = h('pre', { hidden: true });
  const deployBtn = h('button', { type: 'button', class: 'secondary small', hidden: !c.repo, title: c.repo ? `Fetch ${c.repo} ${c.branch}, build, restart; rolls back if it fails` : '' }, 'Deploy');
  const showDeploy = (d) => {
    deployBtn.disabled = d?.state === 'running';
    if (!d) return;
    deployLine.textContent = `Deploy by ${d.by}: ${d.state}${d.to ? ` at ${d.to.slice(0, 9)}` : ''} · ${d.said.at(-1) ?? ''}`;
    deployLog.textContent = d.tail ?? '';
    deployLog.hidden = d.state === 'running' || d.state === 'deployed' || !d.tail;
    if (d.state === 'running') setTimeout(() => deployLine.isConnected && api(`api/contraptions/${c.name}/deploy`).then(showDeploy).catch(() => {}), 3000);
    else api(base).then(show).catch(() => {});
  };
  deployBtn.onclick = async () => {
    if (!confirm(`Deploy ${c.title} from ${c.repo} ${c.branch}? It builds and restarts it, and rolls back if that fails.`)) return;
    try {
      showDeploy(await api(`api/contraptions/${c.name}/deploy`, { method: 'POST' }));
    } catch (err) {
      deployLine.textContent = err.message;
    }
  };
  api(base).then(show).catch((err) => {
    line.textContent = `Service: ${err.message}`;
  });
  if (c.repo) api(`api/contraptions/${c.name}/deploy`).then(showDeploy).catch(() => {});
  return h('div', { class: 'contraption-service' }, h('div', { class: 'row' }, line, h('span', { class: 'spacer' }), buttons, deployBtn), notes, status, log, deployLine, deployLog);
}

/** One contraption: who it's enabled for, its settings, its service and its keys. */
function card(c, people, replace) {
  const field = (label, name, value, attrs = {}) => h('label', { class: attrs.wide ? 'wide' : '' }, label,
    h('input', { name, value: value ?? '', autocomplete: 'off', spellcheck: 'false', ...attrs, wide: undefined }));
  const scheme = h('select', { name: 'home_scheme' }, h('option', { value: '' }, 'None'),
    ...(view.projects ?? []).map((p) => h('option', { value: p.id, selected: p.id === c.home_scheme }, p.name)));
  const status = h('span', { class: 'muted small', role: 'status' });
  const form = h('form', { class: 'machine-add' },
    field('Title', 'title', c.title, { required: true, maxlength: 60 }),
    field('Port', 'port', c.port, { type: 'number', min: 1024, max: 65535, required: true }),
    field('Icon', 'icon', c.icon, { placeholder: '/icon.svg' }),
    h('label', {}, 'Home scheme', scheme),
    field('Default model', 'default_model', c.default_model, { placeholder: 'haiku' }),
    field('Turns per person per day', 'turn_cap', c.turn_cap, { type: 'number', min: 1, placeholder: 'no cap' }),
    field('Open paths (no login)', 'open_paths', c.open_paths.join(', '), { placeholder: '/link', wide: true }),
    field('Relay paths (apps may call)', 'relay_paths', c.relay_paths.join(', '), { placeholder: '/app-api/', wide: true, title: 'Path prefixes other contraptions may call for a person. Their code must check the from claim.' }),
    field('Repo (deploys from)', 'repo', c.repo, { placeholder: 'owner/name' }),
    field('Branch', 'branch', c.branch, { placeholder: 'main' }),
    field('Folder', 'folder', c.folder, { placeholder: `~/apps/${c.name}`, wide: true }),
    h('button', { type: 'submit' }, 'Save'), status);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(form));
    status.textContent = 'Saving…';
    try {
      replace(await api(`api/contraptions/${c.name}`, { method: 'PATCH', body: {
        ...v, port: Number(v.port), home_scheme: v.home_scheme ? Number(v.home_scheme) : null,
        open_paths: v.open_paths.split(/[\s,]+/).filter(Boolean),
        relay_paths: v.relay_paths.split(/[\s,]+/).filter(Boolean),
      } }));
    } catch (err) {
      status.textContent = err.message;
    }
  };
  const enabled = new Set(c.people);
  const rotate = h('button', { type: 'button', class: 'secondary small' }, 'Rotate keys');
  rotate.onclick = async () => {
    if (!confirm(`Rotate ${c.title}'s keys? Both key files are rewritten, and its service must restart to read them: until then Citadel refuses its old keys.`)) return;
    const r = await api(`api/contraptions/${c.name}/keys`, { method: 'POST' }).catch(fail);
    if (r) replace(r);
  };
  return h('div', { class: 'machine-setup contraption' },
    h('div', { class: 'row' }, h('strong', {}, c.title), h('span', { class: 'muted' }, ` ${c.name} · port ${c.port}`), h('span', { class: 'spacer' }), rotate),
    h('p', { class: 'small muted' }, `Key files in ${c.keys_dir} (identity.pub, contraption.key), made ${when(c.keys_at)}.`),
    h('div', { class: 'contraption-people', role: 'group', 'aria-label': `Who ${c.title} is enabled for` },
      h('span', { class: 'small' }, 'Enabled for'),
      ...people.filter((u) => !u.disabled).map((u) => h('label', { class: 'small turns-toggle' },
        h('input', {
          type: 'checkbox', checked: enabled.has(u.id),
          onchange: async (e) => {
            const r = await api(`api/contraptions/${c.name}/people/${u.id}`, { method: 'PUT', body: { enabled: e.target.checked } }).catch(fail);
            if (r) replace(r);
            else e.target.checked = !e.target.checked;
            if (r && u.id === account?.id) showRail(); // enabling yourself: the rail appears now
          },
        }), u.name))),
    servicePanel(c),
    h('details', {}, h('summary', { class: 'small' }, 'Settings'), form));
}

/** Main panel, admins only: every contraption, with a form to register another. */
export function contraptionsPage() {
  const list = h('div', { class: 'contraption-list' });
  let people = [];
  let all = [];
  const render = () => list.replaceChildren(...(all.length ? all.map((c) => card(c, people, (next) => {
    all = all.map((x) => (x.name === next.name ? next : x));
    render();
  })) : [h('p', { class: 'muted' }, 'No contraptions yet.')]));
  const name = h('input', { name: 'name', placeholder: 'mandate', required: true, maxlength: 32, pattern: '[a-z0-9]([a-z0-9-]*[a-z0-9])?', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' });
  const title = h('input', { name: 'title', placeholder: 'Mandate', required: true, maxlength: 60, autocomplete: 'off' });
  const port = h('input', { name: 'port', type: 'number', min: 1024, max: 65535, placeholder: '9101', required: true });
  const status = h('span', { class: 'muted', role: 'status' });
  const form = h('form', { class: 'machine-add' },
    h('label', {}, 'Name', name), h('label', {}, 'Title', title), h('label', {}, 'Port', port),
    h('button', { type: 'submit' }, 'Register'), status);
  form.onsubmit = async (e) => {
    e.preventDefault();
    status.textContent = 'Registering…';
    try {
      all = [...all, await api('api/contraptions', { method: 'POST', body: { name: name.value.trim(), title: title.value.trim(), port: Number(port.value) } })];
      form.reset();
      status.textContent = '';
      render();
    } catch (err) {
      status.textContent = err.message;
    }
  };
  Promise.all([api('api/contraptions'), api('api/people')]).then(([cs, ps]) => {
    all = cs;
    people = ps;
    render();
  }).catch(fail);
  return h('section', { class: 'artifacts-main people-main' },
    h('div', { class: 'ticket-head' },
      h('div', { class: 'row' }, h('h2', {}, 'Settings'), h('span', { class: 'spacer' }),
        h('a', { class: 'close-view', href: `#/p/${view.projectId}`, title: 'Back to the Taskmaster', 'aria-label': 'Close' }, icon('close'))),
      settingsTabs(),
      h('div', { class: 'meta' }, 'Contraptions are personal apps with their own service, reached through Citadel. Each opens only for the people it is enabled for here; being in the scheme that builds it grants nothing.')),
    form, list,
    h('p', { class: 'muted small' }, 'Registering writes the contraption\'s key files for its own service to read: identity.pub checks who a request is from, and contraption.key lets it run turns. Citadel keeps only the private key, sealed, and a hash of contraption.key.'));
}
