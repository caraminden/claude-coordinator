// Citadel UI: the media viewer parts. Types for /apps/_citadel/ui/media.js. A stable API: names and options are
// only ever added (test/ui-contract.test.ts checks this file against the module's exports).
// Like every file in public/ui/, standalone: apps fetch it from /apps/_citadel/ui/ beside the module.
//
// The parts store nothing: Start/End pins and pan directions come in as options and go out through callbacks,
// and the app saves them. They need base.css (buttons, notices, the dialog) and bring the rest themselves.

/** A time in seconds as m:ss, the way the parts write it: clock(75) is "1:15". */
export function clock(sec: number): string;

export interface ScrubberOptions {
  /** Frames in the strip (default 10; 0 for none). */
  frames?: number;
  /** One image of `frames` frames side by side; without it the frames are read from the clip itself. */
  sprite?: string;
  /** The Start pin in ms, or null. Playback starts here when the clip loads. */
  start?: number | null;
  /** The End pin in ms, or null. Playback stops here. */
  end?: number | null;
  /** Given: a "Start here" button (and S) pins the Start at the playhead; null when it is cleared. */
  onStart?: (ms: number | null) => void;
  /** Given: an "End here" button (and E) pins the End; null when it is cleared. */
  onEnd?: (ms: number | null) => void;
  /** false: don't jump to the Start pin when the clip loads. */
  seekToStart?: boolean;
  /**
   * What a pin does that would cross the other: 'drop' (default) clears the other pin; 'refuse' keeps both old pins, sets
   * nothing and calls onRefuse, so the app can say why.
   */
  order?: 'drop' | 'refuse';
  /** order 'refuse': the pin that was turned down, and where the person tried to put it (ms). */
  onRefuse?: (which: 'start' | 'end', ms: number) => void;
  /** false: playing up to the End pin doesn't stop there (to edit the pins past it). Default true. */
  stopAtEnd?: boolean;
  /** The keys that pin, as they are written on the keyboard (default S and E; case doesn't matter). null drops one, false both; the tooltip names only what works. */
  pinKeys?: { start?: string | null; end?: string | null } | false;
  /**
   * A person's own play, pause or seek on the bar, the strip, the keys or a click on the video (sec is where a seek went).
   * The app's own toggle(), seek() and step() don't call it, so an app that seeks the video itself can tell the two apart.
   */
  onUser?: (kind: 'play' | 'pause' | 'seek', sec?: number) => void;
}

export interface Scrubber {
  /** The bar: put it under the video. */
  el: HTMLElement;
  video: HTMLVideoElement;
  /** Play or pause (from the End pin, or from the clip's end with a Start pin and no End, play starts again at the Start). Quiet: onUser doesn't hear it. */
  toggle(): void;
  seek(sec: number): void;
  /** Move by sec, back when negative. */
  step(sec: number): void;
  /** New pins from the app (after a save, or to roll one back that failed). */
  update(pins: { start?: number | null; end?: number | null }): void;
  setStart(): void;
  setEnd(): void;
  /** Take the bar off and give the video back as it was, controls aside. */
  destroy(): void;
}

/**
 * A video's controls under it: play, a frame strip to hover and drag along, a seek bar (←/→ a second, Shift five,
 * , and . a frame), the time, mute, and Start/End pins when onStart/onEnd are given. Sets video.controls = false;
 * a click on the video plays or pauses. A file that won't play disables the bar and says why, with Try again.
 */
export function scrubber(video: HTMLVideoElement, opts?: ScrubberOptions): Scrubber;

export type PanDirection = 'auto' | 'ltr' | 'rtl' | 'off';

export interface PannerOptions {
  /** auto pans there and back from the left, rtl from the right, off holds the middle. Default auto. */
  pan?: PanDirection;
  /** Given: a direction menu in the bar, and the pick comes back here. */
  onPan?: (pan: PanDirection) => void;
  /** Milliseconds to pan one way (default 16000). */
  duration?: number;
  /** The bar's label (default "Panorama · pans end to end, Space pauses"). */
  label?: string;
  /** true: pan one leg (pan's direction, end to end; from a spot you looked at, to the next end), then stop there paused. */
  once?: boolean;
  /** A leg ended (1 for the first, then 2, …). With once, the pan has stopped. Not called while it's paused or the picture fits. */
  onLeg?: (leg: number) => void;
  /** Where the pan is in the leg it's on, 0 to 1, on every frame it moves. */
  onProgress?: (fraction: number) => void;
  /** A person paused or resumed it: Pause, Space, a press or swipe on the picture, a scroll, the slider or the mini-map. Not called for pause()/play()/look() or for once's own stop. */
  onPause?: (paused: boolean) => void;
  /** Whether the picture shows whole (true) or pans (false): once it's known, and whenever it changes. */
  onFit?: (fits: boolean) => void;
}

export interface Panner {
  /** The panner, in the img's old place. */
  el: HTMLElement;
  img: HTMLImageElement;
  /**
   * The app's layer over the picture and above the bar (`.cui-pan-over`): same box as the picture, presses pass through it, and
   * what you put on it takes presses again (`pointer-events: auto` is on its children). Put a caption or a note in it.
   */
  readonly overlay: HTMLElement;
  /** The picture shows whole, without the bar (see onFit). */
  readonly fits: boolean;
  toggle(): void;
  play(): void;
  pause(): void;
  /** Look at a spot, 0 the left end to 1 the right; it pauses there. */
  look(at: number): void;
  /** Stop and put the img back where the panner was. */
  destroy(): void;
}

/**
 * A panorama that fills its box's height and pans end to end and back, eased, with a mini-map of the window
 * (click or drag it to look), Pause and a look-around slider. Reduced motion starts it paused; a scroll, swipe or
 * press on it pauses it too. A picture that fits its box shows whole, without the bar. Give it a sized parent.
 */
export function panner(img: HTMLImageElement, opts?: PannerOptions): Panner;

export interface LightboxItem {
  src: string;
  /** Guessed from the src's extension when left out. */
  kind?: 'image' | 'video';
  alt?: string;
  caption?: string;
  /** A video's poster. */
  poster?: string;
  /** A smaller image for the filmstrip. */
  thumb?: string;
  /** Show a picture turned by a quarter, half or three quarters. */
  rotate?: 90 | 180 | 270;
  /** A video's pins and frame sprite, as ScrubberOptions has them. */
  start?: number | null;
  end?: number | null;
  sprite?: string;
  onStart?: (ms: number | null) => void;
  onEnd?: (ms: number | null) => void;
  /** A panorama's direction, as PannerOptions has it. Giving it opts this item in to panning when it's wide. */
  pan?: PanDirection;
  onPan?: (pan: PanDirection) => void;
}

export interface LightboxOptions {
  /** The item to open on (default 0). */
  at?: number;
  /** Draw inside this element, which the app sizes. Left out: the lightbox opens as a cui-dialog of its own. */
  into?: Element;
  /** A person moved to another item (‹ ›, a thumb, ←/→, a swipe). go() from the app doesn't call it. */
  onChange?: (at: number, item: LightboxItem) => void;
  /** The dialog closed (not called in `into` mode). */
  onClose?: () => void;
  /** Draw an item yourself: append to stage, and return something with toggle()/destroy() if Space should reach it. */
  render?: (item: LightboxItem, stage: HTMLElement, at: number) => { toggle?(): void; destroy?(): void } | null | void;
  /** Clips start playing as they show, muted and on a loop, as a GIF would (default false). */
  autoplay?: boolean;
  /** true: pictures at least twice as wide as tall pan (the panner). Default false: every picture shows whole, fit to the box. An item with its own `pan` or `onPan` pans either way. */
  pan?: boolean;
  /** false: no ←/→ and Space on the document. */
  keys?: boolean;
  /** The filmstrip's accessible name (default "Pictures and clips"). */
  label?: string;
}

export interface Lightbox {
  /** The dialog, or the lightbox inside `into`. */
  el: HTMLElement;
  readonly at: number;
  /** What the item on show returned: its Scrubber or Panner, if any. */
  readonly current: { toggle?(): void; destroy?(): void } | null;
  go(at: number): void;
  next(): void;
  prev(): void;
  close(): void;
  destroy(): void;
}

/**
 * Pictures and clips one at a time: ‹ › on the stage's edges (not on a phone, which swipes), a filmstrip and count under it, ←/→ and a swipe to
 * step (wrapping round), Space to play the clip or pause the pan. Clips get the scrubber; pictures show whole; with
 * `pan: true` (or an item's `pan`/`onPan`) those at least twice as wide as tall get the panner.
 */
export function lightbox(items: LightboxItem[], opts?: LightboxOptions): Lightbox;
