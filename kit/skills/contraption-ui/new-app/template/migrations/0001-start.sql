-- Who has opened the app: one row per person, keyed on Citadel's id (sub), never on login.
CREATE TABLE people (
  sub TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  name TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
