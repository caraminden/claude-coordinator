// "Point at something" (#1141): a picture of the part a person picked, made without screen capture (which asks
// permission each time and doesn't exist on most phones). The part and a margin around it are copied with every
// element's computed style written inline, wrapped in an SVG <foreignObject> and drawn onto a canvas. An SVG drawn as
// an image loads nothing from outside, so <img> sources are inlined first; what still can't be drawn (another site's
// picture, a <canvas>, a browser that refuses to read the canvas back) leaves the crop out, and the named reference
// still goes. Resolves to a PNG blob, or null.

const MARGIN = 16; // px of what's around the part, so the crop shows where it sits
const MAX_SIDE = 1600; // px on the longer side, before devicePixelRatio
const MAX_NODES = 4000; // a pick of a whole page copies too much: no crop

export async function cropPart(target) {
  try {
    const box = target.getBoundingClientRect();
    const host = frameFor(target, box);
    const hr = host.getBoundingClientRect();
    // The crop: the part plus a margin, kept inside the viewport; past the host's edge is its background.
    const x0 = Math.max(box.left - MARGIN, 0), y0 = Math.max(box.top - MARGIN, 0);
    const x1 = Math.min(box.right + MARGIN, innerWidth), y1 = Math.min(box.bottom + MARGIN, innerHeight);
    const w = Math.round(x1 - x0), h = Math.round(y1 - y0);
    if (w < 4 || h < 4 || w > MAX_SIDE * 2 || h > MAX_SIDE * 2) return null;
    if (host.getElementsByTagName('*').length > MAX_NODES) return null;
    // The host's copy sits where the host is, shifted so the crop's corner is the picture's corner.
    const inner = await copyStyled(host, `position:absolute;left:${hr.left - x0}px;top:${hr.top - y0}px;margin:0;`);
    if (inner == null) return null;
    const outer = `<div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;width:${w}px;height:${h}px;overflow:hidden;background:${backgroundOf(host)}">${inner}</div>`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><foreignObject x="0" y="0" width="100%" height="100%">${outer}</foreignObject></svg>`;
    const img = new Image();
    img.decoding = 'sync';
    // A blob: URL, as the page's CSP allows no data: images; the markup is a string, as it allows no style="" either.
    const url = globalThis.__cropData ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    img.src = url;
    try {
      await img.decode();
    } finally {
      URL.revokeObjectURL(url);
    }
    const scale = Math.min(devicePixelRatio || 1, 2, MAX_SIDE / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    // Safari marks a canvas that drew a foreignObject as unreadable: toBlob throws, and the pick goes without a crop.
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  } catch (err) {
    globalThis.__cropErr = String(err?.stack || err);
    return null;
  }
}

/**
 * The smallest ancestor that holds the part and its margin, so the crop shows its surroundings, not a bare part. It
 * stops below one that's stuck in place (sticky, fixed: the copy can't scroll, so it would land elsewhere) and below one
 * many times the crop's size (a whole pane copied for one button).
 */
function frameFor(target, box) {
  const area = (box.width + 2 * MARGIN) * (box.height + 2 * MARGIN);
  let host = target;
  for (let p = target.parentElement; p && p !== document.body; p = p.parentElement) {
    if (/sticky|fixed/.test(getComputedStyle(host).position)) break;
    const r = p.getBoundingClientRect();
    if (r.width * r.height > area * 8) break;
    host = p;
    if (r.left <= box.left - MARGIN && r.top <= box.top - MARGIN && r.right >= box.right + MARGIN && r.bottom >= box.bottom + MARGIN) break;
  }
  return host;
}

/** The first colour behind `el` that isn't see-through, so the crop's margin isn't transparent. */
function backgroundOf(el) {
  for (let p = el; p; p = p.parentElement) {
    const c = getComputedStyle(p).backgroundColor;
    if (c && c !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(c)) return c;
  }
  return getComputedStyle(document.body).backgroundColor || '#fff';
}

const SKIP = new Set(['SCRIPT', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'VIDEO', 'AUDIO', 'OBJECT', 'EMBED']);
const VOID = new Set(['AREA', 'BR', 'COL', 'HR', 'IMG', 'INPUT', 'WBR']);
const KEEP = ['class', 'placeholder', 'colspan', 'rowspan', 'type', 'alt', 'viewBox', 'd', 'fill', 'stroke', 'points', 'cx', 'cy', 'r', 'x', 'y', 'width', 'height', 'rx', 'x1', 'x2', 'y1', 'y2', 'transform', 'stroke-width', 'preserveAspectRatio'];
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * `el` and what's in it as XHTML markup with each element's computed style inline (pseudo-elements as spans), `extra`
 * added to the top one's style; null if something in it can't be drawn.
 */
async function copyStyled(el, extra) {
  const images = [];
  let refused = false;
  const walk = (src, add = '') => {
    if (src.nodeType === Node.TEXT_NODE) return esc(src.data);
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
      const i = images.push(src) - 1;
      return `<img${attrs} src="\u0000img${i}\u0000"/>`;
    }
    // A field's value lives in the property, not the attribute: copy it in so the crop shows what was typed.
    if (tag === 'input') return `<input${attrs} value="${esc(src.value)}"${src.checked ? ' checked="checked"' : ''}/>`;
    if (tag === 'textarea') return `<textarea${attrs}>${esc(src.value)}</textarea>`;
    // A select draws its chosen option; a span in its place looks the same and needs no options.
    if (tag === 'select') return `<span${attrs}>${esc(src.selectedOptions[0]?.textContent ?? '')}</span>`;
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
  markup = markup.replace(/\u0000img(\d+)\u0000/g, (_, i) => esc(urls[i]));
  return markup;
}

/** Every property of a computed style, as inline CSS. */
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

function pseudo(el, which) {
  const cs = getComputedStyle(el, which);
  const content = cs.content;
  if (!content || content === 'none' || content === 'normal') return '';
  // Only a quoted string is drawn; counters and url() leave the box with its border and background.
  const m = /^"(.*)"$/s.exec(content);
  return `<span style="${esc(styleText(cs))}">${m ? esc(m[1].replace(/\\"/g, '"')) : ''}</span>`;
}

/** An <img> as a data: URL, since an SVG image loads nothing; null for a picture from another site. */
async function inlineImage(img) {
  const src = img.currentSrc || img.src;
  if (!src) return '';
  if (src.startsWith('data:')) return src;
  try {
    if (new URL(src, location.href).origin !== location.origin && !src.startsWith('blob:')) return null;
    const blob = await (await fetch(src)).blob();
    return await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}
