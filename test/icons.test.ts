import { test } from 'node:test';
import assert from 'node:assert/strict';
import { versionIcons } from '../src/icons.ts';

const make = (png: string) =>
  new Map<string, Buffer>([
    ['icon-192.png', Buffer.from(png)],
    ['icon.svg', Buffer.from('<svg/>')],
    ['manifest.webmanifest', Buffer.from('{"icons":[{"src":"/icon-192.png"}]}')],
    ['index.html', Buffer.from('<link href="icon.svg"><link href="icon-192.png">')],
    ['sw.js', Buffer.from("icon: '/icon-192.png'")],
  ]);

test('icon URLs carry a hash of the file, which changes with its content', () => {
  const a = make('orange');
  const b = make('violet');
  versionIcons(a);
  versionIcons(b);
  const urlOf = (m: Map<string, Buffer>) => /icon-192\.png\?v=[0-9a-f]{8}/.exec(m.get('manifest.webmanifest')!.toString())?.[0];
  assert.ok(urlOf(a));
  assert.notEqual(urlOf(a), urlOf(b));
  assert.match(a.get('index.html')!.toString(), /icon\.svg\?v=[0-9a-f]{8}.*icon-192\.png\?v=[0-9a-f]{8}/);
  assert.ok(a.get('sw.js')!.toString().includes(urlOf(a)!));
  assert.ok(!a.get('manifest.webmanifest')!.toString().includes('?v=?'));
});
