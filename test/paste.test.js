// What a paste in the composer attaches (public/paste.js): files, unless they are an office app's picture of copied text (#468 S11-5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pastedFiles } from '../public/paste.js';

const png = { name: 'image.png', type: 'image/png' };
/** A paste event's clipboardData with these formats. */
const clip = (formats, files = []) => ({ types: [...Object.keys(formats), ...(files.length ? ['Files'] : [])], files, getData: (t) => formats[t] ?? '' });

test('cells copied from Excel or LibreOffice, or text from Word, paste as their text, not as the picture beside it', () => {
  const excel = clip({ 'text/plain': 'a\tb\n1\t2\n', 'text/html': '<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta name=Generator content="Microsoft Excel 15"><style>td{}</style></head><body><table><tr><td>a</td><td>b</td></tr></table></body></html>' }, [png]);
  assert.deepEqual(pastedFiles(excel), []);
  const calc = clip({ 'text/plain': 'x', 'text/html': '<meta name="generator" content="LibreOffice"><table><tr><td>x</td></tr></table>' }, [png]);
  assert.deepEqual(pastedFiles(calc), []);
});

test('an image, a file copied in Finder or Explorer, or a copied web image still attaches', () => {
  assert.deepEqual(pastedFiles(clip({}, [png])), [png], 'a screenshot');
  const finder = { name: 'report.pdf', type: 'application/pdf' };
  assert.deepEqual(pastedFiles(clip({ 'text/plain': 'report.pdf' }, [finder])), [finder], "a file's name is text, with no HTML");
  assert.deepEqual(pastedFiles(clip({ 'text/html': '<!--StartFragment--><img src="https://x/a.png"><!--EndFragment-->' }, [png])), [png], "Chrome's Copy image");
  assert.deepEqual(pastedFiles(clip({ 'text/plain': 'https://x/a.png', 'text/html': '<img alt="a cat" src="https://x/a.png">' }, [png])), [png], "Firefox's Copy image, its address as text");
});

test('plain text pastes as text', () => {
  assert.deepEqual(pastedFiles(clip({ 'text/plain': 'hi' })), []);
  assert.deepEqual(pastedFiles(null), []);
});
