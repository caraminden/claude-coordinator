import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// A fake /proc for land.sh's quiet check (#1254): LAND_QUIET_PROC and CITADEL_HEAVY_PRESSURE read it, and deploy.sh's
// starved-box hold through DEPLOY_TEST_PSI_CPU and DEPLOY_TEST_PSI_MEMORY (#1833). Quiet by default.
export function quietProc(dir: string, { psi = 0, load = 0, freePct = 80 } = {}) {
  mkdirSync(join(dir, 'pressure'), { recursive: true });
  writeFileSync(join(dir, 'pressure', 'cpu'), `some avg10=${psi}.00 avg60=${psi}.00 avg300=${psi}.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n`);
  writeFileSync(join(dir, 'pressure', 'memory'), 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n');
  writeFileSync(join(dir, 'loadavg'), `${load.toFixed(2)} 0.00 0.00 1/100 1\n`);
  writeFileSync(join(dir, 'meminfo'), `MemTotal:       1000000 kB\nMemFree:        1 kB\nMemAvailable:   ${freePct * 10000} kB\n`);
  return dir;
}
