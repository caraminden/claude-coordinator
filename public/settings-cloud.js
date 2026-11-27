// The admin switches for every scheme's Claude Code cloud use on the Settings page: cloud sessions (#2193) and cloud
// helpers (#2200), both off by default.
import { api, h } from './base.js';
import { settingsHelp } from './settings.js';
import { optimistic } from './ui/optimistic.js';

/**
 * An admin switch for every scheme, off by default: cloud sessions (#2193) or cloud helpers (#2200), each a boolean in
 * api/app/settings. The switch and its words are one button, so the whole line is the tap target.
 * @param {{ field: 'cloud_sessions' | 'cloud_helpers', id: string, title: string, label: string, help: [string, string], on: string, off: string }} c
 */
function cloudSwitchField(c) {
  const state = h('span', {}, 'Loading…');
  /** @type {boolean | null} */
  let on = null;
  const flip = h('button', { type: 'button', class: 'cloud-flip', role: 'switch', 'aria-checked': 'false', 'aria-label': `${c.title} for every scheme`, disabled: true }, h('span', { class: 'rules-switch', 'aria-hidden': 'true' }), state);
  const show = (/** @type {boolean} */ v) => {
    on = v;
    flip.setAttribute('aria-checked', String(v));
    flip.disabled = false;
    state.textContent = v ? c.on : c.off;
  };
  flip.onclick = () => {
    const was = !!on;
    optimistic({
      key: c.id,
      apply: () => show(!was),
      send: () => api('api/app/settings', { method: 'PUT', body: { [c.field]: !was } }),
      undo: () => {
        if (on === !was) show(was);
      },
      label: `turn ${c.label} ${was ? 'off' : 'on'}`,
    });
  };
  api('api/app/settings').then(
    (/** @type {{ cloud_sessions?: boolean, cloud_helpers?: boolean }} */ s) => show(!!s[c.field]),
    (err) => {
      state.textContent = `Could not load it: ${err.message}`;
    },
  );
  return h('div', { class: 'cloud-sessions settings-anchor', id: `${c.id}-section` }, h('h3', { class: 'settings-label' }, c.title), settingsHelp(...c.help), flip);
}

/** Off, a minion's turns run at perigee or a machine; a running session keeps its follow-ups. */
export const cloudSessionsField = () =>
  cloudSwitchField({
    field: 'cloud_sessions',
    id: 'cloud-sessions',
    title: 'Cloud sessions',
    label: 'cloud sessions',
    help: ["Whether a minion's first turn may start as a Claude Code cloud session, in every scheme.", 'Off, a session already running keeps its follow-ups, and a minion that runs a turn here stays here once it is back on.'],
    on: 'On: research, ideation and marked minions start as cloud sessions.',
    off: 'Off: no new cloud sessions; sessions already running keep their follow-ups.',
  });

/** citadel-cloud's switch: off, a minion's long step runs on CI or perigee, never a cloud session. */
export const cloudHelpersField = () =>
  cloudSwitchField({
    field: 'cloud_helpers',
    id: 'cloud-helpers',
    title: 'Cloud helpers',
    label: 'cloud helpers',
    help: ["Whether a minion's long step (a test run, a build, a research brief) may run in a Claude Code cloud session on its sender's login, in every scheme.", "Off, citadel-cloud runs it on a machine's CI, GitHub's free runners or here instead."],
    on: 'On: citadel-cloud may hand a step to a cloud session when no free runner or machine fits.',
    off: 'Off: no step goes to a cloud session; each runs on CI or here.',
  });
