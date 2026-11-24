import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Strict-YAML check for skill and agent frontmatter, without a YAML dependency. Claude Code is lenient; strict
// installers (and other harnesses) reject an unquoted description holding ": " or " #" (mattpocock/skills 9201b96).
export function frontmatterProblems(text: string): string[] {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
  if (!m) return ['no frontmatter block'];
  const problems: string[] = [];
  let inBlock = false; // inside a | or > block scalar: its indented lines are free text
  for (const line of m[1].split(/\r?\n/)) {
    if (inBlock) { if (!line.trim() || /^\s/.test(line)) continue; inBlock = false; }
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const kv = /^(\s*)([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(line);
    // an indented line with no key is a continuation of a plain scalar: same rules as a value
    const indentedCont = !kv && /^\s+\S/.test(line);
    if (!kv && !indentedCont) { problems.push(`not "key: value": ${line.slice(0, 60)}`); continue; }
    const v = (kv ? kv[3] ?? '' : line.trim()).trim();
    if (!v) continue;
    const q = v[0];
    if (kv && /^[|>][+-]?\d?$/.test(v)) { inBlock = true; continue; }
    if (q === '"' || q === "'") {
      const re = q === '"' ? /^"(?:[^"\\]|\\.)*"\s*(#.*)?$/ : /^'(?:[^']|'')*'\s*(#.*)?$/;
      if (!re.test(v)) problems.push(`bad quoted value: ${v.slice(0, 60)}`);
      continue;
    }
    if (/^[|>\[{&*!%@`]/.test(v) && !/^[\[{]/.test(v)) { if (!/^[|>]/.test(v)) problems.push(`value starts with a special character: ${v.slice(0, 60)}`); continue; }
    if (/^[\[{]/.test(v)) continue; // flow collections: out of scope
    if (/:(\s|$)/.test(v)) problems.push(`unquoted ": " in value: ${v.slice(0, 60)}`);
    if (/\s#/.test(v)) problems.push(`unquoted " #" in value: ${v.slice(0, 60)}`);
  }
  return problems;
}

test('the checker rejects what a strict YAML parser rejects', () => {
  const doc = (d: string) => `---\nname: x\ndescription: ${d}\n---\nBody`;
  assert.deepEqual(frontmatterProblems(doc('Fine text, with commas. Use when (a) or b.')), []);
  assert.deepEqual(frontmatterProblems(doc("'Open it: then go # not a comment'")), []);
  assert.deepEqual(frontmatterProblems(doc('"say \\"hi\\": ok"')), []);
  assert.equal(frontmatterProblems(doc('Writing a brief: the parts')).length, 1);
  assert.equal(frontmatterProblems(doc('Writing a brief # note')).length, 1);
  assert.equal(frontmatterProblems(doc('`code` first')).length, 1);
  assert.equal(frontmatterProblems(doc("'unclosed: ")).length, 1);
});

test('every kit and repo skill and agent file has strict-YAML frontmatter', () => {
  const files = execFileSync('git', ['ls-files', 'kit/**/SKILL.md', 'kit/agents/*.md', '.claude/skills/**/SKILL.md', '.claude/agents/*.md'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.ok(files.length > 20, `expected the kit's files, found ${files.length}`);
  const bad = files.flatMap(f => frontmatterProblems(readFileSync(f, 'utf8')).map(p => `${f}: ${p}`));
  assert.deepEqual(bad, [], 'quote the value (single quotes, double any \') without changing its words');
});
