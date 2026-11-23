import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { collect, render } from '../tools/tier-scorecard.ts';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE projects (id INTEGER PRIMARY KEY, default_effort TEXT);
    CREATE TABLE tickets (id INTEGER PRIMARY KEY, project_id INT, kind TEXT, model TEXT, effort TEXT, last_model TEXT, last_effort TEXT, created_at INT);
    CREATE TABLE property_keys (id INTEGER PRIMARY KEY, key TEXT);
    CREATE TABLE properties (target_type TEXT, target_id INT, key_id INT, value TEXT);
    CREATE TABLE events (id INTEGER PRIMARY KEY, ticket_id INT, kind TEXT, data TEXT);
    CREATE TABLE turns (id INTEGER PRIMARY KEY, ticket_id INT, cost_usd REAL);
    CREATE TABLE turn_models (turn_id INT, model TEXT);
    INSERT INTO projects VALUES (1, 'high');
    INSERT INTO property_keys VALUES (1, 'type');
    INSERT INTO tickets VALUES (1, 1, 'ticket', 'claude-sonnet-5-5', 'medium', NULL, NULL, 1000);
    INSERT INTO tickets VALUES (2, 1, 'ticket', 'claude-sonnet-5-5', 'medium', NULL, NULL, 1000);
    INSERT INTO tickets VALUES (3, 1, 'ticket', NULL, NULL, 'claude-opus-5-5', NULL, 1000);
    INSERT INTO tickets VALUES (4, 1, 'ticket', 'claude-sonnet-5-5', 'medium', NULL, NULL, 10);
    INSERT INTO properties VALUES ('minion', 1, 1, 'bug'), ('minion', 2, 1, 'bug'), ('minion', 3, 1, 'feature'), ('minion', 4, 1, 'bug');
    INSERT INTO turns VALUES (1, 1, 1.5), (2, 2, 0.5), (3, 2, 0.5), (4, 3, 8), (5, 4, 99);
    -- minion 2's Grunt turn billed another model: not a step-up
    INSERT INTO turn_models VALUES (1, 'claude-sonnet-5-5'), (2, 'claude-sonnet-5-5'), (3, 'claude-opus-5-5'), (3, 'claude-sonnet-5-5'), (4, 'claude-opus-5-5');
    INSERT INTO events (ticket_id, kind, data) VALUES
      (1, 'note', '{"text":"Claude dismissed this minion: done"}'),
      (1, 'user_message', '{"text":"one more thing"}'),
      (2, 'user_message', '{"text":"Your handed-off land didn''t go through: x"}'),
      (2, 'strike', '{"strikes":[]}'),
      (3, 'note', '{"text":"Claude dismissed this minion: done"}'),
      (3, 'note', '{"text":"Taskmaster set this minion to Opus 5.5 from now on."}'),
      (3, 'note', '{"text":"Mike set this minion to medium effort from now on."}'),
      (3, 'note', '{"text":"Claude set this minion to high effort from the next turn."}');
  `);
  return db;
}

test('groups by type and tier, and each column counts what it says', () => {
  const rows = collect(fixture(), 500);
  const bug = rows.find((r) => r.type === 'bug')!;
  assert.equal(bug.tier, 'sonnet-5-5 medium');
  assert.equal(bug.minions, 2, 'the minion created before the window is left out');
  assert.equal(bug.cost, 2.5);
  assert.deepEqual(bug.counts, { reopens: 1, 'failed ships': 1, strikes: 1, 'step-ups': 0, 'person changes': 0 });
  const feat = rows.find((r) => r.type === 'feature')!;
  assert.equal(feat.tier, 'opus-5-5 high', 'falls back to the last model and the scheme default effort');
  assert.equal(feat.counts['step-ups'], 1, 'one Taskmaster note');
  assert.equal(feat.counts['person changes'], 1, "Mike's note counts, the minion's own does not");
  assert.equal(feat.counts.reopens, 0, 'dismissed with no message after is not a reopen');
});

test('render has a dated title, the table and each query', () => {
  const md = render(collect(fixture(), 500), '2026-11-19', 28);
  assert.match(md, /^# Tier scorecard \(2026-11-19\)/);
  assert.match(md, /\| bug \| sonnet-5-5 medium \| 2 \| 3 \| 1\.25 \|/);
  assert.match(md, /Taskmaster set this minion to/);
});
