# GPU jobs on a desktop (#858)

A contraption queues a **job** (a container image pinned by digest, a command, input files) on a person's own
computer, and the machine agent there runs it on the GPU with podman, sends back what it wrote to `/out`, and
reports its state every 10 s. The design is the shared folder's `specs/desktop-gpu-jobs.md`; the app's side is
`src/machine-jobs.ts`, the agent's is the "GPU jobs" section of `public/machine-agent.mjs`.

| | |
|---|---|
| Where | the WSL distro `citadel-jobs` on the owner's Windows PC, cut off from Windows (no `C:`, no Windows programs) |
| Agent | the ordinary machine agent, installed inside that distro as the owner's own user (not root), a systemd user unit |
| Container | rootless podman, one job at a time, `--network none` unless the kind asks for it, no capabilities, the owner's uid inside |
| A job sees | `/in` (its inputs, read-only), `/out`, `/state` (its checkpoints), `/cache` (its kind's model downloads, kept between jobs), `/private/<name>` (the owner's folders the kind names, read-only) |
| Leaves the PC | the files in `/out` and the job's log, nothing else; a link in `/out` that points outside it is listed, never read |
| Kept up by | the logon task **Citadel WSL citadel-jobs** (`tools/ci-runner/keep-wsl-up.ps1 -Distro citadel-jobs`) |

The owner's `jobs` block in `machine-agent.json` is the outer wall: whatever the app sends, a job reads only the
folders listed there, runs at most `max_limit_h` hours of running time (paused time doesn't count) and the jobs
folder holds at most `max_disk_gb`. Without the block every job is refused. A refused job shows its reason in the
app ("Refused by the machine: …").

## Set it up (once, on the PC)

Nothing here needs Administrator or a reboot. Proven by hand in the desktop spike (#856, 2026-11-17,
`reports/gpu-jobs-desktop-spike.md`), except where a step says it is new.

1. **The distro.** In a normal PowerShell:

   ```powershell
   wsl --install Ubuntu-24.04 --name citadel-jobs
   ```

   Give the UNIX user `cara`. It opens a shell in the distro when it's done: type `exit`.

2. **Cut it off from Windows and mount only the folders jobs may read.** Open a root shell in the distro from
   PowerShell:

   ```powershell
   wsl -d citadel-jobs -u root
   ```

   Then, in that root shell, write `/etc/wsl.conf` and one `/etc/fstab` line per Windows folder (a space in a
   Windows path is written `\040`, or the line is skipped without a word):

   ```wsl
   cat > /etc/wsl.conf <<'EOF'
   [boot]
   systemd=true
   [automount]
   enabled=false
   mountFsTab=true
   [interop]
   enabled=false
   appendWindowsPath=false
   EOF
   mkdir -p /mnt/private/chapters
   cat >> /etc/fstab <<'EOF'
   C:\Users\Cara\Claude\040Workspace\audiobook-pilot\work\audio /mnt/private/chapters drvfs defaults,ro 0 0
   EOF
   ```

   Type `exit`, then restart the distro from PowerShell:

   ```powershell
   wsl --terminate citadel-jobs
   ```

3. **podman and the GPU.** Root shell again (`wsl -d citadel-jobs -u root`), then:

   ```wsl
   apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg2 podman uidmap slirp4netns fuse-overlayfs nodejs
   curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
   curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' > /etc/apt/sources.list.d/nvidia-container-toolkit.list
   apt-get update && apt-get install -y nvidia-container-toolkit
   mkdir -p /etc/cdi && nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml
   loginctl enable-linger cara
   exit
   ```

   `loginctl enable-linger` keeps `cara`'s services (the agent) running with nobody logged in to the distro.
   ([NVIDIA's toolkit install guide](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
   says more.) After a Windows driver update, run the `nvidia-ctk cdi generate` line again if GPU jobs fail to start.

4. **Check the GPU from a container**, as `cara` (`wsl -d citadel-jobs`):

   ```wsl
   podman run --rm --device nvidia.com/gpu=all --security-opt=label=disable docker.io/nvidia/cuda:12.8.1-base-ubuntu24.04 nvidia-smi
   ```

   It prints the GPU's table.

5. **The agent.** On Citadel's Machines page, press **Add a machine**, name it `cara-desktop-jobs`, pick the
   **GPU jobs (WSL)** tab and press **Copy**. Paste the line in the distro as `cara` (`wsl -d citadel-jobs`), not
   root. It installs the agent as a systemd user unit and prints how to watch its log. If it can't reach Citadel,
   WSL's network isn't reaching the tailnet: the fix in `tools/ci-runner/README.md` ("Linux runners in WSL", step 3,
   `networkingMode=mirrored`) applies here too. *New: the agent has not run in this distro yet.*

6. **The jobs block.** Still as `cara` in the distro:

   ```wsl
   mkdir -p ~/citadel-jobs
   cat > ~/coordinator-agent/machine-agent.json <<'EOF'
   {
     "jobs": {
       "dir": "/home/cara/citadel-jobs",
       "folders": { "chapters": "/mnt/private/chapters" },
       "max_limit_h": 12,
       "max_disk_gb": 100,
       "gpu": true
     }
   }
   EOF
   ```

   The agent reads it within seconds (no restart) and the Machines page shows the folders it offers. `dir` holds
   each job's folder (`<id>/in`, `out`, `state`, `job.json`, `job.log`) and the per-kind `cache`; keeping it inside
   the distro, not on a `/mnt` folder, keeps it fast. The oldest finished jobs' folders are deleted when a new job
   needs the room under `max_disk_gb`.

7. **Keep it up.** In a normal PowerShell, with Citadel's machines address filled in:

   ```powershell
   $u = 'http://perigee.tail59477f.ts.net:8574'; iwr "$u/ci-runner/keep-wsl-up.ps1" -UseBasicParsing -OutFile "$env:TEMP\keep-wsl-up.ps1"; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\keep-wsl-up.ps1" -Distro citadel-jobs
   ```

   It registers the task **Citadel WSL citadel-jobs**, which starts the distro at every logon and holds it up.

## Changing the folders

Edit `/etc/fstab` (root) and the block's `folders` together. Rootless containers don't see a mount added after the
distro started, so restart it: `wsl --terminate citadel-jobs` in PowerShell, then run step 7's line again. The agent
says so in its log when the folders change.

## What a job's image must do

- Be pinned by digest (`ghcr.io/…@sha256:…`). A locally built image has only an id: push it to a registry first.
- Run as any uid: the container runs as the owner's uid with `HOME=/tmp`, so write only to `/out`, `/state`,
  `/cache` and `/tmp`. Model downloads go to `XDG_CACHE_HOME=/cache` (Hugging Face and torch hub follow it).
- A `resumable` kind is paused by SIGTERM with 60 s grace and started again with `CITADEL_JOB_RESUME=1`; it must
  skip work already in `/out` or `/state` itself (stock WhisperX starts over). Other kinds are frozen with
  `podman pause`, which keeps their VRAM held.
- Write finished files under their final names; a name ending in `.part` is never uploaded.

## What has been tested

On perigee (#858): `test/machine-agent-jobs.test.ts` drives the runner against a fake podman, a fake `nvidia-smi` and a
stand-in for the app's job routes: every refusal, the exact `podman run` arguments, links out of `/out`, the time
limit with paused time left out, pause both ways, stop, and picking jobs up again after an agent restart.
On the desktop (#856): podman, the GPU, `podman pause`, SIGTERM and the folder wall, by hand, as root inside the
container. **Not yet tried:** the agent itself in the distro, a job running as the owner's uid (`--userns
keep-id`) writing to `/out` and `/cache`, and what happens when Windows sleeps (the job dies with the distro; the
agent reports it failed when it comes back).
