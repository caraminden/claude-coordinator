// Ultra reviews.
// Part of the page's shapes: the rules and the shared core are in ../types.d.ts.

// Ultra review (public/ultrareview.js; src/ultrareview.ts, src/routes/tickets.ts).
export interface UltraSize {
  files: number;
  lines: number;
}

/** GET api/tickets/:id/ultrareview: how big a review would be, before it is confirmed. */
export interface UltraCheck {
  mode: 'branch' | 'area';
  base: string;
  branch?: string;
  paths?: string[];
  size: UltraSize;
  limits: UltraSize;
  linked: boolean;
  running: boolean;
}

/** A prepped review's row, without the repo and person the server keeps. */
export interface UltraBatchRow {
  id: string;
  ticketId: number;
  by: string;
  name: string;
  paths: string[];
  question?: string;
  base: string;
  size: UltraSize;
  state: 'prepping' | 'ready' | 'running' | 'failed';
  error?: string;
  pr?: { number?: number; url?: string };
  at: number;
}

/** An area the batch form refused, by its place in what was sent. */
export interface UltraRefused {
  index?: number;
  name: string;
  error: string;
}

/** A review's chat card (the `ultrareview` event). */
export interface UltraStarted {
  id: string;
  by: string;
  mode: 'branch' | 'area';
  base?: string;
  branch?: string;
  paths?: string[];
  size: UltraSize;
  pr?: { number: number; url: string };
  question?: string;
}
