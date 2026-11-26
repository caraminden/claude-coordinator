// Your account's "Speaker avatars in chat" (#1976): the switch, your picture, and what it looks like.
import { asSpeaker, avatars, setAvatars } from './avatars.js';
import { account, api, h } from './base.js';
import { blobBase64 } from './bubbles.js';
import { optimistic } from './ui/optimistic.js';

const SIDE = 256;

/**
 * The middle of a picture as a small square, so what is sent and shown is never a camera's 12 MB.
 * @param {File} file
 * @returns {Promise<Blob>}
 */
async function square(file) {
  const img = await createImageBitmap(file);
  const from = Math.min(img.width, img.height);
  const canvas = h('canvas', { width: SIDE, height: SIDE });
  /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d')).drawImage(img, (img.width - from) / 2, (img.height - from) / 2, from, from, 0, 0, SIDE, SIDE);
  img.close();
  // A browser that can't write WebP gives a PNG, which keeps a picture's see-through parts too.
  return new Promise((ok, no) => canvas.toBlob((b) => (b ? ok(b) : no(new Error('no picture'))), 'image/webp', 0.9));
}

export function avatarsCard() {
  const box = h('input', { type: 'checkbox' });
  const chip = h('span', { class: 'link-chip' });
  const picker = h('input', { type: 'file', accept: 'image/*', hidden: true, 'aria-label': 'Your picture' });
  const pick = h('button', { type: 'button', class: 'secondary', onclick: () => picker.click() });
  const remove = h('button', { type: 'button', class: 'secondary' }, 'Remove it');
  const status = h('span', { class: 'error small', role: 'alert' });
  const mine = asSpeaker(h('div', { class: 'who' }, account?.name ?? 'You'), 'person', account?.name ?? 'You');
  /**
   * @param {Node} who
   * @param {string} text
   * @param {string} [cls]
   */
  const said = (who, text, cls = '') => h('div', { class: `msg ${cls}` }, who, h('p', {}, text));
  const preview = h(
    'div',
    // The class the switch puts on the page, so the sample shows it while the switch is off.
    { class: 'avatar-sample speaker-avatars', 'aria-label': 'Sample' },
    said(mine, 'What you write.', 'user'),
    said(asSpeaker(h('div', { class: 'who' }, 'Your Minion'), 'minion'), 'What a minion answers.'),
    said(asSpeaker(h('div', { class: 'who' }, 'Taskmaster'), 'taskmaster'), 'What the Taskmaster says.', 'from-tm'),
    said(asSpeaker(h('div', { class: 'who' }, 'Grunt'), 'grunt'), "A minion's helper."),
  );
  const draw = () => {
    const { on, pic } = avatars();
    box.checked = on;
    chip.className = `link-chip${on ? ' ok' : ''}`;
    chip.textContent = on ? 'On' : 'Off';
    pick.textContent = pic ? 'Change your picture' : 'Upload your picture';
    remove.hidden = !pic;
  };
  /**
   * Show `next` here and in every chat on the page; a kept page reopens with it.
   * @param {ReturnType<typeof avatars>} next
   */
  const show = (next) => {
    setAvatars(account ? { ...next, people: { ...next.people, [account.name]: next.pic } } : next);
    if (account) account.avatars = avatars();
    draw();
  };

  box.onchange = () => {
    const on = box.checked;
    optimistic({
      key: 'avatars',
      sets: 'avatars',
      apply: () => show({ ...avatars(), on }),
      send: () => api('api/me/avatars', { method: 'PUT', body: { on } }),
      undo: () => show({ ...avatars(), on: !on }),
      label: on ? 'turn on speaker avatars' : 'turn off speaker avatars',
    });
  };
  // What the server has: where a refused picture goes back to.
  let saved = avatars().pic;
  /**
   * @param {string | null} pic
   * @param {() => Promise<{ pic: string | null }>} send
   * @param {string} label
   */
  const setPicture = (pic, send, label) => {
    optimistic({
      key: 'avatar-pic',
      sets: 'avatar-pic',
      apply: () => show({ ...avatars(), pic }),
      send: async () => {
        const v = await send();
        saved = v.pic;
        // A newer pick, shown meanwhile, stays.
        if (avatars().pic === pic) show({ ...avatars(), pic: saved });
        if (pic) URL.revokeObjectURL(pic);
      },
      undo: () => show({ ...avatars(), pic: saved }),
      label,
    });
  };
  picker.onchange = async () => {
    const file = /** @type {FileList} */ (picker.files)[0];
    picker.value = '';
    if (!file) return;
    status.textContent = '';
    /** @type {Blob} */
    let blob;
    try {
      blob = await square(file);
    } catch {
      return void (status.textContent = "That file couldn't be read as a picture: try a PNG or a JPEG.");
    }
    setPicture(URL.createObjectURL(blob), async () => api('api/me/avatar', { method: 'PUT', body: { data: await blobBase64(blob) } }), 'save your picture');
  };
  remove.onclick = () => setPicture(null, () => api('api/me/avatar', { method: 'DELETE' }), 'remove your picture');
  show(avatars());
  return h(
    'div',
    { class: 'account-card avatars-card' },
    h('h3', {}, 'Speaker avatars in chat', chip),
    h('label', { class: 'toggle' }, box, "Show each speaker's avatar and colour beside their name"),
    preview,
    h('div', { class: 'row' }, pick, remove, picker, status),
    h('p', { class: 'muted small' }, 'Only your own Citadel changes. Your picture shows to people who turned this on; without one, they see your initial.'),
  );
}
