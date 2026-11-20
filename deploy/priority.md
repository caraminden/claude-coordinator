# Keeping the server out of swap and ahead of builds (#326)

Scheme switching got slow while minions compiled (report: `reports/perigee-load-2026-11-05.md` in
the scheme's shared folder). Every command here is bash: perigee's login shell is fish, so type
`bash` first. Three things on perigee cause it, and one fix each. Only the first is a
Citadel file; the other two are host settings, so they're commands for Cara to run. Run the
[checks](#checks) before and after so the numbers show whether it worked.

## 1. The service drop-in (no sudo)

`claude-coordinator.service.d/priority.conf` sets `MemorySwapMax=0`, `CPUWeight=1000` and
`OOMScoreAdjust=100` on the server. Why each one, and what happens under real memory pressure, is in
the file's comments. In short: `citadel.slice` caps the server, the host turns and every container at 22G together
(each container also at 8G on its own unit, #1214), so a build that fills it makes the kernel swap
out the idle server first. With this file,
the turns' memory goes instead. If the slice really runs out, its OOM killer picks the biggest
process, usually a rustc or a claude; if it picks the server, `Restart=always` brings it back in 3 s.

Once this is live in `~/claude-coordinator` (after the landing deploy):

```sh
ln -s ~/claude-coordinator/deploy/claude-coordinator.service.d/priority.conf ~/.config/systemd/user/claude-coordinator.service.d/
systemctl --user daemon-reload
systemctl --user show claude-coordinator -p MemorySwapMax -p CPUWeight -p OOMScoreAdjust
# expect MemorySwapMax=0, CPUWeight=1000, OOMScoreAdjust=100
```

`daemon-reload` applies the swap and CPU settings to the running server straight away.
`OOMScoreAdjust` and swapping the server's old pages back in wait for its next restart, which the
next deploy does. To undo: `rm ~/.config/systemd/user/claude-coordinator.service.d/priority.conf`,
then `systemctl --user daemon-reload`.

## 2. ananicy-cpp: the biggest CPU problem (the server's fix needs no sudo)

CachyOS's packaged ananicy rules (`/etc/ananicy.d/00-default/`, checked against CachyOS/ananicy-rules
at 03ef03f) match processes by name:

| Rule | Type | What it sets | What it hits here |
|---|---|---|---|
| `node` | BG_CPUIO | nice 16, `SCHED_IDLE`, I/O class idle | **the Citadel server** (`/usr/bin/node server.ts`), every turn wrapper and MCP server, and claude, which inherits it |
| `bash`, `dash`, `zsh`, `fish` | Doc-View | nice −4 | every shell a turn's Bash tool opens, so cargo, rustc and git inherit −4 |
| `podman` | Service | nice 10 | podman itself |

Seen on 2026-11-05: the server at policy `IDL` (`SCHED_IDLE`), and every `node` and `claude` process
in Cara's turn container at nice 16 under `SCHED_IDLE`, every `bash` at nice −4. A `SCHED_IDLE` task
never preempts a running task when it wakes, so with all 16 CPUs busy compiling, the server waits for
a slice to end on every wake-up, and inside a container the compilers outrank claude by 20 nice
levels. `CPUWeight` above can't fix that, and a systemd `Nice=` would just be overwritten: ananicy
re-applies its rules to running processes every 15 s.

**The server, no sudo:** ananicy-cpp names a process by the basename of its argv[0], not its comm
(`get_command_from_pid` in its `src/platform/linux/process.cpp`; that's why it catches node, whose
comm is `node-MainThread`), so
`claude-coordinator.service` now starts the server as `citadel-server` (`ExecStart=@/usr/bin/node
citadel-server …`) and no rule matches it. After the deploy that brings this in, as cara on perigee:

```sh
systemctl --user daemon-reload   # the service file is a link into the checkout: load the new ExecStart
```

The restart after that (the next deploy) starts it clean. Check 1 below should then show `CLS TS`,
`NI 0`.

**Turns and test runs, no sudo (#506):** the same trick, by a link instead of systemd's `@`, since
`spawn()` and an `mcp.json` command take a path:

- Every turn's `pin/bin/citadel-node` links to the server's node (`pinTurnFiles`, `TURN_NODE` in
  `src/turn-launch.ts`). The turn wrapper (host and container), the thread and machine MCP servers
  and the Codex shim run through it, and claude inherits the wrapper's policy. In a container the
  link points at the host's `/usr/bin/node`, which the image links to its own node.
- `tools/citadel-node` runs node from a link of that name in `$TMPDIR/citadel-node-<uid>/`, plus a
  preload (`tools/citadel-node.cjs`) that points `process.execPath` at the link. `node --test` and
  child spawns use `process.execPath`, so test files and the servers they start keep the name.
  `tools/run-tests.sh` (lands, deploys) and `npm test` use it.
- Resetting the policy from inside (`chrt -o -p 0` on itself) doesn't stick: ananicy re-applies
  every 15 s to whatever matches.
- Still `node`, so still idle: the short-lived tripwire, link-check, wording and scheme-refs hooks;
  a minion's own `node` commands (`node --test test/x.ts` typed by hand, other schemes' mise node,
  vitest and npm); previews and dev copies; contraptions started as `node server.ts`; a contraption
  turn's machine MCP servers and Codex shim (`src/contraption-turns.ts`); the Codex review driver
  (`tools/citadel-codex-review`, `src/codex-review.ts`). For another
  scheme, the same pattern applies: run its node from a link not named `node`, and preload the
  `process.execPath` change for test runners that spawn children.

Check: `ps -eo pid,cls,ni,args | grep -E 'citadel-node|turn-wrapper|mcp\.ts'`: all `TS`.

**Shells need root:** shells (with the compilers they start) still run at −4. Whoever has root on perigee can turn ananicy-cpp off.
Its rules are written for a desktop (13,500 of them are games), and on a build server they work
against systemd's cgroup weights.

```sh
sudo systemctl disable --now ananicy-cpp
```

**Or, to keep it for the desktop apps,** drop the six rules and stop pacman putting them back.
Overriding them with a later rule file doesn't work reliably: ananicy-cpp reads rule files in
directory order and the last rule for a name wins.

```sh
pacman -Qo '/etc/ananicy.d/00-default/Development & Programming/node.rules'   # which package owns them
sudo sed -i '/^\[options\]/a NoExtract = etc/ananicy.d/00-default/*/node.rules etc/ananicy.d/00-default/*/bash.rules etc/ananicy.d/00-default/*/dash.rules etc/ananicy.d/00-default/*/zsh.rules etc/ananicy.d/00-default/*/fish.rules etc/ananicy.d/00-default/*/podman.rules' /etc/pacman.conf
find /etc/ananicy.d/00-default -name node.rules -o -name bash.rules -o -name dash.rules -o -name zsh.rules -o -name fish.rules -o -name podman.rules   # look: expect six files
find /etc/ananicy.d/00-default -name node.rules -o -name bash.rules -o -name dash.rules -o -name zsh.rules -o -name fish.rules -o -name podman.rules | sudo xargs -d '\n' rm -v
sudo systemctl restart ananicy-cpp
```

Either way, processes keep the nice they already have. New turns inherit from the server, so they come
right once it has restarted, with no need to restart the containers.

## 3. zram retune (root; Cara's call)

Today: one 30 GB zram device (as big as RAM, from CachyOS's `zram-size = ram`), `vm.swappiness = 150`
(set by CachyOS's udev rule `/usr/lib/udev/rules.d/30-zram.rules` whenever zram0 comes up, which beats
any sysctl.d file), and no disk swap. Pages compress only about 1.55:1 here, so zram held 8–9.7 GB of
RAM and peaked at 13.8 GB (`mm_stat` max), nearly half the box, to hold cold pages that would sit just
as well on the NVMe.

Recommendation: **8 GiB of zram, a 16 GiB swapfile on disk at a lower priority, swappiness 100.**
Fast zram stays the first stop, and it can't eat more than about 5 GB of RAM. Overflow goes to disk
instead of squeezing the page cache. 100 means the kernel weighs swapping and dropping cache equally;
150 only makes sense when zram compresses 3:1 or better.

```sh
# a. Disk swapfile in its own subvolume (btrfs needs that: no CoW, kept out of snapshots of /). Run once.
findmnt -no FSTYPE /   # expect btrfs; on anything else use mkswap on a plain file instead
sudo btrfs subvolume create /swap
sudo btrfs filesystem mkswapfile --size 16g /swap/swapfile
echo '/swap/swapfile none swap defaults,pri=10 0 0' | sudo tee -a /etc/fstab
sudo swapon /swap/swapfile

# b. Swappiness 100: shadow CachyOS's udev rule (same name in /etc wins) and keep its zswap line
sed 's/vm.swappiness}="150"/vm.swappiness}="100"/' /usr/lib/udev/rules.d/30-zram.rules | sudo tee /etc/udev/rules.d/30-zram.rules
grep -n swappiness /etc/udev/rules.d/30-zram.rules   # must say "100"; if it still says 150, edit it by hand
sudo sysctl vm.swappiness=100

# c. 8 GiB zram from the next boot (this file replaces /usr/lib/systemd/zram-generator.conf)
printf '[zram0]\ncompression-algorithm = zstd\nzram-size = 8192\nswap-priority = 100\nfs-type = swap\n' | sudo tee /etc/systemd/zram-generator.conf
```

Step c takes effect at the next reboot, which is the safe way to apply it. To apply it live instead,
do it at a quiet time, after a and b: `sudo swapoff /dev/zram0` (it pulls about 12 GB back in, and
the swapfile catches what doesn't fit) then `sudo systemctl restart systemd-zram-setup@zram0.service`.
The cost: once zram is full, cold pages go to disk, and faulting them back in is slower than zram.
With the drop-in in place the server's pages are never among them.

## Checks

All read-only, run on perigee itself (not in a container). Run them once before installing and again a
day after.

```sh
# 1. The server: memory, swap, priority, cgroup settings
pid=$(systemctl --user show -p MainPID --value claude-coordinator)
grep -E 'VmRSS|VmSwap' /proc/$pid/status
ps -o pid,ni,cls,etime,args -p $pid; ionice -p $pid; cat /proc/$pid/oom_score_adj   # args starts citadel-server once renamed
cg=/sys/fs/cgroup$(systemctl --user show -p ControlGroup --value claude-coordinator)
cat $cg/memory.swap.max $cg/memory.swap.current $cg/cpu.weight
#    before: CLS IDL, NI 16, "idle"; VmSwap high. After: TS, 0, best-effort; swap.max 0, VmSwap 0 after a restart.

# 2. What ananicy is doing to node, shells and compilers
systemctl status ananicy-cpp --no-pager | head -5
ps -eo ni,cls,comm | grep -E ' (node|bash|cargo|rustc|git|claude|2\.[0-9.]+)$' | sort | uniq -c | sort -rn | head

# 3. Top 15 swap users host-wide, and per container
for f in /proc/[0-9]*/status; do awk '/^Name/{n=$2}/^Pid/{p=$2}/^VmSwap/{print $2, p, n}' "$f" 2>/dev/null; done | sort -rn | head -15
podman stats --no-stream

# 4. Swap layout and where swappiness comes from
swapon --show; zramctl; sysctl vm.swappiness
grep -rs swappiness /etc/sysctl.d /usr/lib/sysctl.d /etc/udev/rules.d /usr/lib/udev/rules.d
cat /etc/systemd/zram-generator.conf /usr/lib/systemd/zram-generator.conf 2>/dev/null
```
