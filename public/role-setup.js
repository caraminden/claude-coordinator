// A role's Set up and self-test (Build 7 M4, specs/machine-connections.md section 3; Josh, 2026-11-25: "Agent, on Set
// up"): what the page and the server share. An agent reports which of these fixed needs its PC lacks, never a command:
// the command the owner runs as administrator is made here, from these words only, so a machine's token can't put a
// command of its own in front of its owner. No DOM: src/role-setup.ts imports it too.

/** @import { SetupAdmin, SetupRun } from './types.js' */

/** The roles whose Set up and Test this release runs. */
export const SETUP_ROLES = ['tools', 'screen', 'turns', 'gpu', 'ci', 'builds'];

/** What a step needs done as administrator, by key: the words people read and, per package manager, the command. */
/** @type {Record<string, { what: string, os: 'windows' | 'linux' }>} */
export const ADMIN_NEEDS = {
  wsl: { what: 'WSL 2', os: 'windows' },
  runner: { what: 'the CI runner agent', os: 'windows' },
  'runner-linux': { what: 'the CI runner agent', os: 'linux' },
  worker: { what: 'the minion worker', os: 'linux' },
  podman: { what: 'podman', os: 'linux' },
  'nvidia-toolkit': { what: "NVIDIA's container toolkit", os: 'linux' },
  cdi: { what: 'the GPU device list containers read (CDI)', os: 'linux' },
};
export const PACKAGE_MANAGERS = ['apt', 'dnf'];

/**
 * The needs the agent puts in its elevate script (One kind of machine H2; Cara, 2026-11-26, "One agent, helpers hidden"):
 * the helpers that run as administrator or root, and WSL. The agent writes that script on its own PC, from these keys,
 * its own address and its own token, at a fixed place beside itself (ELEVATE), so the command the card shows is always
 * the same words: nothing from the agent's report goes in it.
 */
export const SCRIPT_NEEDS = ['wsl', 'runner', 'runner-linux', 'worker'];
/** Where the agent writes its elevate script: the folder Connect a computer installs it in (machine-setup.js). */
export const ELEVATE = { windows: '$env:USERPROFILE\\coordinator-agent\\elevate.ps1', linux: '~/coordinator-agent/elevate.sh' };
/**
 * The script's whole path as the agent says it wrote it, kept only when it is one of these: plain letters, digits and
 * `_ .()-` in its folders, ending in ELEVATE's folder and file. The card puts it in quotes so that an administrator
 * who signs in with another account (whose profile isn't the agent's) still runs the right file.
 */
const ELEVATE_AT = { windows: /^[A-Za-z]:\\(?:[A-Za-z0-9 _.()-]+\\)+coordinator-agent\\elevate\.ps1$/, linux: /^\/(?:[A-Za-z0-9_.-]+\/)+coordinator-agent\/elevate\.sh$/ };

/** @type {Record<string, Record<string, string>>} */
const LINUX = {
  podman: { apt: 'sudo apt-get install -y podman', dnf: 'sudo dnf install -y podman' },
  'nvidia-toolkit': {
    apt: [
      'curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor --yes -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg',
      "curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list",
      'sudo apt-get update',
      'sudo apt-get install -y nvidia-container-toolkit',
    ].join(' && \\\n'),
    dnf: ['curl -fsSL https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo | sudo tee /etc/yum.repos.d/nvidia-container-toolkit.repo', 'sudo dnf install -y nvidia-container-toolkit'].join(' && \\\n'),
  },
  // The toolkit alone writes no list: podman finds the GPU by it (--device nvidia.com/gpu=all).
  cdi: { apt: 'sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml', dnf: 'sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml' },
};

/**
 * An agent's report of what it lacks, kept only when it is that: known needs of one OS, and a known package manager.
 * @param {unknown} v
 * @returns {SetupAdmin | null}
 */
export function cleanAdmin(v) {
  if (!v || typeof v !== 'object') return null;
  const given = /** @type {{ needs?: unknown, pm?: unknown, script?: unknown, at?: unknown }} */ (v);
  const script = given.script === true;
  // A helper's install has no page-made command: only the agent's script runs it.
  /** @type {string[]} */
  const needs = Array.isArray(given.needs) ? [...new Set(given.needs.filter((/** @type {unknown} */ n) => typeof n === 'string' && Object.hasOwn(ADMIN_NEEDS, n) && (script || n === 'wsl' || !SCRIPT_NEEDS.includes(n))))] : [];
  if (!needs.length || new Set(needs.map((n) => ADMIN_NEEDS[n].os)).size > 1) return null;
  const pm = typeof given.pm === 'string' && PACKAGE_MANAGERS.includes(given.pm) ? given.pm : null;
  // The toolkit comes before the list it makes, and podman before both.
  const order = Object.keys(ADMIN_NEEDS);
  // `script`: the agent wrote its elevate script with every need of SCRIPT_NEEDS listed here (an agent from before writes none).
  const held = script && needs.some((n) => SCRIPT_NEEDS.includes(n));
  const os = /** @type {'windows' | 'linux'} */ (ADMIN_NEEDS[needs[0]].os);
  const at = held && typeof given.at === 'string' && ELEVATE_AT[os]?.test(given.at) ? given.at : null;
  return { needs: needs.sort((a, b) => order.indexOf(a) - order.indexOf(b)), pm, ...(held ? { script: true } : {}), ...(at ? { at } : {}) };
}

/**
 * The one command for what a PC lacks, with where it runs ('powershell-admin' or 'bash'), and what follows it; null
 * when a need has no command for that PC (a package manager other than apt and dnf), which `manual` then says.
 * @param {unknown} admin
 * @returns {{ tag: 'powershell-admin' | 'bash' | null, command: string | null, what: string, after: string } | null}
 */
export function adminCommand(admin) {
  const a = cleanAdmin(admin);
  if (!a) return null;
  const names = a.needs.map((n) => ADMIN_NEEDS[n].what);
  const what = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
  const windows = ADMIN_NEEDS[a.needs[0]].os === 'windows';
  // One paste for every role (H2): the agent's script, which holds each need that has one, the restart after WSL said in it.
  if (a.script && windows) return { tag: 'powershell-admin', command: `powershell -NoProfile -ExecutionPolicy Bypass -File ${a.at ? `'${a.at}'` : `"${ELEVATE.windows}"`}`, what, after: a.needs.includes('wsl') ? 'Then restart the PC and press Set up again.' : 'Citadel waits for it to connect, then tests it.' };
  if (a.script) {
    // Packages without a script of their own (podman, the GPU toolkit) go first, as page-made words, in the same paste.
    const rest = a.needs.filter((n) => !SCRIPT_NEEDS.includes(n));
    const file = a.at ? `'${a.at}'` : ELEVATE.linux;
    if (rest.length && !a.pm) return { tag: null, command: null, what, after: `This PC has neither apt nor dnf: install ${rest.map((n) => ADMIN_NEEDS[n].what).join(' and ')} its own way, then run sudo bash ${file} and press Set up again.` };
    const pm = a.pm ?? 'apt';
    return { tag: 'bash', command: [...rest.map((n) => LINUX[n][pm]), `sudo bash ${file}`].join(' && \\\n'), what, after: 'Citadel waits for it to connect, then tests it.' };
  }
  if (a.needs[0] === 'wsl') return { tag: 'powershell-admin', command: 'wsl --install --no-distribution', what, after: 'Then restart the PC and press Set up again.' };
  if (!a.pm) return { tag: null, command: null, what, after: `This PC has neither apt nor dnf: install ${what} its own way, then press Set up again.` };
  const pm = a.pm;
  return { tag: 'bash', command: a.needs.map((n) => LINUX[n][pm]).join(' && \\\n'), what, after: 'Then press Set up again.' };
}

/**
 * A role's last run as its card reads it from the row (machine_roles.setup.run), or null.
 * @param {{ setup?: Record<string, unknown> | null } | null | undefined} r
 * @returns {SetupRun | null}
 */
export const lastRun = (r) => (r?.setup && typeof r.setup.run === 'object' ? /** @type {SetupRun | null} */ (r.setup.run) : null);
