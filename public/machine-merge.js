// "These are one computer: merge" (Build 7 M2b, src/routes/machine-merge.ts): two rows one owner has for one PC. The panel
// shows the line that reinstalls the moving row's runner agent with the kept row's token; once that agent connects to the
// kept row, the other row goes. Until then both rows keep working, so closing the panel loses nothing.
import { api, h } from './base.js';
import { machineSetupRunnerAgent, machineSetupRunnerAgentLinux } from './machine-setup.js';
import { markdownElement } from './ui/markdown.js';
import { toast } from './ui/status.js';

const WAYS = {
  windows: { tag: 'powershell-admin', where: 'On that PC, open PowerShell as administrator (Run as administrator) and paste this. It replaces the runner agent there; its runners stay.', line: machineSetupRunnerAgent },
  linux: { tag: 'wsl', where: "In a root shell in the CI runners' WSL distro on that PC (wsl -d citadel-ci -u root), or sudo -i on a Linux PC, paste this. It replaces the Linux runner agent there; its runners stay.", line: machineSetupRunnerAgentLinux },
};

/** The lines that (re)install a PC's runner agents, one per os, with `token`: a merge's, or a new token's on one PC's row. */
export const runnerAgentLines = (url, token, osList) => osList.map((os) => [h('p', { class: 'small' }, WAYS[os].where), markdownElement(`\`\`\`${WAYS[os].tag}\n${WAYS[os].line(url, token)}\n\`\`\``)]);

/** Open the merge of `m` and `other` in `el`; `done` runs when it closes. Returns its close. */
export function openMergePanel(el, m, other, { onDone = () => {}, machines = () => [] } = {}) {
  const st = { got: null, failed: '', closed: false, cancelling: false };
  const close = ({ quiet = false } = {}) => {
    st.closed = true;
    if (quiet) return;
    el.replaceChildren();
    onDone();
  };
  const start = () => {
    st.failed = '';
    draw();
    api(`api/machines/${m.id}/merge`, { method: 'POST', body: { with: other.id } })
      .then((r) => {
        if (st.closed) return;
        st.got = r;
        draw();
      })
      .catch((err) => {
        if (st.closed) return;
        st.failed = err.message;
        draw();
      });
  };
  const cancel = () => {
    // Shown at once; a refusal says so and leaves the panel to try again.
    const got = st.got;
    close();
    api(`api/machines/${got.from.id}/merge`, { method: 'DELETE' }).catch((err) => toast(`Couldn't stop the merge: ${err.message}`, { tone: 'error', action: { label: 'Retry', run: cancel } }));
  };
  const draw = () => {
    const g = st.got;
    // The moving row has gone from the list once its runner agents connected to the kept row.
    const merged = g && !machines().some((x) => x.id === g.from.id);
    const notice = (tone, ...kids) => h('div', { class: 'cui-notice machine-connect-status', 'data-tone': tone, role: 'status' }, ...kids);
    el.replaceChildren(
      h(
        'div',
        { class: 'machine-setup machine-connect', role: 'region', 'aria-label': `Merge ${m.name} and ${other.name}` },
        h('div', { class: 'row machine-merge-head' }, h('strong', {}, `${m.name} and ${other.name} are one computer`), h('button', { type: 'button', class: merged ? 'small' : 'secondary small', onclick: () => close() }, merged ? 'Done' : 'Close')),
        st.failed
          ? notice('danger', h('span', {}, `Couldn't merge them: ${st.failed} `), h('button', { type: 'button', class: 'secondary small', onclick: start }, 'Try again'))
          : !g
            ? h('pre', { class: 'muted' }, 'Getting the line…')
            : merged
              ? notice('ok', h('strong', {}, `Merged: ${g.into.name}`), ` is this PC's one row now; ${g.from.name} and its token are gone.`)
              : [
                  h('p', { class: 'small' }, `${g.into.name} stays. ${g.from.name}'s runner agent moves onto it with ${g.into.name}'s token, and ${g.from.name} goes once it connects there. Until then both keep working.`),
                  runnerAgentLines(g.agent_url, g.token, g.os),
                  notice('info', h('strong', {}, `Waiting for the runner agent to connect to ${g.into.name}…`)),
                  h('div', { class: 'row' }, h('button', { type: 'button', class: 'secondary small', onclick: cancel }, 'Stop merging')),
                ],
      ),
    );
  };
  start();
  return { close, redraw: () => !st.closed && draw() };
}
