# Minion keepalives keep a waiting minion's cache warm

Status: accepted, 2026-11-16 (#854's pick, built in #862).

Cara on #854: "Could we build a cache monitor that gets marked dirty automatically if we change a prompt? lets also limit the keep alives to "working hours" something like 11am to midnight. If we do this I want to be sure we are optimizing and not wasting tokens with the pings".

A minion waiting on a person (state none, ready or try, or a card of its own open, nothing queued) gets a hidden one-line `--resume` turn 55 minutes after its last turn or keepalive ended, so the 1 h prompt cache is re-read at 0.1x instead of re-written at 2x when the person answers. The code is `src/keepalive.ts`, and `Runner.keepaliveSweep` runs it every minute.

- **Hours:** from 11:00 to midnight Pacific only. A series stops at midnight and 8 hours after the real turn that started it.
- **Hidden:** it changes nothing of the minion's: no chat line, no state, note or replies, no running status. A real message that arrives first drops it. One that arrives while it runs waits the few seconds behind it. A restart drops it and doesn't resume it.
- **Cache monitor (dirty):** each real turn stores a fingerprint of what its cached prefix is built from. That covers the system prompt, the launch arguments, mcp.json and settings.json, prompt-shaping env, the pinned files, the Claude Code build, CLAUDE.md, rules and the memory index, and the date line. Each keepalive recomputes the fingerprint first. Any change stops the series with no ping, because the next wake re-writes the cache anyway. Codex minions and Taskmasters get no keepalives.
- **No waste:** a keepalive that writes more than 5k tokens to the cache missed it and stops its series. If more than 1 in 5 of a day's keepalives miss (out of at least 5), keepalives switch off server-wide (setting `keepalive_off`) and the Citadel Taskmaster gets held mail.
- **Readout:** keepalive turns are costed apart (`turns.keepalive`). Each week the Citadel Taskmaster gets the keepalive cost, warm and cold wakes, the reloads saved and the net. A net below zero switches keepalives off.
