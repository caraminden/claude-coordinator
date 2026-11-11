// A classic script, so it runs even when app.js can't (#479): if app.js or any module it imports doesn't arrive (a
// restart's gap, a dropped connection), none of them run, which left an empty page whose ↻ did nothing, since app.js
// is what wires it. The browser fires `error` on the module's script tag then: say so, and make both buttons reload.
document.querySelector('script[src="app.js"]').addEventListener('error', () => {
  const retry = () => location.reload();
  document.querySelector('.topbar .refresh-btn').addEventListener('click', retry);
  const msg = Object.assign(document.createElement('p'), { className: 'error', textContent: 'Couldn\'t open Citadel: part of the page didn\'t load. Try again in a moment.' });
  const btn = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Try again', onclick: retry });
  document.getElementById('app').replaceChildren(msg, btn);
});
