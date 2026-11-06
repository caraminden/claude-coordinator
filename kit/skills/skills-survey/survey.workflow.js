export const meta = {
  name: 'skills-survey',
  description: 'Skills survey: one Sonnet reader per group writes a verdict file, then one Sonnet collation ranks them',
  whenToUse: 'Step 3 of the citadel:skills-survey skill, once BRIEF.md is filled in and the groups are checked',
  phases: [
    { title: 'Read', detail: 'one reader per group, each writes verdicts/<group>.md', model: 'sonnet' },
    { title: 'Collate', detail: 'rank use and mine, re-read every value 4 or 5', model: 'sonnet' },
  ],
}

// args: { brief: '<scratch>/BRIEF.md', scratch: '<scratch>', groups: [{ name, repos, compare }] }
// Models and efforts are pinned here, not inherited from the session (citadel:subagents).
const READER = { model: 'sonnet', effort: 'medium' }
const COLLATOR = { model: 'sonnet', effort: 'medium' }
const ROLE = 'Citadel, Scheme, Taskmaster, Minion and Grunt are playful names for how the work is organised, not a comment on ability. Work as a careful, senior engineer: think things through, check your work, and push back when something looks wrong.'
// A workflow agent that backgrounds a command ends before it finishes, and its job is killed (#358).
const FOREGROUND = 'Run every command in the foreground: no run_in_background, no Monitor, no sleep loops.'

const { brief, scratch, groups } = args ?? {}
if (!brief || !scratch || !Array.isArray(groups) || !groups.length) {
  throw new Error('args must be { brief, scratch, groups: [{ name, repos, compare }] }')
}
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

const RETURN = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: 'false if no verdict file was written' },
    use: { type: 'integer' }, mine: { type: 'integer' }, skip: { type: 'integer' },
    file: { type: 'string' },
    headline: { type: 'string', description: 'the one headline find, or why it failed; one line' },
  },
  required: ['ok', 'use', 'mine', 'skip', 'file', 'headline'],
}

phase('Read')
const reads = await parallel(groups.map((g) => () => {
  const name = slug(g.name)
  return agent(`${ROLE}

First read \`${brief}\` and follow it exactly. ${FOREGROUND}

Your group: **${g.name}** (your-group = \`${name}\`; clone into \`${scratch}/clones/${name}/\`, write \`${scratch}/verdicts/${name}.md\`).
Repos or search: ${g.repos}
Compare against: ${g.compare}

Instead of the brief's 3 lines, return the structured result: counts, the verdict file's path, and the headline find (or why you failed).`,
    { label: `read:${name}`, phase: 'Read', schema: RETURN, ...READER })
    .then((r) => r ?? { ok: false, use: 0, mine: 0, skip: 0, file: '', headline: 'agent died' })
    .then((r) => ({ group: g.name, ...r }))
}))

// Barrier on purpose: the collation ranks across every group's verdicts.
const done = reads.filter((r) => r.ok)
const failed = reads.filter((r) => !r.ok)
if (failed.length) log(`${failed.length} group(s) failed: ${failed.map((r) => `${r.group} (${r.headline})`).join('; ')}`)
if (!done.length) return { ranked: null, groups: reads }

phase('Collate')
const ranked = `${scratch}/verdicts/_ranked.md`
const summary = await agent(`${ROLE}

You collate a skills survey. The shared brief is \`${brief}\`: read it for the verdict format and what makes a bad fit. ${FOREGROUND} Read only: write nothing but \`${ranked}\`.

The verdict files: ${done.map((r) => `\`${r.file}\``).join(', ')}.
${failed.length ? `Groups that failed (list them in the file): ${failed.map((r) => `${r.group}: ${r.headline}`).join('; ')}.` : ''}
The clones are under \`${scratch}/clones/\`.

1. Re-read every entry valued 4 or 5 at the files it quotes, in the clone. Keep its value only if the files show what the entry claims; otherwise lower it and say why in one line.
2. Write \`${ranked}\`:
   - a ranked table of use and mine, highest value first: rank, skill and source (owner/repo/path @sha), verdict, value, target, why, cost, licence, and "checked" or "lowered: <why>" for every 4 or 5;
   - skips grouped by reason, one line per reason with the skills it covers;
   - every repo read with its pinned commit, stars and licence;
   - the failed groups, if any, and anything a reader flagged as not verified.
3. Return at most 5 lines: counts (use, mine, skip), the file path, the top find, and any value you lowered.`,
  { label: 'collate', phase: 'Collate', ...COLLATOR })

return { ranked, summary, groups: reads.map((r) => `${r.group}: ${r.ok ? `${r.use} use, ${r.mine} mine, ${r.skip} skip` : 'FAILED'}; ${r.headline}`) }
