// Whether a contraption installs as its own app (#297). Chrome tells installed apps apart by the
// manifest's resolved `id`, and won't offer to install a page that sits inside an installed app's
// scope, so on Citadel's one origin each contraption's id and scope must be its own /apps/<name>/
// (Citadel's are "/" and "/c/"). A deploy runs this and logs what it finds as warnings.
// Rules for authors: kit/skills/contraption-ui/SKILL.md, "Installing as its own app".

/**
 * What's wrong with how contraption `name` installs as its own app: [] when nothing. `get` fetches a
 * path from the contraption (as a signed-in person, since its page is behind Citadel's login).
 */
export async function installProblems(name: string, get: (path: string) => Promise<Response>): Promise<string[]> {
  const home = `/apps/${name}/`;
  const page = await get(home);
  if (!page.ok) return [`Couldn't check how it installs: ${home} answered ${page.status}.`];
  const html = await page.text();
  const hrefOf = (tag: string | undefined) => {
    const m = tag && /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    return m ? m[1] ?? m[2] ?? m[3] : null;
  };
  const href = hrefOf(/<link\b[^>]*\brel\s*=\s*["']?manifest\b[^>]*>/i.exec(html)?.[0]);
  if (href === null) return [`Its page has no <link rel="manifest">, so it can't be installed as its own app.`];
  const base = new URL(home, 'https://citadel.invalid');
  // A <base href> (Theory of Crafting has one) moves what the link is relative to.
  const baseHref = hrefOf(/<base\b[^>]*>/i.exec(html)?.[0]);
  const murl = new URL(href, baseHref === null ? base : new URL(baseHref, base));
  const under = (u: URL) => u.origin === base.origin && u.pathname.startsWith(home);
  if (!under(murl)) return [`Its manifest link "${href}" points outside ${home} (a root-absolute link loads Citadel's manifest): make it relative, like href="manifest.webmanifest".`];
  const res = await get(murl.pathname + murl.search);
  if (!res.ok) return [`Its manifest ${murl.pathname} answered ${res.status}.`];
  let m: Record<string, unknown>;
  try {
    m = await res.json();
  } catch {
    return [`Its manifest ${murl.pathname} isn't JSON.`];
  }
  // Resolved as the Web App Manifest spec does: start_url and scope against the manifest's URL, id against start_url's origin.
  const resolve = (v: unknown, against: URL | string) => {
    try { return typeof v === 'string' ? new URL(v, against) : null; } catch { return null; }
  };
  let start = resolve(m.start_url, murl);
  if (!start || start.origin !== base.origin) start = base;
  const scope = resolve(m.scope, murl) ?? new URL('.', start);
  const id = (typeof m.id === 'string' && resolve(m.id, start.origin)) || start;
  const problems: string[] = [];
  const at = (u: URL) => u.pathname + u.search;
  if (!under(id)) problems.push(`Its manifest's id resolves to ${at(id)}, not under ${home}: Chrome would take it for another app (Citadel's is "/"). Set "id": "${home}".`);
  if (!under(scope)) problems.push(`Its manifest's scope resolves to ${at(scope)}, not under ${home}: it would claim other apps' pages. Set "scope": "${home}".`);
  if (!start.pathname.startsWith(scope.pathname)) problems.push(`Its start_url ${at(start)} is outside its scope ${scope.pathname}.`);
  return problems;
}
