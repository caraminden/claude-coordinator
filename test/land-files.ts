// Citadel's ship script is tools/land.sh and its parts, tools/land/<part>.sh (#2099), which land.sh sources up front.
// A test that copies the script into a scratch tools/ copies them all (copyLand); one that reads what the script says
// (cuts a function out, matches a setting) reads them all as one text (landText), so moving a function into a part
// breaks neither. Imports nothing outside test/ (tools/pipeline-files.txt's rule for pipeline tests).
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoTools = join(import.meta.dirname, '..', 'tools');

/** land.sh and its parts, as paths under tools/: land.sh first, then the parts in name order. */
export function landFiles(tools = repoTools): string[] {
  const dir = join(tools, 'land');
  const parts = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.sh'))
        .sort()
    : [];
  return ['land.sh', ...parts.map((f) => `land/${f}`)];
}

/** Copies land.sh and its parts from the repo's tools/ into another tools/ folder. */
export function copyLand(to: string, from = repoTools): void {
  for (const f of landFiles(from)) {
    if (f.includes('/')) mkdirSync(join(to, 'land'), { recursive: true });
    copyFileSync(join(from, f), join(to, f));
  }
}

/** land.sh and its parts as one text, land.sh first. */
export function landText(tools = repoTools): string {
  return landFiles(tools)
    .map((f) => readFileSync(join(tools, f), 'utf8'))
    .join('\n');
}
