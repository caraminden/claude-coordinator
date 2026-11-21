# systemd-oomd and Citadel's slices (#1338)

When memory runs short, turns slow down and heavy work gives way. No turn dies because one slice sat at its own line
(Cara, 2026-11-20, on #1335's choices page: "B: no kill on the turns' line: Go", "C: protect turns instead of capping
them: Go"). The design and the 2026-11-20 kills behind it are in the scheme's shared folder:
`reports/memory-kills-2026-11-20.md`.

CachyOS ships one systemd-oomd rule for every user slice (`/usr/lib/systemd/user/slice.d/10-oomd-per-slice-defaults.conf`):
kill once a slice has been stalled on memory more than 80% of the time for 30 s. On 2026-11-20 that rule killed 23
host turns, each time while `citadel-turns.slice` sat at its own `MemoryHigh` with room left in `citadel.slice`.
The drop-ins here carry the same file name, so in each of these slices they replace CachyOS's rule (systemd.unit(5)):

| Slice | oomd kills here when | Who it picks |
|---|---|---|
| `citadel-heavy.slice` (tests, browsers, builds a turn runs) | stalled > 60% for 20 s | the heavy command; its turn lives |
| `citadel-turns.slice`, `citadel-builds.slice`, `citadel-taskmasters.slice` | never, for their own pressure | n/a |
| `citadel.slice`, and the user root `-.slice` (`user@1002.service`) | stalled > 90% for 60 s | one leaf below, most reclaim first: ships and heavy commands, people's containers among them; then `avoid` (minion turns, ultra reviews) only once nothing else is left; never `omit` (the server, Taskmasters, the tools pool) |

The swap rule (`ManagedOOMSwap=kill`: the box's swap and its memory both over 90% used) stays as CachyOS has it. Note that it ignores `avoid`
and `omit` on cgroups a user owns.

The pressure figure is how much of the time every task in the group was waiting on memory, so 90% means work moved
about a tenth of the time, for a whole minute. `citadel-turns.slice` itself has no `MemoryHigh` any more and reserves
`MemoryLow=8G` (the reasons are in that file).

People's containers can't be made a last pick. Podman hands each container's payload cgroup (where all of that
person's turns run) to the container's own uid, and oomd honours `avoid` only on cgroups owned by root or by the user
whose manager it watches. So oomd ranks a container like a ship, by its reclaim activity, and one kill there ends every
turn in it.

## Install

On perigee, as cara, in fish (a terminal or `ssh perigee`), after the ship is live in `~/claude-coordinator`:

```fish
for u in citadel-turns.slice citadel-builds.slice citadel-taskmasters.slice citadel-heavy.slice citadel.slice -.slice
    mkdir -p ~/.config/systemd/user/$u.d
    ln -sf ~/claude-coordinator/deploy/$u.d/10-oomd-per-slice-defaults.conf ~/.config/systemd/user/$u.d/
end
systemctl --user daemon-reload
```

`citadel-turns.slice` is already linked to the live checkout, so the reload picks up its new `MemoryLow` and the
removed `MemoryHigh` too. Turns that are running keep their old oomd marks until they next start. The
tools pool runs for days, so mark the running one now:

```fish
for u in (systemctl --user list-units --no-legend --plain 'citadel-mcp-pool-*' | string split -f1 ' ')
    systemctl --user set-property --runtime $u ManagedOOMPreference=omit
end
```

## Check

```fish
oomctl | grep -A2 -E 'user@1002\.service(/citadel\.slice(/citadel-[a-z]+\.slice)?)?$'
systemctl --user show -p MemoryLow,MemoryHigh citadel-turns.slice
cat /sys/fs/cgroup/user.slice/user-1002.slice/user@1002.service/citadel.slice/citadel-turns.slice/memory.{low,high}
```

Expected:
- In `oomctl`'s "Memory Pressure Monitored CGroups", `user@1002.service` and `citadel.slice` show 90.00% for 1min, and
  `citadel-heavy.slice` 60.00% for 20s. `citadel-turns.slice`, `citadel-builds.slice` and
  `citadel-taskmasters.slice` are not listed there. They stay in "Swap Monitored CGroups".
- `MemoryLow=8589934592` and `MemoryHigh=infinity`.
- The cgroup reads `8589934592`, then `max`.

## Undo

```fish
for u in citadel-turns.slice citadel-builds.slice citadel-taskmasters.slice citadel-heavy.slice citadel.slice -.slice
    rm -f ~/.config/systemd/user/$u.d/10-oomd-per-slice-defaults.conf
end
systemctl --user daemon-reload
```

That puts CachyOS's 80% for 30 s back on every slice. To bring back a turns cap, revert `deploy/citadel-turns.slice`
in git and ship it.
