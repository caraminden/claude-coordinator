// A folder a verifier drives a checkout of Citadel from (#1740): boot.mjs, its state kit and stubs for the box's
// services. The escape-set harness (run.ts) sets one up per case; the opt-in verifier's Grunt sets one up on a
// minion's worktree:
//   node tools/review-escapes/verifier-copy.ts <scratch folder>
import { chmodSync, copyFileSync, existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const HERE = import.meta.dirname;
// What the box's services would do, refused: a verifier and the old server it boots reach none of them.
export const SHIMMED = ['systemctl', 'loginctl', 'journalctl', 'systemd-run', 'gh', 'podman', 'docker', 'tailscale', 'crontab', 'sudo'];

/** Put the boot helper, the stand-in claude, the clock and the stubs in `dir`; `dir`/repo is the checkout it boots. */
export function setUpCopy(dir: string): void {
  mkdirSync(join(dir, 'shims'), { recursive: true });
  for (const [from, to] of [
    ['verifier-boot.mjs', 'boot.mjs'],
    ['fake-claude.mjs', 'fake-claude.mjs'],
    ['verifier-clock.mjs', 'clock.mjs'],
  ])
    copyFileSync(join(HERE, from), join(dir, to));
  chmodSync(join(dir, 'fake-claude.mjs'), 0o755);
  for (const s of SHIMMED) writeFileSync(join(dir, 'shims', s), `#!/bin/sh\necho "${s}: stubbed in this verifier case (#1740)" >&2\nexit 1\n`, { mode: 0o755 });
}

if (import.meta.main) {
  const repo = realpathSync(join(HERE, '../..'));
  const dir = process.argv[2] ? resolve(process.argv[2]) : '';
  if (!dir || dir === repo || dir.startsWith(repo + '/')) {
    console.error('usage: node tools/review-escapes/verifier-copy.ts <scratch folder outside the repo>');
    process.exit(1);
  }
  setUpCopy(dir);
  if (!existsSync(join(dir, 'repo'))) symlinkSync(repo, join(dir, 'repo'));
  console.log(`Ready: ${dir} boots ${repo}.
- node ${dir}/boot.mjs start [--fresh] --turns [--clock <iso>]: a real server on empty data (${dir}/data), signed in as the admin. Then: set -a; . ${dir}/dev.env; set +a; curl -s -H "Cookie: \$DEV_COOKIE" "\${DEV_URL}api/..."
- Turns run a stand-in claude, scripted one line a turn in ${dir}/fake/turns.jsonl, all keys optional: {"ticket": 2, "outcome": "success|usage_limit|not_logged_in|error|crash", "text": "...", "delayMs": 15000, "tools": [{"name": "ask_question", "arguments": {}}]}. fake/calls.jsonl shows what each turn was sent.
- Make minions: POST api/projects {"name":"A","source":"none"}, POST api/projects/<id>/tickets {"title":"t","message":"hi"}, POST api/tickets/<id>/messages {"text":"..."}.
- node ${dir}/boot.mjs restart (turns keep running), person <login> (DEV_COOKIE_<LOGIN>), stop. Only Date moves with --clock: not SQL's datetime('now').
- Rows straight into ${dir}/data/coordinator.db with sqlite3, then restart. Pages: node ${repo}/tools/ui-shot.ts '#/<route>' with dev.env loaded.`);
}
