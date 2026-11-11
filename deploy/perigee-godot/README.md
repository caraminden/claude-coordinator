# perigee-godot: the Godot editor only while it's used (#505)

The `perigee-godot` machine is the Godot 4.7.2 .NET editor on `~/delve-godot` (a Quadlet,
`perigee-godot.service`) plus the machine agent that lends godot-ai to minions
(`perigee-godot-agent.service`). The editor held a full core around the clock, so now:

- **Start on demand.** The agent's MCP command goes through `godot-on-demand.mjs`, which passes the
  MCP lines through untouched. A request that needs the editor (a tool call; not the handshake or
  the tool list) starts the unit if it is down and holds until the editor has dialled in to
  godot-ai's WebSocket port 9500 (at most 180 s, then 5 s more for the plugin's handshake), so the
  minion's call waits instead of failing.
- **Stop when idle.** Every MCP line either way stamps `~/.local/state/perigee-godot/last-call`, and a
  tool call still waiting on its answer re-stamps it each minute. `perigee-godot-idle.timer` runs
  `godot-on-demand.mjs idle-check` every 10 minutes, which stops the unit once both the last call and
  the unit's start are 2 hours old. It never touches a frozen unit and never starts anything. Its
  first run after install finds no stamp and starts the 2-hour clock instead of stopping.
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

Settings, as environment variables on either unit: `GODOT_IDLE_S` (7200), `GODOT_READY_S` (180),
`GODOT_SETTLE_S` (5), `GODOT_UNIT`, `GODOT_WS_PORT`, `GODOT_ACTIVITY`.

## Install (by hand, once this is in the live checkout)

```sh
cp ~/claude-coordinator/deploy/perigee-godot/perigee-godot.container ~/.config/containers/systemd/
cp ~/claude-coordinator/deploy/perigee-godot/perigee-godot-agent.service \
   ~/claude-coordinator/deploy/perigee-godot/perigee-godot-idle.service \
   ~/claude-coordinator/deploy/perigee-godot/perigee-godot-idle.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now perigee-godot-idle.timer
# Picks up the new MCP command. Ends the agent's open sessions: do it when no Delve minion is mid-call.
systemctl --user restart perigee-godot-agent.service
```

The Quadlet no longer has `[Install]`, so the editor isn't started at boot, and the agent no longer
`Wants=` it. While the editor is frozen (`systemctl --user freeze`) the idle check leaves it alone.
After a thaw, if nothing has called it in 2 hours, the next check (within 10 minutes) stops it.

Check it: `systemctl --user list-timers perigee-godot-idle.timer`,
`journalctl --user -u perigee-godot-idle.service` (one line per check: "used N min ago" or
"stopping"), and `journalctl --user -u perigee-godot-agent.service | grep godot-on-demand` (starts and
how long the editor took to connect).

## Measuring the cold start

The agent's journal logs `the editor connected N s after perigee-godot.service started` on every start
it makes. To measure one by hand while no minion is using it:

```sh
systemctl --user stop perigee-godot.service
t0=$(date +%s.%N); systemctl --user start perigee-godot.service
until ss -Htn state established '( sport = :9500 )' | grep -q .; do sleep 0.5; done
echo "editor connected after $(echo "$(date +%s.%N) - $t0" | bc) s"
```

This needs a godot-ai backend already up (any open session, or `uvx --from godot-ai==4.3.0 godot-ai
attach` in another terminal), since the editor dials in to it.
