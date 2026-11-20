// ExecStopPost of deploy/claude-coordinator.service.d/watchdog.conf (#1135): when systemd's watchdog stopped the server
// (SERVICE_RESULT=watchdog), leave a mark in DATA_DIR for the next boot to record as a health event. Every stop also
// notes how systemd says it ended (#1325), which the next boot records as a 'stop' health event with its cause.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { markExit, markStop } from '../src/sd-watchdog.ts';

const dataDir = process.env.DATA_DIR || join(homedir(), '.local/share/claude-coordinator');
markStop(process.env, dataDir);
if (markExit(process.env, dataDir)) console.log('Watchdog stop: marked for the next boot.');
