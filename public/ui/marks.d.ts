// Citadel UI: marks on a picture. Types for /apps/_citadel/ui/marks.js. A stable API: names and options are
// only ever added (test/ui-contract.test.ts checks this file against the module's exports).
// Like every file in public/ui/, standalone: apps fetch it from /apps/_citadel/ui/ beside the module.
// renderMarkdown draws a marked image by itself; import this only to draw or read marks yourself.

/** One mark in image pixels: arrows and boxes use the first and last point, pins and labels the first. */
export interface Mark {
  tool: 'pen' | 'box' | 'arrow' | 'pin' | 'label';
  colour: 'red' | 'yellow';
  pts: { x: number; y: number }[];
  /** A pin's number, 0 to 99. */
  n?: number;
  /** A label's words, at most 40 characters. */
  text?: string;
}

/** The marks colours: red (the default) and yellow. */
export const COLOURS: { red: string; yellow: string };
/** The line width marks use on a w × h picture: about 1/200 of its longer edge, never under 3. */
export function lineWidth(w: number, h: number): number;
/** Draws one mark on a canvas at `width` (lineWidth's). */
export function drawMark(g: CanvasRenderingContext2D, m: Mark, width: number): void;
/** One mark as SVG elements, in image pixels. */
export function markSvg(m: Mark, width: number): string;
/** At most this many marks on one picture. */
export const MAX_MARKS: number;
/** A label's longest text. */
export const MAX_LABEL: number;
/** The marks in an image title (`marks 1280x900: box 10 20 30 40; …`), or null when it isn't a marks title or any mark in it is wrong. */
export function parseMarks(title: string | null | undefined): { w: number; h: number; marks: Mark[] } | null;
/** Marks back as an image title, the inverse of parseMarks. */
export function marksTitle(w: number, h: number, marks: Mark[]): string;
/** The `svg.cui-marks` that lies over a w × h picture and scales with it. */
export function marksOverlay(parsed: { w: number; h: number; marks: Mark[] }): string;
