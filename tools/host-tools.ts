// The server's host tools (#1147): `install` puts every tool in deploy/host-tools.json on this box (a rebuild, or a
// move off perigee), printing the Arch packages a person installs; `check` says where the box differs from the list.
//   node tools/host-tools.ts install|check
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { installCommand, installEnv, installTool, LIVE_MANIFEST, manifestProblems, miseBin, readManifest, toolLabel, type MiseList } from '../src/host-tools.ts';

const list = readManifest(LIVE_MANIFEST);
const verb = process.argv[2];
if (verb === 'install') {
  let failed = 0;
  for (const t of list) {
    if (t.source === 'pacman') {
      console.log(`by hand: ${installCommand(t)}`);
      continue;
    }
    const r = await installTool(t);
    console.log(`${r.ok ? 'installed' : 'FAILED'} ${toolLabel(t)}${r.ok ? '' : `\n${r.output}`}`);
    if (!r.ok) failed++;
  }
  process.exit(failed ? 1 : 0);
} else if (verb === 'check') {
  const home = homedir();
  const mise: MiseList = list.some((t) => t.source !== 'pacman') ? JSON.parse(execFileSync(miseBin(home), ['ls', '--json'], { cwd: home, env: installEnv(home), encoding: 'utf8' })) : {};
  const pacman = (pkg: string) => {
    try {
      return execFileSync('pacman', ['-Q', pkg], { encoding: 'utf8' }).trim().split(' ')[1] ?? '';
    } catch {
      return null;
    }
  };
  const problems = manifestProblems(list, mise, pacman);
  console.log(problems.length ? problems.join('\n') : `all ${list.length} host tools are installed`);
  process.exit(problems.length ? 1 : 0);
} else {
  console.error('usage: node tools/host-tools.ts install|check');
  process.exit(2);
}
