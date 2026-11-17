# Minions unpark the minions parked on them

Status: accepted, 2026-11-16 (#853).

On #848's choices page Cara picked self-serve unpark: "Yeah, minions that are waiting on other minions should be woken without taskmaster involvement". This reverses the unparking part of #783's rule (starting, closing, reopening and unparking stay with the Taskmaster); starting, closing and reopening still do.

`message_minion` takes `unpark: true`: it runs the Taskmaster's `unparkTicket` on a parked minion of the same scheme and the message wakes it. A dismissed minion is refused; so is a start_after chain a person put on hold. The per-pair loop guard applies, and the Taskmaster gets a held-mail line "#N unparked #M".
