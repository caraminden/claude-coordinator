// Loaded into every node process tools/citadel-node starts, and their node children: spawns of
// process.execPath (node --test's test files, servers a test starts) then run as citadel-node too,
// which ananicy-cpp's `node` rule doesn't match (#506, deploy/priority.md).
if (process.env.CITADEL_NODE) process.execPath = process.env.CITADEL_NODE;
