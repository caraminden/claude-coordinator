# perigee-godot: the Godot editor only while it's used (#505)

`perigee-godot` is the Godot 4.7.2 .NET editor on `~/delve-godot` (a Quadlet, `perigee-godot.service`) with godot-ai,
which Citadel's server lends to the minions of Delve and Peek Auras as a server tool (#2179): `SERVER_TOOLS` in
`src/server-tools.ts` says which schemes get it, and a Citadel member changes that list and ships it. Each turn session
gets its own `godot-on-demand.mjs` bridge, which the server starts in a scope under `app-godot.slice` (perigee-godot's CPU line
counts it). The tools keep the names they had as a machine, `mcp__perigee-godot__*`. Until #2179 it was a row on the
Machines page with an agent unit of its own (`perigee-godot-agent.service`); the Machines page is for computers people
connect to Citadel. The editor held a full core around the clock, so now:

- **Close to no CPU while up (#1353).** That core was Godot's audio thread: the container has no sound
  card, its ALSA default is the null device, which never makes a writer wait, so the thread spun for the
  editor's whole life. `start.sh` runs the editor with `--audio-driver Dummy`, and with `--frame-delay 45`: the headless
  window counts as focused, so it woke every 6.9 ms with nothing to draw (18% of a core). Measured in a scratch copy: 89% of a core before, 1% after.
  `start.sh` runs from the live checkout, so a change to it is live at the editor's next start.

- **Start on demand.** Each session's MCP server is `godot-on-demand.mjs`, which passes the
  MCP lines through untouched. A request that needs the editor (`tools/call` or `resources/read`,
  nothing else: Claude Code opens every session with a `server/discover` probe, and when unknown
  methods counted, every turn kept the editor up or started it, #1353) starts the unit if it is down and holds until the editor has dialled in to
  godot-ai's WebSocket port 9500 (at most 180 s, then 5 s more for the plugin's handshake), so the
  minion's call waits instead of failing.
- **Stop when idle.** A tool call and its answer stamp `~/.local/state/perigee-godot/last-call`, and a
  tool call still waiting on its answer re-stamps it each minute. The handshake, listings and pings
  don't: every turn in a scheme it is lent to opens a session, about 56 a day, and when those
  counted the editor never went 2 hours quiet (#615). `perigee-godot-idle.timer` runs
  `godot-on-demand.mjs idle-check` every 10 minutes, which stops the unit once both the last call and
  the unit's start are 30 minutes old. It never touches a frozen unit and never starts anything. Its
  first run after install finds no stamp and starts the clock instead of stopping.
- **No call lands on a dying editor.** The check decides and stops under an exclusive lock
  (`~/.local/state/perigee-godot/stop.lock`), and a tool call waits on that lock before it looks at the
  editor, so a call arriving mid-stop starts it again.
- **The stop is a plain stop.** Scene edits a minion left unsaved in the editor are lost when it
  stops: save before you leave it.
- **Sessions survive the stop.** The godot-ai backend (MCP on 127.0.0.1:8000) runs on the host, owned
  by the attach bridges, not inside the editor's container. Stopping the editor leaves every session
  open; the editor reconnects to the same backend when it starts again.

Socket activation doesn't fit: the port the minions reach (8000) is the host backend's, which is
already up, and the editor is a *client* of port 9500, not a server.

Settings, as environment variables on the idle unit (the bridges get a fixed, small environment from the server, so they use the defaults): `GODOT_IDLE_S` (1800), `GODOT_READY_S` (180),
`GODOT_SETTLE_S` (5), `GODOT_UNIT`, `GODOT_WS_PORT`, `GODOT_ACTIVITY`.

## Install (by hand, once this is in the live checkout)

```sh
# The Quadlet runs start.sh from the live checkout (#1353): copy it once more if you installed it before then.
cp ~/claude-coordinator/deploy/perigee-godot/perigee-godot.container ~/.config/containers/systemd/
cp ~/claude-coordinator/deploy/perigee-godot/perigee-godot-idle.service \
   ~/claude-coordinator/deploy/perigee-godot/perigee-godot-idle.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now perigee-godot-idle.timer
```

Moving off the machine row (#2179), once, after the server tool is live: the old agent and its token go, then the row.

```sh
systemctl --user disable --now perigee-godot-agent.service
rm ~/.config/systemd/user/perigee-godot-agent.service ~/.config/perigee-godot/agent.env
systemctl --user daemon-reload
```

Then remove `perigee-godot` on the Machines page. Until it's removed, turns already skip a machine named like a server tool.

The Quadlet no longer has `[Install]`, so the editor isn't started at boot, and nothing
`Wants=` it. While the editor is frozen (`systemctl --user freeze`) the idle check leaves it alone.
After a thaw, if nothing has called it in 30 minutes, the next check (within 10 minutes) stops it.

Check it: `systemctl --user list-timers perigee-godot-idle.timer`,
`journalctl --user -u perigee-godot-idle.service` (one line per check: "used N min ago" or
"stopping"), and `journalctl --user -u claude-coordinator.service | grep godot-on-demand` (starts and
how long the editor took to connect: the server logs each bridge's lines as `perigee-godot (#N in Delve): ...`).

## Measuring the cold start

The server's journal logs `the editor connected N s after perigee-godot.service started` on every start
it makes. To measure one by hand while no minion is using it:

```sh
systemctl --user stop perigee-godot.service
t0=$(date +%s.%N); systemctl --user start perigee-godot.service
until ss -Htn state established '( sport = :9500 )' | grep -q .; do sleep 0.5; done
echo "editor connected after $(echo "$(date +%s.%N) - $t0" | bc) s"
```

This needs a godot-ai backend already up (any open session, or `uvx --from godot-ai==4.3.0 godot-ai
attach` in another terminal), since the editor dials in to it.
