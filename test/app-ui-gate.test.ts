import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contractFindings, markdown } from '../tools/app-ui-gate.ts';

test('kit names the app uses that the contract lacks are found; its own definitions are not', () => {
  const f = contractFindings({
    '/a.html': '<button class="cui-btn cui-nope">x</button><style>.cui-mine { color: red }</style><i class="cui-mine"></i>',
    '/a.css': 'a { color: var(--citadel-bg); background: var(--citadel-made-up); } :root { --citadel-own: 1 } b { color: var(--citadel-own) }',
  });
  assert.deepEqual(f.map((x) => `${x.kind} ${x.name}`).sort(), ['unknown-class cui-nope', 'unknown-var --citadel-made-up']);
});

test('the report names a finding and its mode', () => {
  const md = markdown({ app: 'x', mode: 'report', measured: 1, contract: [], errors: 0, clean: false,
    pages: [{ path: '/', counts: { tap: 1 }, pages: [{ width: 390, findings: [{ check: 'tap', selector: '#go' }] }] }] } as any);
  assert.match(md, /390px tap: #go/);
  assert.match(md, /Mode: report/);
});
