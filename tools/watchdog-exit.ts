// ExecStopPost of deploy/claude-coordinator.service.d/watchdog.conf (#1135): when systemd's watchdog stopped the server
// (SERVICE_RESULT=watchdog), leave a mark in DATA_DIR for the next boot to record as a health event. Any other stop does nothing.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { markExit } from '../src/sd-watchdog.ts';

if (markExit(process.env, process.env.DATA_DIR || join(homedir(), '.local/share/claude-coordinator'))) console.log('Watchdog stop: marked for the next boot.');
