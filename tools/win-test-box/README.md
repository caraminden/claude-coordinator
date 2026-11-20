# Citadel's Windows test box

A Hyper-V VM on Cara's gaming PC (DESKTOP-G248IJ8) for native-app schemes (#369):
- **Its screen is always there.** It signs itself in at every start and can never lock, sleep or blank its screen, so screen reads and capture work with Cara's own PC locked, after a reboot, and with nobody at it.
- **It looks like her PC where tests care:** 125% scaling and Windows 11's rounded corners. The corners are forced on, because Hyper-V's display adapter draws square ones otherwise.
- **It draws on the CPU (WARP), not her RTX 5080, unless a job asks for the GPU.** Cara picked WARP on 2026-11-07, when GPU-P looked unsupported on GeForce cards. Josh picked a GPU for jobs that ask on 2026-11-19 (Peek Auras #636, #1175): once `gpu-host.ps1` has run, the `run-gpu` task turns her GPU on in the box for that one job. Everything else still draws in software, so golden pictures don't change ([A GPU for jobs that ask](#a-gpu-for-jobs-that-ask)).
- **It runs Windows 11 Home, unactivated** (Cara's pick, 2026-11-07). Windows may add an "Activate Windows" watermark in its bottom-right corner; the first screenshots (2026-11-10) had none.
- **Two kinds of user share one screen** through one lock, `C:\citadel-box\screen.lock`:
  - **CI:** each scheme's GitHub **desktop runner** (the `<slug>-desktop` label) runs its desktop jobs here.
  - **Minions:** Citadel's **machine agent** lends them the box's tools, so they can sync a branch, run a command, launch the app, take a screenshot and stop it (the `citadel:run-on-windows` skill).

  Whoever comes second waits: a CI job queues for up to 40 minutes, and a minion is told who has the screen. **One box serves every native-app scheme** (Cara's pick, 2026-11-07).

## What it costs her PC

| | |
|---|---|
| Memory | 8 GB, held the whole time the box runs |
| Processors | at most 6 of her 32 threads, capped at 75% and at a low weight. Used only while a CI desktop job or a minion's run is going; under 2% idle |
| GPU | none, unless `gpu-host.ps1` has run. Then only while a `run-gpu` job runs (one at a time, 30 minutes at most): the GPU time it draws, and the graphics memory it allocates out of her 16 GB. The partition asks for at most half, but GeForce drivers aren't known to enforce that, so a heavy job could slow a game she's playing. Nothing at all between those jobs, and none while GPU jobs are switched off on Citadel's Machines page |
| Disk | a 120 GB disk that grows as it fills: about 60–90 GB in use once a scheme's toolchain and builds are in |
| Starting up | 2 minutes after her PC starts, taking its 8 GB at once. Nothing ever shows on her screen |
| Games | If "Virtualization-based security" was already running (the Windows 11 default; `new-test-box.ps1` says), the hypervisor was already under her games and the box adds about nothing. If it was off, published numbers for turning the hypervisor on are 1–10% average FPS, more in the 1% lows. Those numbers come from older CPUs |

**Pausing it while she plays:** in PowerShell as administrator, `Save-VM citadel-test-box`. That frees all 8 GB and the processors in about 10 s. `Start-VM citadel-test-box` brings it back as it was. While it's saved, CI desktop jobs queue and minions find the machine offline. Once the box has a GPU partition, Hyper-V may refuse to save it: then `Stop-VM citadel-test-box` (a clean shutdown, about a minute) and `Start-VM citadel-test-box` later, which starts it fresh.

## Setting it up (once)

Everything is on her PC. Nothing here restarts it except step 1's restart, which she does herself when it suits her. Nothing touches Delve's runners or any existing `C:\actions-runner*` folder. About 20 minutes of her hands, about 2 hours in all, plus a night for step 9.

0. **Check the PC** (PowerShell as administrator; 2 min). Get the kit:

   ```powershell
   git clone --depth 1 https://github.com/caraminden/claude-coordinator "$env:TEMP\citadel-kit"
   cd "$env:TEMP\citadel-kit\tools\win-test-box"
   powershell -ExecutionPolicy Bypass -File .\new-test-box.ps1 -CheckOnly
   ```

   It prints the edition, whether Hyper-V is on, whether VBS is running, free memory and disk. It stops at the first thing missing and says what to do.

1. **Turn Hyper-V on** if step 0 said it's off (5 min, plus a restart):

   ```powershell
   Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -All -NoRestart
   ```

   Then **restart the PC yourself**, at the PC, in case it asks for anything (a BitLocker key, say).

2. **Get the Windows 11 ISO.** Use Microsoft's Windows 11 download page, "Download Windows 11 Disk Image (ISO)", multi-edition, about 6 GB (15 min of waiting).

3. **Build the box** (3 min of hands, then 30–60 min on its own):

   ```powershell
   cd "$env:TEMP\citadel-kit\tools\win-test-box"
   powershell -ExecutionPolicy Bypass -File .\new-test-box.ps1 -IsoPath "$env:USERPROFILE\Downloads\<the ISO>.iso"
   ```

   - **Disk and VM:** it applies Windows 11 Home to a new disk with no Setup screens, creates the VM `citadel-test-box`, starts it and waits while `guest-setup.ps1` sets it up inside. That covers sign-in, never locking, 125%, the corners, Git, Node, mise and Tailscale. The box restarts itself once.
   - **Its password:** at the end it prints the box's sign-in, `citadel` and a password. Keep it in a password manager, then delete the `citadel-test-box.password.txt` it names.
   - **Options:** `-MemoryGB`, `-Cpus`, `-DiskGB`, `-Width`/`-Height` (default 1920x1080).
   - **If it stops:** run it again. Once the VM exists it picks up where it was. If it stopped before that, it says which half-made disk to delete first.
   - **"I:\ is not accessible" popups** while it makes the disk are Explorer noticing a partition before it's formatted. Click OK; the script carries on.

4. **Open the box's window:** Hyper-V Manager, `citadel-test-box`, **Connect**. If it offers a size or "enhanced session", close that dialog: it's a basic session, the only kind that never locks the box.

   **Typing commands into the box:** a basic session has no shared clipboard, and its Clipboard → Type clipboard text refuses long lines and repeats keys. Use PowerShell Direct from her PC instead, in PowerShell as administrator; Ctrl+V works there because the window is her PC's:

   ```powershell
   $cred = Get-Credential citadel   # the box's password from step 3
   Enter-PSSession -VMName citadel-test-box -Credential $cred
   ```

   The prompt becomes `[citadel-test-box]: PS ...>`, as administrator in the box; `exit` leaves. Enhanced session isn't an option: Windows 11 Home has no Remote Desktop host.

5. **Sign Tailscale in**, in the box (3 min). The Tailscale icon by the clock in the box, then **Log in**, then sign in in the browser it opens. It's how the box reaches Citadel.

6. **Lend it to Citadel** (2 min):
   - On Citadel's **Machines** page, add a machine named `citadel-test-box`, MCP server **None**, no folder.
   - Open its line, add the native-app schemes (Peek Auras) under **Who gets it**, and switch its **Workspace tools** on. A new machine is lent to no scheme until you add one.
   - Copy its **Windows** lines, open PowerShell in the box (not as administrator), and paste them. They should end with "It runs in the background now".

7. **Add each scheme** (PowerShell **as administrator** in the box; 2 min of hands each, plus a toolchain download):

   ```powershell
   powershell -ExecutionPolicy Bypass -File C:\citadel-box\add-scheme.ps1 -Repo caraminden/peek-auras
   ```

   (The box keeps Windows' default execution policy, so calling the script directly is refused.)

   - **The deploy key:** it prints a read-only deploy key and the GitHub page to paste it on, then waits. Paste it there, then press Enter.
   - **The rest is automatic:** it clones the repo into `C:\work\peek-auras`, installs the repo's tools with mise and gives the machine agent a `peek-auras` workspace. That workspace has two tasks, `run` (on the screen) and `build` (off it).
   - **The scheme's desktop runner:** add it in the box with the scheme's own runner setup, as a session runner on the box's own desktop with no build runners. For Peek Auras, see its `docs/windows-ci.md`: `setup-runner.ps1 -Scheme "Peek Auras" -CitadelUrl <address> -Builders 0 -Visible -WithMsvc`. `-WithMsvc` puts in the C++ build tools that the Rust builds need too. Peek's script needs `-Builders 0` support first (asked of Peek Auras on 2026-11-07).
   - **Hooks and restart:** run `add-scheme.ps1` again (the same `powershell -ExecutionPolicy Bypass -File` line) for the screen-lock hooks, then restart the box with `Restart-Computer` inside it. That restarts the box only, never her PC.
   - **Take her desktop off:** remove the scheme's old desktop runner on her own desktop (`-Visible`, the `<PC>-desktop` runner). Two runners with the same label would split the jobs between her screen and the box.

8. **Close the box's window.** Don't sign out of the box or shut it down from inside it; closing the window leaves it running.

9. **Burn-in:** lock her PC overnight. Next morning, a `desktop.yml` run on any PR must pass its `screen` job, and a minion's `screenshot` must come back with a picture. Step 7's runner removal can wait until this passes.

## Day to day

Nothing to do.
- **Restarts look after themselves.** When her PC restarts, the box starts 2 minutes later, signs itself in, and its runners and agent come back. Windows Update in the box is told not to restart it while it's signed in (installs at 03:00, active hours 06:00–23:00), but Windows 11 Home isn't promised to honour that: an update may still restart it at night, and it signs itself in again.
- **Restart the box gracefully, only ever from inside it:** `Restart-Computer` in the box, or from her PC `Invoke-Command -VMName citadel-test-box -Credential $cred { Restart-Computer -Force }` (there `-Force` only closes apps without asking). **Never `Restart-VM -Force` or a plain `Restart-VM`:** that is a hard reset, like pulling the plug. On 2026-11-10 one put the box into Automatic Repair and lost the settings written just before it.
- **Adding a scheme** is step 7 again.
- **After each NVIDIA driver update** on her PC, once the box has its GPU: run `gpu-host.ps1` again ([A GPU for jobs that ask](#a-gpu-for-jobs-that-ask)). The box uses copies of her driver's files, and old copies with a new driver can crash GPU jobs or the box. It takes a few minutes and no restart.
- **Crash dumps are kept** (#549, Josh's pick for Peek Auras #223, 2026-11-11). `guest-setup.ps1` sets Windows Error Reporting LocalDumps: any program that crashes leaves a mini dump (stacks, a few hundred KB to a few MB) in `C:\CrashDumps`, the newest 20 kept, readable by `citadel`, the desktop runner's account. On an already-built box, run `guest-setup.ps1` again or just its "Keeping crash dumps" step.

## A GPU for jobs that ask

Optional, for jobs that need real Direct3D hardware (#1175). Hyper-V gives the box a partition of her GPU, the way Windows Sandbox and WSL do; inside the box it stays switched off, so every job draws in software as before. A job run with the `run-gpu` task (or `gpu.ps1 -Run`) switches it on for itself and off again when it ends. What it costs her: the cost table's GPU row.

- **What it can't do:** HDR and hardware overlays. The box's screen stays Hyper-V's own display adapter, which reports "HDR Support: Not Supported" and a single overlay plane (`dxdiag` in the box, 2026-11-19). The GPU draws; it doesn't drive a screen. A pass there proves Direct3D on real hardware, not HDR or overlays.
- **Microsoft's support:** GPU partitioning is documented for Windows client hosts in the [GPU paravirtualization driver docs](https://learn.microsoft.com/windows-hardware/drivers/display/gpu-paravirtualization); the [Hyper-V GPU partitioning page](https://learn.microsoft.com/windows-server/virtualization/hyper-v/gpu-partitioning) supports only Windows Server with datacenter GPUs. Community reports have RTX 40 cards working; the check below is the first try on an RTX 50.

**Set it up** (PowerShell as administrator on her PC; 2 min to check, about 10 in all). Refresh the kit and check first. `-CheckOnly` changes nothing:

```powershell-admin
$kit = "$env:TEMP\citadel-kit"   # the kit from step 0: refreshed if it's still there, fetched if not
if (-not (Test-Path $kit)) { git clone --depth 1 https://github.com/caraminden/claude-coordinator $kit }
git -C $kit fetch --depth 1 origin main; git -C $kit checkout --detach FETCH_HEAD
powershell -ExecutionPolicy Bypass -File "$kit\tools\win-test-box\gpu-host.ps1" -CheckOnly
```

It names her GPU and driver, and says whether Windows can partition it. If it can't, it stops there and nothing changed: tell Citadel. Then, in the same window:

```powershell-admin
powershell -ExecutionPolicy Bypass -File "$env:TEMP\citadel-kit\tools\win-test-box\gpu-host.ps1"
```

- It asks for the box's password (user `citadel`, from her password manager), copies the driver's files into the box, and asks before the one step with downtime: it shuts the box down cleanly, adds the GPU partition and starts it again (about 3 minutes; a job running then fails and is run again).
- Running it again later (after a driver update) only copies the files again: no restart. It refuses while a GPU job is running.

**Switch GPU jobs off while she plays** (Josh, 2026-11-19: "There should be a switch I can flip that blocks all GPU jobs until unswitched", then "I meant a switch in the citadel UI"). In Citadel, Machines, open `citadel-test-box`: untick **GPU jobs**. It saves at once; nothing on her PC or the box changes. While it's off a `run-gpu` task is refused before it reaches the box, and one already running is stopped at once. Everything else on the box (CI, `run`, `build`) goes on in software. Tick it again to let GPU jobs run.

**Take it off:** in PowerShell as administrator on her PC:

```powershell-admin
Stop-VM citadel-test-box; Remove-VMGpuPartitionAdapter -VMName citadel-test-box; Start-VM citadel-test-box
```

## If something goes wrong

- **A desktop job fails with `BitBlt: Access is denied`, or a minion's screenshot does.** The box's screen is gone: someone signed out, or it restarted and didn't sign in again. Connect (step 4) and look.
- **The box sits at the sign-in screen** (its runner and machine show offline). The autologon broke. On her PC, in PowerShell as administrator:

  ```powershell
  $kit = "$env:TEMP\citadel-kit"   # the kit from step 0: refreshed if it's still there, fetched if not
  if (-not (Test-Path $kit)) { git clone --depth 1 https://github.com/caraminden/claude-coordinator $kit }
  git -C $kit fetch --depth 1 origin main; git -C $kit checkout --detach FETCH_HEAD   # an old kit may sit on another branch
  powershell -ExecutionPolicy Bypass -File "$env:TEMP\citadel-kit\tools\win-test-box\fix-autologon.ps1"
  ```

  - It asks for the box's password (user `citadel`, from her password manager), prints why the box isn't signing in, stores the password again, restarts the box gracefully after asking, and says PASS or FAIL. It writes what it found to `citadel-box-autologon.txt` on the desktop, with no password in it.
  - Running `guest-setup.ps1` again does not fix this: it deleted its copy of the password on its first run.
  - What happened on 2026-11-10 (#461): an update's restart at 02:15 left `AutoAdminLogon` 0 and no stored password, and the box was offline for 8 hours. `stay-signed-in.ps1` now turns off Windows' own sign-in after updates, which clears those values, and keeps the password from expiring after 42 days.
- **The box shows "Your device ran into a problem and couldn't be repaired"** (Automatic Repair, after a hard reset or a bad update). In its window: **Advanced options → Troubleshoot → Advanced options → Uninstall Updates → Uninstall latest quality update**. Once it starts, run `fix-autologon.ps1` as above.
- **A `run-gpu` job says the GPU didn't come on.** In the box, `powershell -File C:\citadel-box\gpu.ps1 -Check` shows the GPU's state and who wants it, and `C:\citadel-box\gpu.log` what the switch did. After a driver update on her PC, run `gpu-host.ps1` again.
- **A CI job waits on "Waiting for the screen".** A minion's run has it, for 30 minutes at most. After 40 minutes the job takes it anyway.
- **A minion says "The screen is busy".** A CI desktop job or another minion has it. It tries again later.
- **The machine shows offline on Citadel.** In the box: `Get-Content -Tail 20 $env:USERPROFILE\coordinator-agent\machine-agent-citadel-test-box.log`. Usually it's Tailscale signed out.
- **Take it all off:** `remove-test-box.ps1` (PowerShell as administrator on her PC) turns the VM off, removes it and deletes its disk. Then remove its runners on each repo's GitHub **Runners** page, and its machine on Citadel's Machines page.

## The files

| File | Where it runs |
|---|---|
| `new-test-box.ps1` | her PC, as administrator: checks, Windows onto a new disk, the VM, waits for the guest |
| `guest-setup.ps1` | the box, once at first sign-in (again by hand after a failure) |
| `stay-signed-in.ps1` | the box: autologon, a password that never expires, no update restarts. Called by `guest-setup.ps1`, and sent in by `fix-autologon.ps1` |
| `fix-autologon.ps1` | her PC, as administrator, when the box sits at the sign-in screen |
| `add-scheme.ps1` | the box, as administrator, once per scheme |
| `gpu-host.ps1` | her PC, as administrator: the box's GPU partition and the driver's files in it; again after each driver update |
| `gpu.ps1` | the box: the GPU switch. `-Run` is the `run-gpu` task, `-Check` its state, `-Install` (from `gpu-host.ps1`) its setup |
| `screen-lock.ps1` | the box: `-Install` adds the job hooks to every `C:\actions-runner-*-desktop\.env`; `-Take`/`-Release` are those hooks |
| `remove-test-box.ps1` | her PC, as administrator |

The machine agent's side of the lock is `takeScreenLock` in `public/machine-agent.mjs`, which follows the same rules as `screen-lock.ps1`:
- the file holds JSON `{pid, what, who, since, token}`;
- the lock is broken when its pid is gone, when it's over 2 hours old, or when it can't be read and is over a minute old.

Change both together.
