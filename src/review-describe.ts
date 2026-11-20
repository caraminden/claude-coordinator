// "Describe a change" on the Reviewers and critics page (Build 4, Q11): a person writes what they want ("make the UI
// critic harsher on padding"), a one-shot Claude call on their own login (sender pays) reads the set and proposes new
// bodies, and the page shows each as before and after with Apply and Dismiss. Nothing is saved here: Apply is the
// page's ordinary save, so it is a version History can undo.
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { AUTH_VARS, resolveClaude, type TurnPlace } from './claude-link.ts';
import { BUILT_INS, isAgentFile, isKit, onFailText, whenText, type OnFail, type ReviewEntry } from './review-set.ts';

/** How it works with the others (Q7, phase 3), which the agent may set on a scheme's own entries besides the body. */
export interface Settings { gate?: 'block' | 'advise' | null; panel?: string | null; on_fail?: OnFail[] | null; position?: number }
export interface Proposal { slug: string; name: string; version: number; before: string; after: string; why: string; settings?: Settings; settings_before?: Settings }

/** Settings as lines for the before and after view: "gate: block", "on_fail: professor after 2 fails". */
export function settingsText(s: Settings): string {
  return [s.gate !== undefined ? `gate: ${s.gate ?? 'none'}` : '', s.panel !== undefined ? `panel: ${s.panel ?? 'none'}` : '', s.on_fail !== undefined ? `on_fail: ${s.on_fail?.length ? onFailText(s.on_fail) : 'the default'}` : '', s.position !== undefined ? `run order: ${s.position}` : ''].filter(Boolean).join('\n');
}

/** The cheap tier for a known-shape edit (Citadel-wide "Usage, effort and models"): Sonnet at medium. */
const ARGS = ['-p', '--output-format', 'json', '--model', 'sonnet', '--effort', 'medium', '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence'];
const TIMEOUT_MS = 4 * 60_000;

/** What the model reads: the ask, then the set as JSON with each entry's editable text. */
export function describePrompt(ask: string, entries: ReviewEntry[]): string {
  const set = entries.map((e) => {
    const kit = isKit(e) ? BUILT_INS.find((b) => b.slug === e.slug) : undefined;
    return { slug: e.slug, name: e.name, kind: e.kind, stage: e.stage, on: e.enabled, trial: e.trial, when: kit?.when ?? (whenText(e.triggers) || 'ask'), ...(kit ? { kit: kit.what } : { position: e.position, gate: e.gate, panel: e.panel, on_fail: e.on_fail }), ...(e.extends ? { extends_kit_starter: e.extends } : {}), ...(isAgentFile(e) ? { agent_file: e.source!.slice(6) } : {}), body: e.body };
  });
  return [
    "You edit a scheme's review set: the reviewers and critics that judge its work in Citadel. Each entry's `body` is a rubric in its own text: optional frontmatter (between --- lines; never name, extends, when, model, effort, trial, gate or calibrated, which the page owns), then its sections (## Blockers, ## Scale, ## Known blind spots and the like). An entry with `kit` is one of the kit's own reviewers: its text stays in the kit, and its body holds only this scheme's additions, read with it. An entry with `agent_file` is one of this scheme's own agent files in its repo: its text stays in that file, and its body holds only this scheme's additions too. An entry with `extends_kit_starter` adds to that kit starter the same way. The list is in run order: within a stage, later entries see earlier ones' verdicts.",
    'Besides the body, an entry that isn\'t `kit` has four settings for how it works with the others, which you may change too: `position` (its run order within its stage, a whole number: lower runs first; to reorder, give each entry you move a new number, like swapping two entries\' numbers), `gate` ("block": its fail holds the ship; "advise": it only reports; an entry on trial only advises), `panel` (a name: the entries of a stage with the same panel judge the same work at once, and one of kind "referee" in it merges their verdicts; null for none), and `on_fail` (hand-offs as [{"after": failed rounds, "to": "professor", "person" or another entry\'s slug}], rising; null for the default: professor after 2, a person after 3).',
    `A person asked for this change:\n<ask>\n${ask}\n</ask>`,
    `The set:\n${JSON.stringify(set, null, 1)}`,
    'Propose the smallest edits to entries\' bodies that do what they asked, in their words and the entries\' own style, keeping everything else as written. Only entries in the set, at most 4. Reply with JSON only, no fences: {"edits": [{"slug": "<slug>", "body": "<the whole new body, or leave it out to keep it>", "settings": {"position"?, "gate"?, "panel"?, "on_fail"?: only the ones you change}, "why": "<one plain line on what changed>"}], "note": "<one line for the person: what you did, or why there is nothing to change (the ask isn\'t about these entries, or needs a switch on the page instead)>"}',
  ].join('\n\n');
}

/** The model's reply to proposals over the set as it is now, refusing anything that isn't an edit of an entry's body. */
export function readProposals(reply: string, entries: ReviewEntry[]): { note: string; proposals: Proposal[] } {
  const text = reply.trim().replace(/^```(?:json)?\s*/, '').replace(/```$/, '').trim();
  const start = text.indexOf('{');
  let data: any;
  try {
    data = JSON.parse(text.slice(start, text.lastIndexOf('}') + 1));
  } catch {
    throw new Error("The agent's answer wasn't the proposal it should be. Try again, or say it another way.");
  }
  const note = typeof data?.note === 'string' ? data.note.trim().slice(0, 500) : '';
  const proposals: Proposal[] = [];
  for (const ed of Array.isArray(data?.edits) ? data.edits.slice(0, 4) : []) {
    const e = entries.find((x) => x.slug === ed?.slug);
    if (!e || proposals.some((p) => p.slug === e.slug)) continue;
    const body = typeof ed.body === 'string' && ed.body.length <= 200_000 && ed.body.trim() !== e.body.trim() ? ed.body.trim() : null;
    // Only a scheme's own entries have settings (a kit entry's are the kit's); the save checks each value as the page's would.
    const settings: Settings = {};
    const was: Settings = {};
    const set = ed.settings && typeof ed.settings === 'object' && !isKit(e) ? ed.settings : {};
    if (set.gate !== undefined && (set.gate === null || set.gate === 'block' || set.gate === 'advise') && set.gate !== e.gate) [settings.gate, was.gate] = [set.gate, e.gate];
    if (set.panel !== undefined && (set.panel === null || typeof set.panel === 'string') && (set.panel?.trim() || null) !== e.panel) [settings.panel, was.panel] = [set.panel?.trim() || null, e.panel];
    if (set.on_fail !== undefined && (set.on_fail === null || Array.isArray(set.on_fail)) && JSON.stringify(set.on_fail) !== JSON.stringify(e.on_fail)) [settings.on_fail, was.on_fail] = [set.on_fail, e.on_fail];
    if (Number.isInteger(set.position) && set.position !== e.position) [settings.position, was.position] = [set.position, e.position];
    const changed = Object.keys(settings).length > 0;
    if (body === null && !changed) continue;
    proposals.push({ slug: e.slug, name: e.name, version: e.version, before: e.body, after: body ?? e.body, why: typeof ed.why === 'string' ? ed.why.trim().slice(0, 300) : '', ...(changed ? { settings, settings_before: was } : {}) });
  }
  return { note, proposals };
}

/** Containers with a describe call running, so the idle sweep doesn't stop one under it (ClaudeLink.busy). */
const running = new Map<string, number>();
export const describesIn = (container: string) => running.get(container) ?? 0;

/**
 * Run the prompt once on `place` (the asker's login: their container, or the host for the server login's owner, as
 * ultra reviews do) and return the model's text. `cwd` is a scratch folder the place can see. The Settings repeat
 * check (src/instructions-save.ts) runs its Sonnet call here too, with a shorter timeout.
 */
export async function runDescribe(place: TurnPlace, prompt: string, o: { claudeBin: string; hostEnv: Record<string, string>; cwd: string; timeoutMs?: number }): Promise<string> {
  let argv: string[];
  let env: Record<string, string>;
  if (place.host) {
    mkdirSync(o.cwd, { recursive: true });
    argv = [o.claudeBin, ...ARGS];
    env = place.env ? { ...Object.fromEntries(Object.entries(o.hostEnv).filter(([k]) => !AUTH_VARS.includes(k))), ...place.env } : o.hostEnv;
  } else {
    await place.ensure();
    const cenv = Object.entries(place.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    argv = ['podman', 'exec', '-i', '-w', place.turnsDir, ...cenv, place.container, resolveClaude(o.claudeBin), ...ARGS];
    env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
    running.set(place.container, describesIn(place.container) + 1);
  }
  try {
    const out = await new Promise<string>((done, fail) => {
      const child = execFile(argv[0], argv.slice(1), { cwd: place.host ? o.cwd : undefined, env, timeout: o.timeoutMs ?? TIMEOUT_MS, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
        if (err && !stdout) fail(new Error(`The agent didn't answer: ${(stderr || err.message).trim().split('\n').pop()?.slice(0, 300)}`));
        else done(stdout);
      });
      child.stdin?.end(prompt);
    });
    let r: any;
    try {
      r = JSON.parse(out);
    } catch {
      throw new Error(`The agent didn't answer: ${out.trim().slice(0, 300)}`);
    }
    if (r?.is_error || typeof r?.result !== 'string') throw new Error(`The agent didn't answer: ${String(r?.result ?? r?.subtype ?? 'no result').slice(0, 300)}`);
    return r.result;
  } finally {
    if (!place.host) running.set(place.container, describesIn(place.container) - 1);
  }
}
