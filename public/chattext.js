// A minion's chat as text: the wording of notes, durations, recaps and who sent a message, without the page,
// so node tests can import it (thread.js builds the nodes).
import { taskmasterName } from './base.js';

/**
 * The thread a coordinator tool call created or messaged, from its result ("Created #15 …",
 * "Sent. #12 …"), as { verb, number }; null for other calls and failures.
 */
export function ticketActionRef({ block, result }) {
  if (!result || result.is_error || !block.name.startsWith('mcp__coordinator__')) return null;
  const text = Array.isArray(result.content) ? result.content.map((c) => c?.text ?? '').join('\n') : String(result.content ?? '');
  const m = /^(Created|Sent\.|Updated\.) #(\d+)\b/.exec(text);
  return m ? { verb: { Created: 'Created', 'Sent.': 'Messaged', 'Updated.': 'Updated' }[m[1]], number: Number(m[2]) } : null;
}

export function firstSentence(text, max = 200) {
  const flat = String(text ?? '').replace(/[*`#>]/g, '').replace(/\s+/g, ' ').trim();
  const sentence = flat.match(/^.*?[.!?](\s|$)/)?.[0].trim() ?? flat;
  return sentence.length > max ? `${sentence.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : sentence;
}

/** "45s", "1m 47s", "12m", "1h 5m". */
export function shortDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 600) return `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ''}`;
  // Round to minutes first, so 59m 50s reads "1h 0m", not "60m".
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Short wording for the notes the server writes often (null hides one); anything else stays as it is. */
export function shortNote(text) {
  let m;
  // Older threads stored a note on every session restore; restores are silent now.
  if (/^Restored this thread's Claude session from the app's database/.test(text)) return null;
  if (text === 'The server restarted during this turn, so it was interrupted.') return '⚠ Interrupted by a server restart';
  if ((m = text.match(/^(.+?) renamed this (?:ticket|minion) from ".*" to "(.*)"\.$/s))) return `✎ ${m[1] === 'Claude' ? 'Renamed' : `${m[1]} renamed it`} “${m[2]}”`;
  if ((m = text.match(/^(.+?) set this (?:thread|minion) to (.+?) (from the next turn|from now on)\.$/))) return `⚙ ${m[1]}: ${m[2]}${m[3] === 'from the next turn' ? ' next turn' : ''}`;
  if ((m = text.match(/^(.+?) (updated|cleared) the (?:project|scheme) instructions; they apply from each (?:thread|minion)'s next turn\.$/))) return `📋 ${m[1]} ${m[2]} the scheme instructions`;
  if ((m = text.match(/^(.+?) set the (approval rules|plugin folders) to: (.*)\. They apply from each (?:thread|minion)'s next turn\.$/s))) return `🔒 ${m[1]} set the ${m[2]}: ${m[3]}`;
  if ((m = text.match(/^(.+?) reopened this (?:ticket|minion)\.$/))) return `↻ ${m[1]} reopened it`;
  return text;
}

// Messages the app sends a thread about its pull request (see src/github.ts).
export const GITHUB_NAME = 'GitHub';
export const COORDINATOR_NAME = 'Coordinator';
// APP_NAME in src/appname.ts: wake-ups and chained-minion notices.
export const APP_AUTHOR = 'Citadel';

/**
 * Who sent a message that isn't from a person (authors from server.ts), as the collapsed row shows them:
 * the Taskmaster, another scheme's ("Taskmaster of Delve"), a minion ("#12 Title"), the app or
 * GitHub. null for a person.
 */
export function machineAuthor(author) {
  author ??= '';
  if (author === COORDINATOR_NAME || author === 'Taskmaster') return taskmasterName();
  // Citadel's Taskmaster also hears whose ask it is: "Taskmaster of Delve, for Josh, a Citadel member".
  const [, scheme, whose = ''] = author.match(/^Taskmaster of (.+?)(, for .+)?$/) ?? [];
  if (scheme) return `${scheme} Taskmaster${whose}`;
  // A contraption's ask from before #316 carried no summary: it collapses like the rest.
  return author === APP_AUTHOR || author === GITHUB_NAME || /^#\d+ /.test(author) || /^Contraption .+, for .+ member$/.test(author) ? author : null;
}
