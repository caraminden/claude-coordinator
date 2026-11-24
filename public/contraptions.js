// Settings → Contraptions, admins only: register personal apps, edit them, choose who each is
// enabled for, and rotate their keys (src/routes/contraptions.ts).
import { account, api, h, icon, view } from './base.js';
import { settingsHelp, settingsRow, settingsTabs, settingsTitle } from './settings.js';
import { toneChip } from './look.js';
import { showRail } from './rail.js';
import { optimistic } from './ui/optimistic.js';

const fail = (err) => alert(err.message);
const when = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

/** What Restart and Stop risk (#1682): its words, chip tone and the sentence a confirm opens with. */
const RISKS = {
  unassessed: ['Not assessed', 'neutral'],
  safe: ['Safe', 'ok'],
  interrupts: ['Interrupts users', 'warn'],
  loses_data: ['May lose data', 'danger'],
};
const riskWords = (c) => `${RISKS[c.restart_risk]?.[0] ?? 'Not assessed'}${c.restart_note ? `: ${c.restart_note}` : ''}`;

/** A unit's state in a few words. */
const unitState = (u) => (u.load === 'not-found' ? 'not installed' : `${u.active}${u.enabled ? `, ${u.enabled}` : ''}`);

/**
 * Its systemd user service, which Citadel writes and runs (#266): state, the buttons, and the journal on ask.
 * Fetched once the card is drawn; a boot check or preview answers 409 and the panel says why.
 */
export function servicePanel(c, summary = () => {}) {
  const line = h('span', { class: 'small' }, 'Service: checking…');
  const notes = h('div', { class: 'small muted' });
  const log = h('pre', { hidden: true });
  const status = h('span', { class: 'muted small', role: 'status' });
  const buttons = h('span', { class: 'row service-buttons' });
  const [riskText, riskTone] = RISKS[c.restart_risk] ?? RISKS.unassessed;
  const run = c.runs?.[0];
  const lastRun = h('div', { class: 'small muted' }, run ? `Last ${run.action}: ${when(run.at)} by ${run.by} · risk ${(RISKS[run.risk] ?? RISKS.unassessed)[0].toLowerCase()} · ${run.ok ? 'worked' : 'failed'}` : '');
  const base = `api/contraptions/${c.name}/service`;
  const show = (s) => {
    summary(s.installed ? s.service.active : 'not installed');
    line.textContent = `Service ${s.unit}: ${s.installed ? unitState(s.service) : 'not installed'}` + (s.timers.length ? ` · timers ${s.timers.map((t) => `${t.unit.replace(/^citadel-app-/, '')} ${unitState(t)}`).join(', ')}` : '');
    notes.replaceChildren(...(s.manifestError ? [h('div', {}, s.manifestError)] : []), ...s.hand.map((u) => h('div', {}, `Hand-installed ${u.path}: ${unitState(u)} (${u.why}).`)));
    const live = s.hand.some((u) => u.active === 'active' || u.active === 'activating' || /^enabled/.test(u.enabled));
    const btn = (label, action, extra = {}, ask) => {
      const b = h('button', { type: 'button', class: 'secondary small', title: action === 'stop' || action === 'restart' ? `Risk: ${riskWords(c)}` : undefined }, label);
      b.onclick = async () => {
        if (action === 'stop' || action === 'restart') {
          // The risk and its note sit in every confirm; "may lose data" needs the name typed, and the server checks it again.
          const risk = `Risk: ${riskWords(c)}.`;
          if (c.restart_risk === 'loses_data') {
            if (prompt(`${ask ?? `${label} ${c.title}?`}\n\n${risk}\n\nType ${c.name} to go on.`) !== c.name) return;
            extra = { ...extra, confirm: c.name };
          } else if (!confirm(`${ask ?? `${label} ${c.title}?`}\n\n${risk}`)) return;
        } else if (ask && !confirm(ask)) return;
        // The click shows at once ("Restarting…", buttons held); a failure rolls that back with a toast and a Retry.
        const before = status.textContent;
        const hold = (on) => {
          for (const x of buttons.querySelectorAll('button')) x.disabled = on;
        };
        optimistic({
          key: `contraption-service:${c.name}`,
          apply: () => {
            status.textContent = `${label}…`;
            hold(true);
          },
          send: () => api(base, { method: 'POST', body: { action, ...extra } }),
          undo: () => {
            status.textContent = before;
            hold(false);
          },
          label: `${label.toLowerCase()} ${c.title}`,
        }).then(
          (r) => {
            if (action === 'stop' || action === 'restart') lastRun.textContent = `Last ${action}: just now · risk ${(RISKS[c.restart_risk] ?? RISKS.unassessed)[0].toLowerCase()} · ${r.said.at(-1)}`;
            status.textContent = r.said.join(' ');
            show(r.status);
          },
          () => {},
        );
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
      live ? btn('Install, replacing hand-installed', 'install', { replace: true }, `Stop and disable ${s.hand.map((u) => u.unit).join(', ')} and install ${s.unit} instead? Their files stay.`) : btn(s.installed ? 'Reinstall' : 'Install', 'install'),
      ...(s.installed ? [btn('Start', 'start'), btn('Restart', 'restart'), btn('Stop', 'stop', {}, `Stop ${c.title}? It stays down until started again (or the box restarts).`)] : []),
      logs,
    );
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
    if (d.state === 'running')
      setTimeout(
        () =>
          deployLine.isConnected &&
          api(`api/contraptions/${c.name}/deploy`)
            .then(showDeploy)
            .catch(() => {}),
        3000,
      );
    else
      api(base)
        .then(show)
        .catch(() => {});
  };
  deployBtn.onclick = async () => {
    if (!confirm(`Deploy ${c.title} from ${c.repo} ${c.branch || 'main'}? It builds and restarts it, and rolls back if that fails.`)) return;
    const before = deployLine.textContent;
    optimistic({
      key: `contraption-deploy:${c.name}`,
      apply: () => {
        deployBtn.disabled = true;
        deployLine.textContent = 'Deploying…';
      },
      send: () => api(`api/contraptions/${c.name}/deploy`, { method: 'POST' }),
      undo: () => {
        deployBtn.disabled = false;
        deployLine.textContent = before;
      },
      label: `deploy ${c.title}`,
    }).then(showDeploy, () => {});
  };
  api(base)
    .then(show)
    .catch((err) => {
      line.textContent = `Service: ${err.message}`;
      summary('service unknown');
    });
  if (c.repo)
    api(`api/contraptions/${c.name}/deploy`)
      .then(showDeploy)
      .catch(() => {});
  return h(
    'div',
    { class: 'contraption-service' },
    h('div', { class: 'row' }, line, h('span', { class: 'spacer' }), toneChip(riskTone, `Restart: ${riskText}`), buttons, deployBtn),
    h('div', { class: 'small muted', hidden: !c.restart_note }, c.restart_note),
    lastRun,
    notes,
    status,
    log,
    deployLine,
    deployTodo,
    deployLog,
  );
}

const size = (b) => (b < 1e9 ? `${Math.round(b / 1e6)} MB` : `${(b / 1e9).toFixed(b < 1e11 ? 1 : 0)} GB`);

/** Its DATA_DIR size from the server's last background measure (#847), and its manifest's disk_warn_gb line. */
function diskLine(c) {
  const d = c.disk;
  const dir = `~/.local/share/${c.name}`;
  if (!d) return h('p', { class: 'small muted' }, `Data in ${dir}: not measured yet (every 30 min, from 2 min after a restart).`);
  const over = d.warn_gb !== null && d.data_bytes !== null && d.data_bytes > d.warn_gb * 1e9;
  return h(
    'p',
    { class: 'small muted' },
    d.data_bytes === null ? `No data in ${dir} yet` : `Data: ${size(d.data_bytes)} in ${dir}`,
    `, measured ${when(d.measured_at)}`,
    d.warn_gb !== null && !over ? `; warns past ${d.warn_gb} GB.` : '.',
    over ? h('strong', { class: 'warn' }, ` Past its ${d.warn_gb} GB warning line.`) : '',
  );
}

// Split so src/icons.ts doesn't take it for Citadel's own icon and append ?v=<hash>.
const ICON_HINT = '/icon' + '.svg';

const riskSelect = (c) => h('select', { name: 'restart_risk' }, ...Object.entries(RISKS).map(([v, [label]]) => h('option', { value: v, selected: v === (c.restart_risk ?? 'unassessed') }, label)));

/** One contraption as a row that opens (#997): who it's enabled for, its settings, its service and its keys. */
function card(c, people, replace) {
  const field = (label, name, value, attrs = {}) => h('label', { class: attrs.wide ? 'wide' : '' }, label, h('input', { name, value: value ?? '', autocomplete: 'off', spellcheck: 'false', ...attrs, wide: undefined }));
  const scheme = h('select', { name: 'home_scheme' }, h('option', { value: '' }, 'None'), ...(view.projects ?? []).map((p) => h('option', { value: p.id, selected: p.id === c.home_scheme }, p.name)));
  const status = h('span', { class: 'muted small', role: 'status' });
  const form = h(
    'form',
    { class: 'machine-add' },
    field('Title', 'title', c.title, { required: true, maxlength: 60 }),
    field('Port', 'port', c.port, { type: 'number', min: 1024, max: 65535, required: true }),
    field('Icon', 'icon', c.icon, { placeholder: ICON_HINT, title: 'Every contraption has one. Empty: the rail shows its first letter until a deploy fills it from its web manifest.' }),
    h('label', {}, 'Home scheme', scheme),
    field('Default model', 'default_model', c.default_model, { placeholder: 'haiku' }),
    field('Turns per person per day', 'turn_cap', c.turn_cap, { type: 'number', min: 1, placeholder: 'no cap' }),
    field('Open paths (no login)', 'open_paths', c.open_paths.join(', '), { placeholder: '/link', wide: true }),
    field('Relay paths (apps may call)', 'relay_paths', c.relay_paths.join(', '), { placeholder: '/app-api/', wide: true, title: 'Path prefixes other contraptions may call for a person. Their code must check the from claim.' }),
    h('label', {}, 'Restart and Stop risk', riskSelect(c)),
    field('Risk note', 'restart_note', c.restart_note, { maxlength: 300, placeholder: 'Shown in the confirm', wide: true }),
    field('Repo (deploys from)', 'repo', c.repo, { placeholder: 'owner/name' }),
    field('Branch', 'branch', c.branch, { placeholder: 'main' }),
    field('Folder', 'folder', c.folder, { placeholder: `~/apps/${c.name}`, wide: true }),
    h('button', { type: 'submit' }, 'Save'),
    status,
  );
  // Saved at once (the form keeps what was typed); the server's copy redraws the card, and a refusal says it isn't.
  form.onsubmit = (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(form));
    // Untouched, the risk fields stay out of the save: a Taskmaster's newer value isn't put back to the page's old one.
    if (v.restart_risk === (c.restart_risk ?? 'unassessed')) delete v.restart_risk;
    if (v.restart_note === (c.restart_note ?? '')) delete v.restart_note;
    optimistic({
      key: `contraption:${c.name}`,
      apply: () => {
        status.textContent = 'Saved.';
      },
      send: () =>
        api(`api/contraptions/${c.name}`, {
          method: 'PATCH',
          body: {
            ...v,
            port: Number(v.port),
            home_scheme: v.home_scheme ? Number(v.home_scheme) : null,
            open_paths: v.open_paths.split(/[\s,]+/).filter(Boolean),
            relay_paths: v.relay_paths.split(/[\s,]+/).filter(Boolean),
          },
        }),
      undo: () => {
        status.textContent = 'Not saved.';
      },
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
  const base = `${c.name} · port ${c.port}`;
  const [row, sum] = settingsRow(
    { icon: 'box', hue: 'teal', title: c.title, summary: base, open: c.wasOpen },
    h('div', { class: 'row' }, h('span', { class: 'small muted' }, `Key files in ${c.keys_dir} (identity.pub, contraption.key), made ${when(c.keys_at)}.`), h('span', { class: 'spacer' }), rotate),
    h(
      'div',
      { class: 'contraption-people', role: 'group', 'aria-label': `Who ${c.title} is enabled for` },
      h('span', { class: 'small' }, 'Enabled for'),
      ...people
        .filter((u) => !u.disabled)
        .map((u) =>
          h(
            'label',
            { class: 'small turns-toggle' },
            h('input', {
              type: 'checkbox',
              checked: enabled.has(u.id),
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
                }).then(
                  () => {
                    if (u.id === account?.id) showRail(); // enabling yourself: the rail appears now
                  },
                  () => {},
                );
              },
            }),
            u.name,
          ),
        ),
    ),
    diskLine(c),
    servicePanel(c, (state) => {
      sum.textContent = `${base} · ${state}`;
      row.dataset.hue = state === 'active' ? 'running' : 'muted';
    }),
    h('details', { class: 'contraption-settings', open: c.wasSettingsOpen }, h('summary', { class: 'small' }, 'Settings'), form),
  );
  row.classList.add('contraption');
  return row;
}

/** Main panel, admins only: every contraption, with a form to register another. */
export function contraptionsPage() {
  const list = h('div', { class: 'contraption-list settings-rows' });
  let people = [];
  let all = [];
  // A save or a key rotation redraws only its own card (keeping its Settings open), so typing in the others survives.
  const cardFor = (c) => {
    const el = card(c, people, (next) => {
      all = all.map((x) => (x.name === next.name ? next : x));
      if (!el.isConnected) return render();
      // Both the row and its inner Settings stay as they were.
      const fresh = cardFor({ ...next, wasOpen: el.open, wasSettingsOpen: el.querySelector('.contraption-settings').open });
      el.replaceWith(fresh);
    });
    return el;
  };
  const render = () => list.replaceChildren(...(all.length ? all.map(cardFor) : [h('p', { class: 'muted settings-empty' }, 'No contraptions yet.')]));
  const name = h('input', { name: 'name', placeholder: 'mandate', required: true, maxlength: 32, pattern: '[a-z0-9]([a-z0-9\\-]*[a-z0-9])?', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' });
  const title = h('input', { name: 'title', placeholder: 'Mandate', required: true, maxlength: 60, autocomplete: 'off' });
  const port = h('input', { name: 'port', type: 'number', min: 1024, max: 65535, placeholder: '9101', required: true });
  const iconIn = h('input', { name: 'icon', placeholder: ICON_HINT, autocomplete: 'off', spellcheck: 'false', title: 'A path on its service, from its base. Empty: the rail shows its first letter until a deploy fills it from its web manifest.' });
  const status = h('span', { class: 'muted', role: 'status' });
  const form = h('form', { class: 'machine-add' }, h('label', {}, 'Name', name), h('label', {}, 'Title', title), h('label', {}, 'Port', port), h('label', {}, 'Icon', iconIn), h('button', { type: 'submit' }, 'Register'), status);
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
  Promise.all([api('api/contraptions'), api('api/people')])
    .then(([cs, ps]) => {
      all = cs;
      people = ps;
      render();
    })
    .catch(fail);
  return h(
    'section',
    { class: 'artifacts-main people-main' },
    h(
      'div',
      { class: 'ticket-head' },
      h('div', { class: 'row' }, ...settingsTitle(), h('span', { class: 'spacer' }), h('a', { class: 'close-view', href: `#/p/${view.projectId}`, title: 'Back to the Taskmaster', 'aria-label': 'Close' }, icon('close'))),
      settingsTabs(),
      h('div', { class: 'meta' }, 'Personal apps with their own service, reached through Citadel. Each opens only for the people it is enabled for here.'),
    ),
    h(
      'div',
      { class: 'settings-rows register-row' },
      settingsRow(
        { icon: 'plugplus', hue: 'accent', title: 'Register a contraption', summary: 'Name, title, port and icon' },
        settingsHelp('Registering writes the key files its own service reads: identity.pub checks who a request is from, and contraption.key lets it run turns.', 'Citadel keeps only the private key, sealed, and a hash of contraption.key. Being in the scheme that builds an app grants nothing.'),
        form,
      )[0],
    ),
    h('h3', { class: 'settings-section' }, 'Registered'),
    list,
  );
}
