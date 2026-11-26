// A minion's time log.
// Part of the page's shapes: the rules and the shared core are in ../types.d.ts.

// Round 4b: time-log.js (GET api/tickets/:id/time-log: src/time-log.ts TimeLog)
export type TimeKind = 'work' | 'wait' | 'lost' | 'gone';

export type TimeSub = 'person' | 'ship' | 'deploy' | 'hold' | 'sealed' | 'limit' | 'job' | 'wake' | 'start' | 'stopped' | 'outside' | 'unknown' | 'kill' | 'restart' | 'cut' | 'overload' | 'finished' | 'dismissed';

export interface TimeSeg {
  start: number;
  end: number;
  kind: TimeKind;
  sub?: TimeSub;
  title?: string;
  event?: number;
  guess?: true;
  row?: number;
}

export interface TimeRow {
  type: 'step' | 'line' | 'wait';
  title: string;
  kind: TimeKind;
  sub?: TimeSub;
  status?: string;
  outcome?: string;
  continued?: true;
  more?: true;
  start: number | null;
  end: number | null;
  work: number;
  wait: number;
  lost: number;
  guess?: true;
  event?: number;
}

export interface TimeLog {
  start: number;
  end: number;
  running: boolean;
  closed: boolean;
  segs: TimeSeg[];
  rows: TimeRow[];
  totals: { work: number; wait: number; lost: number; guess: number };
  /** Haiku's reading of it (src/time-log-explain.ts ExplainView). */
  explain?: TimeExplain;
}

export interface TimeExplainLine {
  kind: 'work' | 'wait' | 'lost';
  text: string;
  ev: number[];
}

export interface TimeExplain {
  parts: Record<string, TimeExplainLine[]>;
  presses: { by: string; at: number; cost: number | null; parts: number }[];
  fresh: string[];
  writing: { by: string; at: number } | null;
}
