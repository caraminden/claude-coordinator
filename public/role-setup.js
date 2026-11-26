// A role's Set up and self-test (Build 7 M4, specs/machine-connections.md section 3; Josh, 2026-11-25: "Agent, on Set
// up"): what the page and the server share. An agent reports which of these fixed needs its PC lacks, never a command:
// the command the owner runs as administrator is made here, from these words only, so a machine's token can't put a
// command of its own in front of its owner. No DOM: src/role-setup.ts imports it too.

/** The roles whose Set up and Test this release runs (CI's are #2064's, after one row per PC). */
export const SETUP_ROLES = ['tools', 'screen', 'turns', 'gpu'];

/** What a step needs done as administrator, by key: the words people read and, per package manager, the command. */
export const ADMIN_NEEDS = {
  wsl: { what: 'WSL 2', os: 'windows' },
  podman: { what: 'podman', os: 'linux' },
  'nvidia-toolkit': { what: "NVIDIA's container toolkit", os: 'linux' },
  cdi: { what: 'the GPU device list containers read (CDI)', os: 'linux' },
};
export const PACKAGE_MANAGERS = ['apt', 'dnf'];

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

/** An agent's report of what it lacks, kept only when it is that: known needs of one OS, and a known package manager. */
export function cleanAdmin(v) {
  if (!v || typeof v !== 'object') return null;
  const needs = Array.isArray(v.needs) ? [...new Set(v.needs.filter((n) => typeof n === 'string' && Object.hasOwn(ADMIN_NEEDS, n)))] : [];
  if (!needs.length || new Set(needs.map((n) => ADMIN_NEEDS[n].os)).size > 1) return null;
  const pm = PACKAGE_MANAGERS.includes(v.pm) ? v.pm : null;
  // The toolkit comes before the list it makes, and podman before both.
  const order = Object.keys(ADMIN_NEEDS);
  return { needs: needs.sort((a, b) => order.indexOf(a) - order.indexOf(b)), pm };
}

/**
 * The one command for what a PC lacks, with where it runs ('powershell-admin' or 'bash'), and what follows it; null
 * when a need has no command for that PC (a package manager other than apt and dnf), which `manual` then says.
 */
export function adminCommand(admin) {
  const a = cleanAdmin(admin);
  if (!a) return null;
  const names = a.needs.map((n) => ADMIN_NEEDS[n].what);
  const what = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
  if (a.needs[0] === 'wsl') return { tag: 'powershell-admin', command: 'wsl --install --no-distribution', what, after: 'Then restart the PC and press Set up again.' };
  if (!a.pm) return { tag: null, command: null, what, after: `This PC has neither apt nor dnf: install ${what} its own way, then press Set up again.` };
  return { tag: 'bash', command: a.needs.map((n) => LINUX[n][a.pm]).join(' && \\\n'), what, after: 'Then press Set up again.' };
}

/** A role's last run as its card reads it from the row (machine_roles.setup.run), or null. */
export const lastRun = (r) => (r?.setup && typeof r.setup.run === 'object' ? r.setup.run : null);
