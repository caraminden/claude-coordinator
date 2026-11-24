// Which scheme a bare visit to the app opens: the one this browser last had open, else Citadel,
// else the first. There is no list page any more, so this is the app's front door.

export const HOME_SCHEME = 2; // Citadel

/** The id to open from `projects` ([{ id }]), given the last-opened id; null when there are none. */
export function startScheme(projects, lastId) {
  const has = (id) => projects.some((p) => p.id === id);
  if (has(lastId)) return lastId;
  if (has(HOME_SCHEME)) return HOME_SCHEME;
  return projects[0]?.id ?? null;
}

// The favicons the page has, by `<id>.<version>` (the icon URL's ?v=), kept in localStorage so a returning browser asks for none (#1543).
// A key the page lacks is asked for once, with every other missing one, in one api/icons request; the imgs fill in when it answers.
const KEEP = 'scheme-icon:';
const got = new Map();
const none = new Set(); // asked for, answered null: not asked again this visit
let owed = new Set();

const keyOf = (p) => `${p.id}.${p.icon}`;
const keep = (k) => {
  try {
    return localStorage.getItem(KEEP + k);
  } catch {
    return null;
  }
};

/** The favicon's src for scheme `p` once the page has it; null when it has none or the batch hasn't answered yet (the imgs fill in then). */
export function iconSrc(p) {
  if (p.icon == null) return null;
  const k = keyOf(p);
  const src = got.get(k) ?? keep(k);
  if (src) {
    got.set(k, src);
    return src;
  }
  if (!none.has(k) && !owed.has(k)) {
    owed.add(k);
    if (owed.size === 1) setTimeout(fetchOwed, 0);
  }
  return null;
}

async function fetchOwed() {
  const keys = [...owed];
  owed = new Set();
  let icons;
  try {
    const res = await fetch(`api/icons?ids=${keys.join(',')}`);
    if (!res.ok) throw new Error(String(res.status));
    ({ icons } = await res.json());
  } catch {
    for (const k of keys) none.add(k); // a failed batch isn't retried at once: the next page load asks again
    return;
  }
  for (const k of keys) {
    const src = icons[k];
    if (!src) {
      none.add(k);
      continue;
    }
    got.set(k, src);
    const id = k.split('.')[0];
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const o = localStorage.key(i);
        if (o?.startsWith(`${KEEP}${id}.`)) localStorage.removeItem(o);
      }
      localStorage.setItem(KEEP + k, src);
    } catch {
      /* full or blocked: it is asked for again next visit */
    }
    for (const el of document.querySelectorAll(`[data-scheme-icon="${id}"]`)) {
      el.src = src;
      el.hidden = false;
    }
  }
}
