# Citadel's Windows test box

A Hyper-V VM on Cara's gaming PC (DESKTOP-G248IJ8) for native-app schemes (#369):
- **Its screen is always there.** It signs itself in at every start and can never lock, sleep or blank its screen, so screen reads and capture work with Cara's own PC locked, after a reboot, and with nobody at it.
- **It looks like her PC where tests care:** 125% scaling and Windows 11's rounded corners. The corners are forced on, because Hyper-V's display adapter draws square ones otherwise.
- **It renders on the CPU (WARP), not her RTX 5080.** That was Cara's pick on 2026-11-07, over GPU-P, which GeForce cards don't support.
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
| GPU | none |
| Disk | a 120 GB disk that grows as it fills: about 60–90 GB in use once a scheme's toolchain and builds are in |
| Starting up | 2 minutes after her PC starts, taking its 8 GB at once. Nothing ever shows on her screen |
| Games | If "Virtualization-based security" was already running (the Windows 11 default; `new-test-box.ps1` says), the hypervisor was already under her games and the box adds about nothing. If it was off, published numbers for turning the hypervisor on are 1–10% average FPS, more in the 1% lows. Those numbers come from older CPUs |

**Pausing it while she plays:** in PowerShell as administrator, `Save-VM citadel-test-box`. That frees all 8 GB and the processors in about 10 s. `Start-VM citadel-test-box` brings it back as it was. While it's saved, CI desktop jobs queue and minions find the machine offline.

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

4. **Open the box's window:** Hyper-V Manager, `citadel-test-box`, **Connect**. If it offers a size or "enhanced session", close that dialog: it's a basic session, the only kind that never locks the box.

5. **Sign Tailscale in**, in the box (3 min). The Tailscale icon by the clock in the box, then **Log in**, then sign in in the browser it opens. It's how the box reaches Citadel.

6. **Lend it to Citadel** (2 min):
   - On Citadel's **Machines** page, add a machine named `citadel-test-box`, MCP server **None**, no folder.
   - Lend it to the native-app schemes (Peek Auras) and switch its **Workspace tools** on.
   - Copy its **Windows** lines, open PowerShell in the box (not as administrator), and paste them. They should end with "It runs in the background now".
   - **Machine tools must be on for each of those schemes.** It's a scheme setting with no button: ask that scheme's Taskmaster to "switch machine tools on" (its scheme settings tool, `machine_tools`). Until then its minions get no machines at all; the Machines page shows whether a scheme's minions get it.

7. **Add each scheme** (PowerShell **as administrator** in the box; 2 min of hands each, plus a toolchain download):

   ```powershell
   C:\citadel-box\add-scheme.ps1 -Repo caraminden/peek-auras
   ```

   - **The deploy key:** it prints a read-only deploy key and the GitHub page to paste it on, then waits. Paste it there, then press Enter.
   - **The rest is automatic:** it clones the repo into `C:\work\peek-auras`, installs the repo's tools with mise and gives the machine agent a `peek-auras` workspace. That workspace has two tasks, `run` (on the screen) and `build` (off it).
   - **The scheme's desktop runner:** add it in the box with the scheme's own runner setup, as a session runner on the box's own desktop with no build runners. For Peek Auras, see its `docs/windows-ci.md`: `setup-runner.ps1 -Scheme "Peek Auras" -CitadelUrl <address> -Builders 0 -Visible -WithMsvc`. `-WithMsvc` puts in the C++ build tools that the Rust builds need too. Peek's script needs `-Builders 0` support first (asked of Peek Auras on 2026-11-07).
   - **Hooks and restart:** run `add-scheme.ps1` again for the screen-lock hooks, then restart the box with `Restart-Computer` inside it. That restarts the box only, never her PC.
   - **Take her desktop off:** remove the scheme's old desktop runner on her own desktop (`-Visible`, the `<PC>-desktop` runner). Two runners with the same label would split the jobs between her screen and the box.

8. **Close the box's window.** Don't sign out of the box or shut it down from inside it; closing the window leaves it running.

9. **Burn-in:** lock her PC overnight. Next morning, a `desktop.yml` run on any PR must pass its `screen` job, and a minion's `screenshot` must come back with a picture. Step 7's runner removal can wait until this passes.

## Day to day

Nothing to do.
- **Restarts look after themselves.** When her PC restarts, the box starts 2 minutes later, signs itself in, and its runners and agent come back. Windows Update in the box never restarts it while it's signed in; its active hours are 06:00–23:00.
- **Adding a scheme** is step 7 again.

## If something goes wrong

- **A desktop job fails with `BitBlt: Access is denied`, or a minion's screenshot does.** The box's screen is gone: someone signed out, or Windows Update restarted it before it signed in again. Connect (step 4) and look. A sign-in screen means the autologon broke: sign in as `citadel`, then run `C:\citadel-box\guest-setup.ps1` as administrator.
- **A CI job waits on "Waiting for the screen".** A minion's run has it, for 30 minutes at most. After 40 minutes the job takes it anyway.
- **A minion says "The screen is busy".** A CI desktop job or another minion has it. It tries again later.
- **The machine shows offline on Citadel.** In the box: `Get-Content -Tail 20 $env:USERPROFILE\coordinator-agent\machine-agent-citadel-test-box.log`. Usually it's Tailscale signed out.
- **Take it all off:** `remove-test-box.ps1` (PowerShell as administrator on her PC) turns the VM off, removes it and deletes its disk. Then remove its runners on each repo's GitHub **Runners** page, and its machine on Citadel's Machines page.

## The files

| File | Where it runs |
|---|---|
| `new-test-box.ps1` | her PC, as administrator: checks, Windows onto a new disk, the VM, waits for the guest |
| `guest-setup.ps1` | the box, once at first sign-in (again by hand after a failure) |
| `add-scheme.ps1` | the box, as administrator, once per scheme |
| `screen-lock.ps1` | the box: `-Install` adds the job hooks to every `C:\actions-runner-*-desktop\.env`; `-Take`/`-Release` are those hooks |
| `remove-test-box.ps1` | her PC, as administrator |

The machine agent's side of the lock is `takeScreenLock` in `public/machine-agent.mjs`, which follows the same rules as `screen-lock.ps1`:
- the file holds JSON `{pid, what, who, since, token}`;
- the lock is broken when its pid is gone, when it's over 2 hours old, or when it can't be read and is over a minute old.

Change both together.
