import assert from 'node:assert/strict';
import { test } from 'node:test';
import { suggestTools, unknownToolName } from '../src/tool-suggest.ts';

const tools = ['mcp__peek__view_clip', 'mcp__peek__save_aura', 'mcp__peek__make_glyphs', 'mcp__peek__list_snaps', 'Read'];

test("the called name comes out of Claude Code's refusal, wrapped or not", () => {
  assert.equal(unknownToolName('<tool_use_error>Error: No such tool available: view_clip_placeholder</tool_use_error>'), 'view_clip_placeholder');
  assert.equal(unknownToolName('No such tool available: mcp__peek__roll'), 'mcp__peek__roll');
  assert.equal(unknownToolName('MCP error -32001: Request timed out'), null);
});

test('a near miss names the one or two nearest real tools by their full names', () => {
  const s = suggestTools('view_clip_placeholder', tools);
  assert.match(s!, /view_clip_placeholder/);
  assert.match(s!, /Did you mean mcp__peek__view_clip\?/);
  assert.doesNotMatch(s!, /save_aura/);
  assert.match(suggestTools('save_auras', tools)!, /mcp__peek__save_aura/);
  assert.match(suggestTools('mcp__peek__make_glyph', tools)!, /mcp__peek__make_glyphs/);
  const two = suggestTools('view_snaps', tools);
  assert.match(two!, /mcp__peek__list_snaps/);
  assert.match(two!, /mcp__peek__view_clip/);
});

test('a name with nothing near gets the plain list of tools', () => {
  const s = suggestTools('show_regions', tools);
  assert.doesNotMatch(s!, /Did you mean/);
  assert.match(s!, /Your tools are: mcp__peek__view_clip, mcp__peek__save_aura, mcp__peek__make_glyphs, mcp__peek__list_snaps, Read\./);
});

test('no known tools: no note at all', () => {
  assert.equal(suggestTools('x', []), null);
});
