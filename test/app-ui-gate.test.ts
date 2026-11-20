import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contractFindings, markdown, wordFindings } from '../tools/app-ui-gate.ts';

test('kit names the app uses that the contract lacks are found; its own definitions are not', () => {
  const f = contractFindings({
    '/a.html': '<button class="cui-btn cui-nope">x</button><style>.cui-mine { color: red }</style><i class="cui-mine"></i>',
    '/a.css': 'a { color: var(--citadel-bg); background: var(--citadel-made-up); } :root { --citadel-own: 1 } b { color: var(--citadel-own) }',
  });
  assert.deepEqual(f.map((x) => `${x.kind} ${x.name}`).sort(), ['unknown-class cui-nope', 'unknown-var --citadel-made-up']);
});

test('the report names a finding and its mode', () => {
  const md = markdown({ app: 'x', mode: 'report', measured: 1, contract: [], words: [], errors: 0, clean: false,
    pages: [{ path: '/', counts: { tap: 1 }, pages: [{ width: 390, findings: [{ check: 'tap', selector: '#go' }] }] }] } as any);
  assert.match(md, /390px tap: #go/);
  assert.match(md, /Mode: report/);
});

test('internal words in what people read are found; code, comments and an allow-listed one are not', () => {
  const texts = {
    '/': '<!-- a minion note --><title>Home</title><script>const k = "minion-kind"; // Taskmaster\nlabel.textContent = "Ask your Taskmaster for a Contraption";\nfetch("/api/minions");</script>'
      + '<style>.scheme { color: red }</style><body class="scheme"><h1>Welcome</h1><p>Saved in /home/cara/x</p><input placeholder="Pick a scheme" title="Grunt work" alt="shared/project"><p>the tickets/ folder</p></body>',
  };
  const hits = wordFindings(texts, []).map((h) => `${h.where} ${h.word}`).sort();
  assert.deepEqual(hits, ['page /home/', 'page scheme', 'page shared/project', 'page tickets/', 'page grunt', 'script contraption', 'script taskmaster'].sort());
  const allowed = wordFindings(texts, [{ word: 'scheme', reason: 'a colour scheme' }]);
  assert.ok(!allowed.some((h) => h.word === 'scheme'));
  assert.throws(() => wordFindings(texts, [{ word: 'scheme' } as any]), /reason/);
});

test('a plain page with none of the words is clean', () => {
  assert.deepEqual(wordFindings({ '/': '<h1>Hello</h1><p>Your games</p>' }, []), []);
});

test('a template string\'s code part is not read as text', () => {
  assert.deepEqual(wordFindings({ '/a.js': 'x = `${day} (${l.minions.map((n) => n)})`;' }, []), []);
});
