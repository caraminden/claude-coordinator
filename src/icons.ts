import { createHash } from 'node:crypto';

const ICON_FILE = /^(icon[\w-]*|apple-touch-icon)\.(png|svg)$/;

/**
 * Gives every app icon a URL that changes with its content (/icon-192.png → /icon-192.png?v=<hash>)
 * in the manifest, index.html and sw.js, so a swapped icon is never served from a browser or OS
 * icon cache under its old URL. Edits the text assets in place.
 */
export function versionIcons(assets: Map<string, Buffer>) {
  const versioned = new Map<string, string>();
  for (const [name, body] of assets) {
    if (ICON_FILE.test(name)) versioned.set(name, `${name}?v=${createHash('sha256').update(body).digest('hex').slice(0, 8)}`);
  }
  for (const [name, body] of assets) {
    if (!/\.(html|js|webmanifest)$/.test(name)) continue;
    let text = body.toString('utf8');
    for (const [file, url] of versioned) text = text.replace(new RegExp(`(?<![\\w-])${file.replace('.', '\\.')}(?![\\w?-])`, 'g'), url);
    assets.set(name, Buffer.from(text));
  }
}
