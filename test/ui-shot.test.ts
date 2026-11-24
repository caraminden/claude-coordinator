import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emulation, parseArgs, parseSteps, shotName } from '../tools/ui-shot.ts';

// tools/ui-shot.ts (#639): the arguments, the file names, and the display-mode and title bar rewrite that
// stands in for the emulation Chromium lacks. The browser half is checked by shooting (its header says how).

test('arguments: defaults, the front door, and refusals', () => {
  const o = parseArgs([]);
  assert.deepEqual([o.routes, o.widths, o.themes, o.titlebar], [[''], [1440, 390], ['light'], undefined]);
  assert.deepEqual(parseArgs(['/', '#/p/2/t/639']).routes, ['', '#/p/2/t/639']);
  // A window-controls-overlay shot gets Windows' title bar unless one is given.
  assert.deepEqual(parseArgs(['--media', 'display-mode=window-controls-overlay']).titlebar, [0, 138, 33]);
  assert.deepEqual(parseArgs(['--media', 'display-mode=window-controls-overlay', '--titlebar', '80,0,28']).titlebar, [80, 0, 28]);
  assert.throws(() => parseArgs(['p/2']), /a route is a hash/);
  assert.throws(() => parseArgs(['--themes', 'sepia']), /--themes/);
  assert.throws(() => parseArgs(['--media', 'display-mode']), /name=value/);
  assert.throws(() => parseArgs(['--titlebar', '0,138']), /left,right,height/);
  // `eval "$(citadel-dev-copy env)"` feeds it; --url wins, and gains its slash.
  const env = { DEV_URL: 'http://127.0.0.1:2000/', DEV_COOKIE: 'cc_session=x' };
  assert.deepEqual([parseArgs([], env).url, parseArgs([], env).cookie], ['http://127.0.0.1:2000/', 'cc_session=x']);
  assert.equal(parseArgs(['--url', 'http://127.0.0.1:3000'], env).url, 'http://127.0.0.1:3000/');
  assert.throws(() => parseArgs(['--cookie', 'x'], {}), /name=value/);
  assert.equal(parseArgs(['--timeout', '2.5']).timeout, 2500);
  assert.throws(() => parseArgs(['--timeout', 'soon']), /seconds/);
});

test('steps: one a line, comments skipped, type splits at " | "', () => {
  assert.deepEqual(
    parseSteps(`
    # send a message
    type .composer textarea | Looks good | build it
    key Enter
    wait .msg:last-child
    shot sent
  `),
    [
      { verb: 'type', arg: '.composer textarea', text: 'Looks good | build it' },
      { verb: 'key', arg: 'Enter' },
      { verb: 'wait', arg: '.msg:last-child' },
      { verb: 'shot', arg: 'sent' },
    ],
  );
  // fill and wait take text the same way; a bare trailing | is an empty fill, and wait's text is optional.
  assert.deepEqual(parseSteps('fill #name |\nwait .toast | Saved | done\nwait .toast\nhover .tip'), [
    { verb: 'fill', arg: '#name', text: '' },
    { verb: 'wait', arg: '.toast', text: 'Saved | done' },
    { verb: 'wait', arg: '.toast' },
    { verb: 'hover', arg: '.tip' },
  ]);
  assert.throws(() => parseSteps('fill #name'), /fill <selector> \| <text>/);
  assert.throws(() => parseSteps('press Enter'), /the verbs are/);
  assert.throws(() => parseSteps('type textarea hello'), /type <selector> \| <text>/);
  assert.throws(() => parseSteps('shot a/b'), /a shot's name/);
  assert.throws(() => parseSteps('sleep soon'), /sleep takes ms/);
  assert.throws(() => parseSteps('click'), /needs an argument/);
});

test('file names say the route, width, theme and media', () => {
  assert.equal(shotName('', 390, 'light', []), 'front-390.png');
  assert.equal(shotName('#/p/2/t/639', 1440, 'dark', [{ name: 'display-mode', value: 'standalone' }]), 'p-2-t-639-1440-dark-standalone.png');
  assert.equal(shotName('#/p/2', 390, 'light', [], 'sent'), 'p-2-390-sent.png');
});

/** Run the in-page script against a stand-in window, as the page would before its own scripts. */
function inPage(mode: string | undefined, titlebar: [number, number, number] | undefined, sheets: object[]) {
  class CSSMediaRule {
    media: { mediaText: string };
    cssRules: object[];
    constructor(media: { mediaText: string }, cssRules: object[] = []) {
      this.media = media;
      this.cssRules = cssRules;
    }
  }
  const window: any = { matchMedia: (q: string) => ({ media: q }) };
  new Function('window', 'innerWidth', 'CSSMediaRule', 'document', emulation(mode, titlebar))(window, 1000, CSSMediaRule, { styleSheets: sheets.map((cssRules) => ({ cssRules })) });
  return { window, CSSMediaRule };
}

function styleRule(decls: Record<string, string>) {
  const values = { ...decls };
  const style: any = Object.assign(Object.keys(values), {
    getPropertyValue: (p: string) => values[p],
    getPropertyPriority: () => '',
    setProperty: (p: string, v: string) => (values[p] = v),
  });
  return { style, values };
}

test('display-mode queries match the one asked for, in matchMedia and in stylesheets', () => {
  const sheet: object[] = [];
  const { window, CSSMediaRule } = inPage('window-controls-overlay', undefined, [sheet]);
  assert.equal(window.matchMedia('(display-mode: standalone), (display-mode:window-controls-overlay)').media, '(max-width: 0px), (min-width: 0px)');
  assert.equal(window.matchMedia('not (display-mode: window-controls-overlay)').media, 'not (min-width: 0px)');
  assert.equal(window.matchMedia('(max-width: 800px)').media, '(max-width: 800px)');
  const wco = new CSSMediaRule({ mediaText: '(display-mode: window-controls-overlay)' });
  const nested = new CSSMediaRule({ mediaText: '(display-mode: standalone)' });
  sheet.push(new CSSMediaRule({ mediaText: 'screen' }, [wco, nested]));
  window.__uiShotEmulate();
  assert.deepEqual([wco.media.mediaText, nested.media.mediaText], ['(min-width: 0px)', '(max-width: 0px)']);
});

test('env(titlebar-area-*) becomes the strip, fallbacks and all', () => {
  const r = styleRule({
    'min-height': 'env(titlebar-area-height, 0px)',
    'padding-right': 'calc(1rem + 100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, calc(100vw - 2px)))',
    '--top-inset': 'env(titlebar-area-height)',
    color: 'red',
  });
  const { window } = inPage(undefined, [80, 0, 28], [[r]]);
  window.__uiShotEmulate();
  assert.deepEqual(r.values, { 'min-height': '28px', 'padding-right': 'calc(1rem + 100vw - 80px - 920px)', '--top-inset': '28px', color: 'red' });
});

test("--widths and --themes default to the turn's scheme's from the env, and a flag still wins (#1044)", () => {
  const env = { COORDINATOR_SHOT_WIDTHS: '1024,390', COORDINATOR_SHOT_THEMES: 'light,dark' };
  const o = parseArgs([], env);
  assert.deepEqual(
    [o.widths, o.themes],
    [
      [1024, 390],
      ['light', 'dark'],
    ],
  );
  assert.deepEqual(parseArgs(['--widths', '768'], env).widths, [768]);
  assert.deepEqual(parseArgs([], { COORDINATOR_SHOT_WIDTHS: 'x' }).widths, [1440, 390]);
  assert.deepEqual(parseArgs([], {}).themes, ['light']);
});

test("the prompt's screenshot line states the scheme's widths, themes, requirement and note (#1044)", async () => {
  const { shotLine } = await import('../src/prompts.ts');
  const base = { shot_widths: '1440,390', shot_themes: 'light', shots_required: 1, shot_note: '' };
  assert.match(shotLine(base), /1440, 390 px, light theme.*in your ready note\.$/);
  const l = shotLine({ ...base, shot_widths: '390', shot_themes: 'light,dark', shots_required: 0, shot_note: '1x in her window.' });
  assert.match(l, /390 px, light and dark theme/);
  assert.match(l, /optional\. 1x in her window\.$/);
});
