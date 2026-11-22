# A parked minion is called sealed

Status: accepted, 2026-11-22. Built on #1602.

Cara, 2026-11-22: "Can we rename parked to sealed, more thematic".

Everything people and agents read says **sealed** (and "seal", "unseal", "sealed until …") where it used to say
parked: the minions list and its filters, a minion's header and composer, held-mail lines, notes the server writes,
the Taskmaster and minion prompts, the handoff facts sheet's "Sealed minions:" heading, the Stuck list, and the
coordinator and thread MCP tool descriptions. It applies to every scheme, since the UI and prompts are shared.

- **Names stay.** The stored state value `'parked'`, `parked_for`, `parkedOn`, `/unpark`, message_ticket's `unpark` and
  `start_now`, the `unpark` need, CSS classes and code identifiers keep their old names (the scheme's Names rule).
  A minion or tool may set state `sealed`: the server reads it as `parked` (`routes/tickets.ts`), and `stateWord`
  (`src/needs.ts`) turns the stored value back into "sealed" wherever the server prints a state.
- **Old words keep working.** Saved chats and notes that say "parked" stay as they are. `state: 'parked'` is still
  accepted, and card-links' "not waiting" words list both.
- **Not the credentials sense.** `src/credentials.ts` and `src/secrets.ts` already use seal/unseal for encryption;
  they were left alone and no identifier was added that collides with them.
- **Left for later:** the kit's `land.sh` templates and their messages ("it parks", "Park, and run this again")
  are pipeline files; they still say park.
