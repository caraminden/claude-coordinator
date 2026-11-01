# Off-box backups on Cara's Windows desktop (#252)

Each night at 04:00 perigee's `deploy/backup.sh` backs up Citadel, then `deploy/offbox.sh` refreshes
`~/.local/share/claude-coordinator/offbox/` with:

- the coordinator dailies (7) and weeklies (4), with people's linked GitHub tokens (and any future
  secret kinds) removed from the `credentials` table and the file VACUUMed. Rows for linked Claude accounts
  stay: they only hold a container name and an email address.
- the newest session-state copy (`state-<day>.db`, about 1.7 GB: minion transcripts, memory, task lists).
- `SHA256SUMS`, the list the desktop checks every download against.

The desktop pulls that folder over SSH with a key that can do nothing but list and fetch it
(`deploy/offbox-serve.sh` is its forced command). perigee holds no key to the desktop. The desktop keeps
14 dailies, 8 weeklies and 2 session-state copies in `%USERPROFILE%\CitadelBackups`, and logs each run to
`pull.log` there.

## Setup (once, about 10 minutes)

Run these in **Windows PowerShell** on the desktop.

1. Make a key just for this. Press Enter at both passphrase prompts: the nightly job runs unattended.

   ```powershell
   ssh-keygen -t ed25519 -f "$env:USERPROFILE\.ssh\citadel_backup" -C citadel-backup
   Get-Content "$env:USERPROFILE\.ssh\citadel_backup.pub"
   ```

2. SSH into perigee the way you normally do and add one line to `~/.ssh/authorized_keys`, with the
   `ssh-ed25519 AAAA… citadel-backup` text from step 1 where it says `PASTE`:

   ```sh
   echo 'command="/home/cara/claude-coordinator/deploy/offbox-serve.sh",restrict PASTE' >> ~/.ssh/authorized_keys
   ```

   `restrict` turns off shells, port forwarding and the rest; `command=` means the key only ever runs
   the serve script, whatever it asks for.

3. Back on the desktop, check the key works and is locked down:

   ```powershell
   ssh -i "$env:USERPROFILE\.ssh\citadel_backup" cara@perigee.tail59477f.ts.net list
   ssh -i "$env:USERPROFILE\.ssh\citadel_backup" cara@perigee.tail59477f.ts.net whoami
   ```

   The first prints lines of `<checksum>  <name>.db` (or "No such file" until perigee's first nightly
   run with this change, at 04:00). The second must say `Usage: list | get <name>`, not `cara`.

4. Fetch the script with your normal login:

   ```powershell
   New-Item -ItemType Directory -Force "$env:USERPROFILE\CitadelBackups" | Out-Null
   scp cara@perigee.tail59477f.ts.net:claude-coordinator/deploy/desktop/citadel-pull.ps1 "$env:USERPROFILE\CitadelBackups\"
   ```

5. Run it once by hand. The first run downloads everything (about 2-3 GB); later runs fetch only the new
   daily, a weekly once a week, and the new session-state copy.

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\CitadelBackups\citadel-pull.ps1"
   ```

6. Schedule it daily at 05:00, an hour after perigee's backup. That assumes the desktop is on Pacific
   time like perigee. If it isn't, pick the local time for 05:00 Pacific.

   ```powershell
   $a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$env:USERPROFILE\CitadelBackups\citadel-pull.ps1`""
   $t = New-ScheduledTaskTrigger -Daily -At 5:00am
   $s = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 3)
   Register-ScheduledTask -TaskName 'Citadel backup pull' -Action $a -Trigger $t -Settings $s
   ```

   This runs while you're signed in, and a locked screen counts. If you sign out at night, add
   `-User $env:USERNAME -Password (Read-Host 'Windows password')` to the last line so it runs anyway.
   `-StartWhenAvailable` catches up on a missed run when the PC is next on.

## Checking on it

```powershell
Get-Content "$env:USERPROFILE\CitadelBackups\pull.log" -Tail 10
```

Each run ends with `Done: N new, 0 failed, newest daily coordinator-<day>.db`. A run exits 1, which Task
Scheduler shows as Last Run Result `0x1`, when perigee is unreachable, a download fails its checksum
(it retries the next night), or the newest daily is over 2 days old. A failed run never prunes.

## Restoring

See the restore guide in the scheme's shared folder, `reports/offbox-backup-restore.md`.
