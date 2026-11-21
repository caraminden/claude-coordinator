// Huge pages only where a program asks for them, for every service unit Citadel starts (#1458). The box runs huge pages
// `always` with defrag `defer+madvise`: each huge page a fault can't get wakes the reclaimer, which then threw away
// 30 GB of file cache in 3 minutes with 5 GB free (reports/server-stalls-deep-dive-2026-11-21.md, class 1), the
// database's pages with it, so the server's reads went to disk. Most of those requests came from Citadel's own groups.
// A service unit starts from systemd, not from the server, so it doesn't inherit the server's setting (priority.conf);
// a scope (`--scope`) does inherit from the process that starts it, and refuses the property ("Unknown assignment").
// The setting carries across fork and exec, so a container's processes and a turn's tools get it too. systemd 260+.
export const THP_PROPS = ['-p', 'MemoryTHP=madvise'];
