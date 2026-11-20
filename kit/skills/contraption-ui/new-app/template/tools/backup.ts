// The nightly backup timer's command (citadel-app.json `timers.backup`): node tools/backup.ts <DATA_DIR>
import { backup } from '../src/backup.ts';

const dataDir = process.argv[2] || process.env.DATA_DIR;
if (!dataDir) throw new Error('usage: node tools/backup.ts <DATA_DIR>');
console.log(`backup: ${backup(dataDir)}`);
