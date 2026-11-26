// "Point at something" (#1141): a picture of the part a person picked, made without screen capture (which asks
// permission each time and doesn't exist on most phones). The part and a margin around it are copied with every
// element's computed style written inline, wrapped in an SVG <foreignObject> and drawn onto a canvas. An SVG drawn as
// an image loads nothing from outside, so <img> sources are inlined first; what still can't be drawn (another site's
// picture, a <canvas>, a browser that refuses to read the canvas back) leaves the crop out, and the named reference
// still goes. Resolves to a PNG blob, or null. The desktop app takes an exact screenshot of cropBox() instead (#1665).
// Served to apps beside rail.js too (app-menu.js), so it stays standalone: no imports.

const MARGIN = 16; // px of what's around the part, so the crop shows where it sits
const MAX_SIDE = 1600; // px on the longer side, before devicePixelRatio
const MAX_NODES = 4000; // a pick of a whole page copies too much: no crop

// What a click snaps to: the nearest named part (#1122) or control, row or heading, not the bare text inside it.
export const PICKABLE = '[data-part], button, a[href], input, select, textarea, summary, label, [role=button], [role=tab], [role=menuitem], [role=option], [role=row], li, tr, h1, h2, h3, h4, .msg, .thread-row';

/**
 * The part plus its margin, kept inside the window, in the window's CSS pixels; null when there's too little or too much of it.
 * @param {Element} target
 */
export function cropBox(target) {
  const box = target.getBoundingClientRect();
  const x0 = Math.max(box.left - MARGIN, 0),
    y0 = Math.max(box.top - MARGIN, 0);
  const x1 = Math.min(box.right + MARGIN, innerWidth),
    y1 = Math.min(box.bottom + MARGIN, innerHeight);
  const w = Math.round(x1 - x0),
    h = Math.round(y1 - y0);
  return w < 4 || h < 4 || w > MAX_SIDE * 2 || h > MAX_SIDE * 2 ? null : { left: Math.round(x0), top: Math.round(y0), width: w, height: h };
}

/**
 * @param {Element} target
 * @returns {Promise<Blob | null>}
 */
export async function cropPart(target) {
  try {
    const box = target.getBoundingClientRect();
    const host = frameFor(target, box);
    const hr = host.getBoundingClientRect();
    // The crop: the part plus a margin, kept inside the viewport; past the host's edge is its background.
    const x0 = Math.max(box.left - MARGIN, 0),
      y0 = Math.max(box.top - MARGIN, 0);
    const x1 = Math.min(box.right + MARGIN, innerWidth),
      y1 = Math.min(box.bottom + MARGIN, innerHeight);
    const w = Math.round(x1 - x0),
      h = Math.round(y1 - y0);
    if (w < 4 || h < 4 || w > MAX_SIDE * 2 || h > MAX_SIDE * 2) return null;
    if (host.getElementsByTagName('*').length > MAX_NODES) return null;
    // The host's copy sits where the host is, shifted so the crop's corner is the picture's corner.
    const inner = await copyStyled(host, `position:absolute;left:${hr.left - x0}px;top:${hr.top - y0}px;margin:0;`);
    if (inner == null) return null;
    const outer = `<div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;width:${w}px;height:${h}px;overflow:hidden;background:${backgroundOf(host)}">${inner}</div>`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><foreignObject x="0" y="0" width="100%" height="100%">${outer}</foreignObject></svg>`;
    const img = new Image();
    img.decoding = 'sync';
    // A data: URL (src/http.ts's img-src allows it for this): Chrome won't read back a canvas that drew a blob: one.
    // The markup is a string, as the CSP allows no style="" on elements.
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await img.decode();
    const scale = Math.min(devicePixelRatio || 1, 2, MAX_SIDE / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    // Safari marks a canvas that drew a foreignObject as unreadable: toBlob throws, and the pick goes without a crop.
    return await new Promise((/** @type {(b: Blob | null) => void} */ resolve) => canvas.toBlob(resolve, 'image/png'));
  } catch {
    return null;
  }
}

/**
 * The smallest ancestor that holds the part and its margin, so the crop shows its surroundings, not a bare part. It
 * stops below one that's stuck in place (sticky, fixed: the copy can't scroll, so it would land elsewhere) and below one
 * many times the crop's size (a whole pane copied for one button).
 * @param {Element} target
 * @param {DOMRect} box
 */
function frameFor(target, box) {
  const area = (box.width + 2 * MARGIN) * (box.height + 2 * MARGIN);
  let host = target;
  for (let /** @type {Element | null} */ p = target.parentElement; p && p !== document.body; p = p.parentElement) {
    if (/sticky|fixed/.test(getComputedStyle(host).position)) break;
    const r = p.getBoundingClientRect();
    if (r.width * r.height > area * 8) break;
    host = p;
    if (r.left <= box.left - MARGIN && r.top <= box.top - MARGIN && r.right >= box.right + MARGIN && r.bottom >= box.bottom + MARGIN) break;
  }
  return host;
}

/**
 * The first colour behind `el` that isn't see-through, so the crop's margin isn't transparent.
 * @param {Element} el
 */
function backgroundOf(el) {
  for (let /** @type {Element | null} */ p = el; p; p = p.parentElement) {
    const c = getComputedStyle(p).backgroundColor;
    if (c && c !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(c)) return c;
  }
  return getComputedStyle(document.body).backgroundColor || '#fff';
}

const SKIP = new Set(['SCRIPT', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'VIDEO', 'AUDIO', 'OBJECT', 'EMBED']);
const VOID = new Set(['AREA', 'BR', 'COL', 'HR', 'IMG', 'INPUT', 'WBR']);
const KEEP = ['class', 'placeholder', 'colspan', 'rowspan', 'type', 'alt', 'viewBox', 'd', 'fill', 'stroke', 'points', 'cx', 'cy', 'r', 'x', 'y', 'width', 'height', 'rx', 'x1', 'x2', 'y1', 'y2', 'transform', 'stroke-width', 'preserveAspectRatio'];
/** @param {unknown} t */
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * `el` and what's in it as XHTML markup with each element's computed style inline (pseudo-elements as spans), `extra`
 * added to the top one's style; null if something in it can't be drawn.
 * @param {Element} el
 * @param {string} extra
 * @returns {Promise<string | null>}
 */
async function copyStyled(el, extra) {
  /** @type {HTMLImageElement[]} */
  const images = [];
  let refused = false;
  /**
   * @param {Node} node
   * @param {string} [add]
   * @returns {string}
   */
  const walk = (node, add = '') => {
    if (node.nodeType === Node.TEXT_NODE) return esc(/** @type {Text} */ (node).data);
    const src = /** @type {HTMLElement} */ (node);
    if (src.nodeType !== Node.ELEMENT_NODE || SKIP.has(src.tagName)) return '';
    if (src.tagName === 'CANVAS') {
      refused = true;
      return '';
    }
    const cs = getComputedStyle(src);
    if (cs.display === 'none') return '';
    const tag = src instanceof SVGElement ? src.tagName : src.tagName === 'BODY' ? 'div' : src.tagName.toLowerCase();
    // Stuck in place on the page, at its place in the copy's flow instead (the host is small, so that's near).
    const stuck = add ? '' : cs.position === 'fixed' || cs.position === 'sticky' ? 'position:relative;inset:auto;' : '';
    let attrs = ` style="${esc(styleText(cs) + stuck + add)}"`;
    for (const a of KEEP) if (src.hasAttribute(a)) attrs += ` ${a}="${esc(src.getAttribute(a))}"`;
    if (tag === 'svg') attrs += ' xmlns="http://www.w3.org/2000/svg"';
    if (tag === 'img') {
      const i = images.push(/** @type {HTMLImageElement} */ (/** @type {unknown} */ (src))) - 1; // tag 'img' means an <img>
      return `<img${attrs} src="\u0000img${i}\u0000"/>`;
    }
    // A field's value lives in the property, not the attribute: copy it in so the crop shows what was typed.
    if (tag === 'input') return `<input${attrs} value="${esc(/** @type {HTMLInputElement} */ (src).value)}"${/** @type {HTMLInputElement} */ (src).checked ? ' checked="checked"' : ''}/>`;
    if (tag === 'textarea') return `<textarea${attrs}>${esc(/** @type {HTMLTextAreaElement} */ (src).value)}</textarea>`;
    // A select draws its chosen option; a span in its place looks the same and needs no options.
    if (tag === 'select') return `<span${attrs}>${esc(/** @type {HTMLSelectElement} */ (src).selectedOptions[0]?.textContent ?? '')}</span>`;
    if (VOID.has(src.tagName)) return `<${tag}${attrs}/>`;
    let body = pseudo(src, '::before');
    for (const child of src.childNodes) body += walk(child);
    body += pseudo(src, '::after');
    // Scrolled inside: the copy can't scroll, so its content moves up by as much.
    if (src.scrollTop || src.scrollLeft) body = `<div style="transform:translate(${-src.scrollLeft}px,${-src.scrollTop}px)">${body}</div>`;
    return `<${tag}${attrs}>${body}</${tag}>`;
  };
  let markup = walk(el, extra);
  const urls = await Promise.all(images.map(inlineImage));
  if (refused || urls.includes(null)) return null;
  markup = markup.replace(/\u0000img(\d+)\u0000/g, (_, i) => esc(urls[Number(i)]));
  return markup;
}

/**
 * Every property of a computed style, as inline CSS.
 * @param {CSSStyleDeclaration} cs
 */
function styleText(cs) {
  let text = '';
  for (let i = 0; i < cs.length; i++) {
    const name = cs[i];
    // Animations and transitions would draw a frame mid-way; the part as it is now is what counts.
    if (name.startsWith('animation') || name.startsWith('transition')) continue;
    text += `${name}:${cs.getPropertyValue(name)};`;
  }
  return text;
}

/**
 * @param {Element} el
 * @param {string} which
 */
function pseudo(el, which) {
  const cs = getComputedStyle(el, which);
  const content = cs.content;
  if (!content || content === 'none' || content === 'normal') return '';
  // Only a quoted string is drawn; counters and url() leave the box with its border and background.
  const m = /^"(.*)"$/s.exec(content);
  return `<span style="${esc(styleText(cs))}">${m ? esc(m[1].replace(/\\"/g, '"')) : ''}</span>`;
}

/**
 * An <img> as a data: URL, since an SVG image loads nothing; null for a picture from another site.
 * @param {HTMLImageElement} img
 * @returns {Promise<string | null>}
 */
async function inlineImage(img) {
  const src = img.currentSrc || img.src;
  if (!src) return '';
  if (src.startsWith('data:')) return src;
  try {
    if (new URL(src, location.href).origin !== location.origin && !src.startsWith('blob:')) return null;
    const blob = await (await fetch(src)).blob();
    return await new Promise((/** @type {(s: string) => void} */ resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(/** @type {string} */ (r.result));
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/**
 * The chip's short label and the text a message carries for a pointed-at `el`: what it is, the page (`page`, at
 * `where`), the window's size and the theme. Citadel's pages (pick.js) and apps (app-menu.js) both name parts this way.
 * @param {HTMLElement} el
 * @param {string} page
 * @param {string} where
 */
export function describePart(el, page, where) {
  const part = el.dataset?.part;
  const within = /** @type {HTMLElement | null | undefined} */ (el.parentElement?.closest('[data-part]'))?.dataset.part;
  const name = shorten(el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('alt') || el.innerText || buttonValue(el) || '');
  const kind = kindOf(el);
  const size = `${innerWidth}×${innerHeight}`;
  const theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  const what = name ? `${kind} "${name}"` : kind;
  const label = [name || part || kind, page, `${size} ${theme}`].join(' · ');
  const text = [`📍 Pointed at: ${what}${part ? ` (part ${part})` : ''}${within ? `, inside part ${within}` : ''}`, `On: ${page} (${where}) · window ${size} · ${theme} theme`].join('\n');
  return { label, text };
}

// A field's typed value never goes in the message (it could be a password or a token, and sent past looksSecret): only
// a button input's value, which is its label.
/** @param {Element} el */
const buttonValue = (el) => (el instanceof HTMLInputElement && /^(button|submit|reset)$/.test(el.type) ? el.value : '');

/** @param {unknown} t */
const shorten = (t) => {
  const s = String(t).replace(/\s+/g, ' ').trim();
  return s.length > 60 ? `${s.slice(0, 59)}…` : s;
};

/** @param {Element} el */
function kindOf(el) {
  const role = el.getAttribute('role');
  if (role) return role;
  const tag = el.tagName.toLowerCase();
  return (
    /** @type {Record<string, string>} */ ({ a: 'link', button: 'button', input: 'field', textarea: 'text box', select: 'dropdown', summary: 'section toggle', li: 'list item', tr: 'table row', label: 'label' })[tag] ??
    (/^h\d$/.test(tag) ? 'heading' : el.classList.contains('thread-row') ? 'minion row' : el.classList.contains('msg') ? 'message' : tag)
  );
}
