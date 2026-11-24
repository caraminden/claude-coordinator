import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const made: string[] = []
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }) })
const script = join(import.meta.dirname, '..', 'kit/skills/self-review/scripts/side-check.sh')

test('side-check keeps output, stdin passthrough and the exit status', () => {
  const t = mkdtempSync(join(tmpdir(), 'sc-')); made.push(t)
  const r = spawnSync(script, ['x', 'sh', '-c', 'cat; echo err >&2; exit 4'], { env: { ...process.env, TMPDIR: t }, input: 'hello' })
  assert.equal(r.status, 0)
  const d = join(t, 'side-checks')
  assert.equal(readFileSync(join(d, 'x.out'), 'utf8'), 'hello')
  assert.equal(readFileSync(join(d, 'x.err'), 'utf8'), 'err\n')
  assert.equal(readFileSync(join(d, 'x.exit'), 'utf8').trim(), '4')
  assert.ok(existsSync(join(d, 'x.start')) && existsSync(join(d, 'x.end')))
})

test('two side-checks overlap in time', async () => {
  const t = mkdtempSync(join(tmpdir(), 'sc-')); made.push(t)
  const env = { ...process.env, TMPDIR: t }
  const run = (n: string) => new Promise(res => spawn(script, [n, 'sleep', '2'], { env }).on('close', res))
  await Promise.all([run('a'), run('b')])
  const d = join(t, 'side-checks')
  const num = (f: string) => Number(readFileSync(join(d, f), 'utf8'))
  assert.ok(num('a.start') <= num('b.end') && num('b.start') <= num('a.end'))
})
