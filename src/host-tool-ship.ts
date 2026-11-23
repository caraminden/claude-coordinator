// An approved host tool (#1147): installed now, then its line in deploy/host-tools.json shipped by the server itself
// (Josh, 2026-11-19, "The server ships it"), through a small chore minion in the Citadel scheme whose branch holds that
// one commit and whose land is handed off like any minion's: a clean land dismisses it, a failed one wakes it to fix.
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pickFor } from '../public/model-table.js';
import { APP_NAME } from './appname.ts';
import { pacificDay } from './pacific.ts';
import { landPhase } from './land.ts';
import { GLOBAL_OWNER } from './properties.ts';
import { identity } from './scheme-repo.ts';
import { installCommand, installTool, MANIFEST, manifestText, readManifest, toolLabel, withTool, type HostTool } from './host-tools.ts';
import type { App } from './http.ts';

const git = (args: string[], cwd: string) => new Promise<void>((done, fail) => execFile('git', args, { cwd }, (err, _o, stderr) => (err ? fail(new Error(`git ${args[0]}: ${stderr || err.message}`)) : done())));

/** Runs behind the approve: the asking minion hears how it went, and the chore minion ships the line. Never throws. */
export async function approveHostTool(app: App, askingId: number, t: HostTool, by: string): Promise<void> {
  const { store, runner } = app;
  const tell = (text: string) => runner.send(askingId, APP_NAME, text);
  const label = toolLabel(t);
  try {
    const byHand = t.source === 'pacman';
    if (!byHand) {
      const r = await installTool(t);
      if (!r.ok) return tell(`Installing ${label} failed, so nothing is listed (the card stays approved; propose it again once you know why):\n\`\`\`\n${r.output}\n\`\`\``);
    }
    const asking = store.getTicket(askingId);
    const scheme = asking && store.getProject(asking.project_id);
    const citadel = store.getProject(GLOBAL_OWNER);
    if (!citadel?.repo_dir) return tell(`${byHand ? 'Approved' : `Installed ${label}`}, but there's no ${APP_NAME} scheme repo to list it in: tell your Taskmaster.`);
    const { id, number, cwd } = await app.newMinion(citadel, { title: `List host tool ${label}`, props: { type: 'chore' }, ...pickFor('chore') }, APP_NAME);
    const chore = { ...store.getTicket(id)!, cwd };
    const file = join(cwd, MANIFEST);
    writeFileSync(file, manifestText(withTool(readManifest(file), { ...t, approved_by: by, approved_on: pacificDay(Date.now()), asked_by: `${scheme?.name ?? '?'} #${asking?.number ?? '?'}` })));
    await git([...await identity(chore.cwd!), 'commit', '--quiet', '-m', `#${number}: list host tool ${label}, approved by ${by} for ${scheme?.name ?? '?'} #${asking?.number ?? '?'}`, '--', MANIFEST], cwd);
    runner.emit(id, 'note', { text: `This minion ships one line: ${label} in ${MANIFEST}, which ${by} approved for ${scheme?.name ?? '?'} #${asking?.number ?? '?'} (${byHand ? 'an Arch package a person installs by hand' : 'installed already'}). Its commit is on this branch; if the ship fails, rebase onto main keeping every other line of the list, and hand it off again.` });
    const handed = app.landings.handOff(id, cwd, runner.hostEnv(chore), [], { summary: `List host tool ${label}`, risk: 'low', reason: `one line in ${MANIFEST}; the tool is ${byHand ? 'installed by hand' : 'installed already'}`, deploy: false });
    if (handed) {
      store.updateTicket(id, { state: 'outside', note: landPhase('') });
      runner.broadcastTicket(id);
    }
    const ship = `Its line in the host tools list ships with ${citadel.name} #${number}.`;
    tell(byHand
      ? `Approved ${label}, but the server has no root, so it isn't installed yet: ask a person with a card (to: cara, who runs perigee) to run this in a fish shell on perigee:\n\`\`\`fish\n${installCommand(t)}\n\`\`\`\n${ship}`
      : `Installed ${label} on the server (\`${installCommand(t)}\`): its command is on your PATH from your next turn. ${ship}`);
  } catch (err: any) {
    tell(`${label} was approved, but listing it failed: ${err?.message ?? err}. Tell your Taskmaster: the tool ${t.source === 'pacman' ? 'still needs a person to install it' : 'may be installed but is not listed'}.`);
  }
}
