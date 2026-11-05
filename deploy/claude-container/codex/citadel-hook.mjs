// Citadel's tripwire for Codex (#330): the managed PreToolUse hook in /etc/codex/requirements.toml of
// every person's container. Codex skips a hook that crashes, times out or answers "ask", so this one
// fails closed: anything but a clean pass exits 2, which is the only answer Codex treats as a block.
//
// The command in requirements.toml stays static (Codex un-trusts an edited one); the turn's tripwire
// config comes from the JSON file $CITADEL_CODEX_TRIPWIRE names, written by the runner for every turn:
// { script: <the turn's pinned src/tripwire.ts>, config: <its TripwireConfig> }.
// Codex here is Citadel's read-only reviewer (src/codex-review.ts), so only shell commands run, and
// the tripwire's ask tier (a person's card) is a plain block.
import { readFileSync } from 'node:fs';

function deny(why) {
  process.stderr.write(`[tripwire] ${why}\n`);
  process.exit(2);
}

try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const file = process.env.CITADEL_CODEX_TRIPWIRE;
  if (!file) deny('Codex runs in a Citadel container only through citadel-codex-review, which brings the tripwire config (CITADEL_CODEX_TRIPWIRE is not set).');
  const { script, config } = JSON.parse(readFileSync(file, 'utf8'));
  const tool = String(input?.tool_name ?? '');
  if (tool !== 'Bash') deny(`${tool || 'This tool'} is off: Citadel's Codex reviewer is read-only and runs shell commands only.`);
  const { tripwire } = await import(script);
  const v = tripwire(input, { ...config, ask: false });
  if (v) deny(`${v.reason}\n[tripwire] This guard stops known accidents in Citadel (src/tripwire.ts). If a person really wants this, they can run it themselves.`);
  process.exit(0);
} catch (err) {
  deny(`The hook failed, so the call is blocked: ${err?.message ?? err}`);
}
