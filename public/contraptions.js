// Settings → Contraptions, admins only: register personal apps, edit them, choose who each is
// enabled for, and rotate their keys (src/routes/contraptions.ts).
import { account, api, h, icon, view } from './base.js';
import { settingsTabs } from './settings.js';
import { showRail } from './rail.js';
import { optimistic } from './ui/optimistic.js';

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
  const deployTodo = h('ul', { class: 'small', 'aria-label': 'Still to do after its deploy' });
  const deployLog = h('pre', { hidden: true });
  const deployBtn = h('button', { type: 'button', class: 'secondary small', hidden: !c.repo, title: c.repo ? `Fetch ${c.repo} ${c.branch || 'main'}, build, restart; rolls back if it fails` : '' }, 'Deploy');
  const showDeploy = (d) => {
    deployBtn.disabled = d?.state === 'running';
    if (!d) return;
    deployLine.textContent = `Deploy by ${d.by}: ${d.state}${d.to ? ` at ${d.to.slice(0, 9)}` : ''} · ${d.said.filter((l) => !l.startsWith('To do: ')).at(-1) ?? ''}`;
    deployTodo.replaceChildren(...(d.todo ?? []).map((t) => h('li', {}, h('strong', {}, 'To do: '), t)));
    deployLog.textContent = d.tail ?? '';
    deployLog.hidden = d.state === 'running' || d.state === 'deployed' || !d.tail;
    if (d.state === 'running') setTimeout(() => deployLine.isConnected && api(`api/contraptions/${c.name}/deploy`).then(showDeploy).catch(() => {}), 3000);
    else api(base).then(show).catch(() => {});
  };
  deployBtn.onclick = async () => {
    if (!confirm(`Deploy ${c.title} from ${c.repo} ${c.branch || 'main'}? It builds and restarts it, and rolls back if that fails.`)) return;
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
  return h('div', { class: 'contraption-service' }, h('div', { class: 'row' }, line, h('span', { class: 'spacer' }), buttons, deployBtn), notes, status, log, deployLine, deployTodo, deployLog);
}

// Split so src/icons.ts doesn't take it for Citadel's own icon and append ?v=<hash>.
const ICON_HINT = '/icon' + '.svg';

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
    field('Icon', 'icon', c.icon, { placeholder: ICON_HINT, title: 'Every contraption has one. Empty: the rail shows its first letter until a deploy fills it from its web manifest.' }),
    h('label', {}, 'Home scheme', scheme),
    field('Default model', 'default_model', c.default_model, { placeholder: 'haiku' }),
    field('Turns per person per day', 'turn_cap', c.turn_cap, { type: 'number', min: 1, placeholder: 'no cap' }),
    field('Open paths (no login)', 'open_paths', c.open_paths.join(', '), { placeholder: '/link', wide: true }),
    field('Relay paths (apps may call)', 'relay_paths', c.relay_paths.join(', '), { placeholder: '/app-api/', wide: true, title: 'Path prefixes other contraptions may call for a person. Their code must check the from claim.' }),
    field('Repo (deploys from)', 'repo', c.repo, { placeholder: 'owner/name' }),
    field('Branch', 'branch', c.branch, { placeholder: 'main' }),
    field('Folder', 'folder', c.folder, { placeholder: `~/apps/${c.name}`, wide: true }),
    h('button', { type: 'submit' }, 'Save'), status);
  // Saved at once (the form keeps what was typed); the server's copy redraws the card, and a refusal says it isn't.
  form.onsubmit = (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(form));
    optimistic({
      key: `contraption:${c.name}`,
      apply: () => { status.textContent = 'Saved.'; },
      send: () => api(`api/contraptions/${c.name}`, { method: 'PATCH', body: {
        ...v, port: Number(v.port), home_scheme: v.home_scheme ? Number(v.home_scheme) : null,
        open_paths: v.open_paths.split(/[\s,]+/).filter(Boolean),
        relay_paths: v.relay_paths.split(/[\s,]+/).filter(Boolean),
      } }),
      undo: () => { status.textContent = 'Not saved.'; },
      label: `save ${c.title}'s settings`,
    }).then(replace, () => {});
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
          // The box shows it at once (and c.people, for a redraw meanwhile); a refusal unticks (or ticks) it
          // again, unless a later click changed it. No redraw after: the box already shows what the server has.
          onchange: (e) => {
            const box = e.target;
            const on = box.checked;
            const show = (yes) => {
              box.checked = yes;
              c.people = yes ? [...new Set([...c.people, u.id])] : c.people.filter((id) => id !== u.id);
            };
            optimistic({
              key: `contraption-people:${c.name}:${u.id}`,
              apply: () => show(on),
              send: () => api(`api/contraptions/${c.name}/people/${u.id}`, { method: 'PUT', body: { enabled: on } }),
              undo: () => c.people.includes(u.id) === on && show(!on),
              label: `${on ? 'enable' : 'disable'} ${c.title} for ${u.name}`,
            }).then(() => {
              if (u.id === account?.id) showRail(); // enabling yourself: the rail appears now
            }, () => {});
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
  const iconIn = h('input', { name: 'icon', placeholder: ICON_HINT, autocomplete: 'off', spellcheck: 'false', title: 'A path on its service, from its base. Empty: the rail shows its first letter until a deploy fills it from its web manifest.' });
  const status = h('span', { class: 'muted', role: 'status' });
  const form = h('form', { class: 'machine-add' },
    h('label', {}, 'Name', name), h('label', {}, 'Title', title), h('label', {}, 'Port', port), h('label', {}, 'Icon', iconIn),
    h('button', { type: 'submit' }, 'Register'), status);
  form.onsubmit = async (e) => {
    e.preventDefault();
    status.textContent = 'Registering…';
    try {
      const c = await api('api/contraptions', { method: 'POST', body: { name: name.value.trim(), title: title.value.trim(), port: Number(port.value), icon: iconIn.value.trim() || null } });
      all = [...all, c];
      form.reset();
      // Every contraption ships an icon and a web manifest (#418): say so while it has none.
      status.textContent = c.icon ? '' : `Registered without an icon: the rail shows "${c.title[0]}" until you set one or a deploy fills it from its web manifest.`;
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
