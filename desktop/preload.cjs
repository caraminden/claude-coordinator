// The desktop app's page side (#1186): tells Citadel's page it runs in the app (no Download app button, no Firefox
// setup), and passes the title bar colour the page picks (index.html's theme-color metas) to the window controls.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('citadelDesktop', { app: 'electron' });

function watchTitleBar() {
  let last = null;
  const send = () => {
    const meta = [...document.querySelectorAll('meta[name=theme-color]')].find((m) => !m.media || matchMedia(m.media).matches);
    if (meta && meta.content !== last) ipcRenderer.send('citadel:title-bar', (last = meta.content));
  };
  new MutationObserver(send).observe(document.head, { subtree: true, attributes: true, attributeFilter: ['content', 'media'], childList: true });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', send);
  send();
}
addEventListener('DOMContentLoaded', watchTitleBar);
