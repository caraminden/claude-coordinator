# Server tools: an MCP server Citadel runs for some schemes, not a machine

Status: accepted, 2026-11-26 (#2179).

perigee's Godot editor with godot-ai was a row on the Machines page (#28) with an agent unit of its own, lent to Delve and
Peek Auras. On the one-kind-of-machine choices page Cara picked "A tool on the server", 2026-11-26: "The machines page if
for computers you are connecting to citadel".

`SERVER_TOOLS` in `src/server-tools.ts` lists each server tool: its name, the schemes whose minions get it, the MCP server
command and the notes a minion reads. That list is the one place that says who gets it; a Citadel member changes it and
ships it. A turn gets each one under its own name (`mcp__perigee-godot__*`, as before) through the proxies a machine's
tools use (`src/machine-mcp.ts`, the pool's `/machine/tool-<name>/mcp`), and the server answers
`/api/machines/tool-<name>/session` by starting one copy of the command per session, in a systemd scope of its own, with a
small fixed environment. Going through the server, not a stdio command in the turn's own config, is what lets a turn in
a person's container use it: Josh's Delve turns run there, and can't reach the host's `uvx` or `systemctl --user`.

Not ADR 0019's host tools: those are CLIs a turn runs, not MCP servers. Not a plugin folder (`tools/plugins/`): Claude
Code names a plugin's tools `mcp__plugin_<plugin>_<server>__*`, so the names would change, and a plugin's command runs where
the turn runs.

Consequences: no Machines page row, no setting in the UI; changing who gets one is a ship. A machine named like a server
tool is left out of turns, so the old row did nothing from the ship until a person removed it. The bridges' CPU counts
under perigee-godot's line (`app-godot.slice`), and their log lines go to the server's journal.
