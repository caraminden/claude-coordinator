---
name: kit-docs
extends: citadel:critique/rubrics/doc-vs-live
judges: the Citadel kit's docs and Citadel's own agent docs, against the code and kit files they describe
when: "schedule: monthly"
calibrated: "2026-11-08, sonnet: 6/6 hits, 0/1 false alarms"
input: "one item per doc: `kit/README.md`, each `.md` under `kit/skills/` and `kit/agents/`, `CLAUDE.md` and `README.md`; the repo at main"
---
# Kit docs vs live

Citadel's rubric for the monthly drift run. Kit docs name no repo's paths: what they describe is
Citadel's own behaviour and the kit itself. So the live files are the kit (skills, agents,
`kit/hooks/`), the MCP tools a doc names (`src/mcp.ts`), the turn runner (`src/runner.ts`), the
tools a doc tells an agent to run (`tools/`, and the `citadel-*` commands on PATH, read with
`command -v` and the script), and scheme-setup's Project facts table for every key a kit doc reads.

## Known blind spots

- `kit/skills/critique/rubrics/example.md` is made up on purpose: skip it.
- Third-party copies (`kit/skills/THIRD_PARTY.md` lists them) describe their upstream in places:
  a claim about the upstream project is `can't check`, not drift.
- 2026-11-08, calibration trial: the critic gave a hook missing from `kit/README.md`'s hook list
  as a note; a missing list member is blocker S5, so the doc fails on it.
