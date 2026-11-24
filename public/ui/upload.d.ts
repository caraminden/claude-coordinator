// Citadel UI: big uploads. Types for /apps/_citadel/ui/upload.js. A stable API: names and options are only ever
// added (test/ui-contract.test.ts checks this file against the module's exports).
// Like every file in public/ui/, standalone: apps fetch it from /apps/_citadel/ui/ beside the module.
//
// In an app the endpoint is '/apps/_citadel/uploads/<your app's name>': Citadel stores the file in your DATA_DIR's
// uploads/<login>/<folder>/ and POSTs your $BASE_PATH/app-api/uploaded (contraption-ui's api.md, "Big uploads").

/** What the server answers for a finished file. In an app, `app` is what your /app-api/uploaded answered. */
export interface UploadResult {
  done: true;
  /** Where it landed: in an app, relative to DATA_DIR ("uploads/cara/Japan 2026/IMG_1.jpg"); in a shared folder, relative to it. */
  path: string;
  /** Its name there: the file's own, cleaned, with " (2)" if one was there already. */
  name: string;
  size: number;
  app?: { status: number; answer: unknown };
  [more: string]: unknown;
}

export interface Upload {
  readonly file: File;
  readonly folder: string;
  readonly size: number;
  /** Bytes the server has (or the chunk on its way has reached). */
  readonly sent: number;
  /** "paused" also when it stopped by itself: after 8 failed tries in a row, a 507 (the server's disk floor) or a refusal; see `error`. */
  readonly state: 'sending' | 'paused' | 'done' | 'cancelled';
  /** Why it stopped, when it stopped by itself; "" otherwise. */
  readonly error: string;
  readonly result: UploadResult | null;
  /** Resolves with the finished file's result, or null once cancelled. Never rejects: a failure pauses it instead. */
  readonly done: Promise<UploadResult | null>;
  /** Stop sending; what the server has stays there for 3 days. */
  pause(): void;
  /** Carry on from the server's offset. */
  resume(): void;
  /** Stop and delete what the server has. */
  cancel(): void;
}

export interface UploadOptions {
  /** The folder under the upload's place to put it in, "a/b" (at most 8 deep, none starting with a dot). */
  folder?: string;
  /** Called on every change: progress, a pause, done. */
  onChange?: (upload: Upload) => void;
}

/**
 * Upload one file in 8 MiB chunks, starting now. A dropped connection or a 5xx retries with backoff, picking up from the
 * server's offset; the same file (name, size, modified time, folder) started again within 3 days, after a reload
 * too, resumes where it got to.
 */
export function startUpload(endpoint: string, file: File, options?: UploadOptions): Upload;

/** "1.2 GB", "340 KB", "12 B". */
export function formatBytes(bytes: number): string;

/** A dropped file with its path relative to what was dropped ("Japan 2026/day 1/IMG_1.jpg"). */
export interface DroppedFile {
  file: File;
  path: string;
}

/**
 * The files a drop carries, dropped folders walked. Hidden files and folders (a dot first) come back in `skipped`, not
 * walked. Call it in the drop handler before any await: the browser empties the drop's list after.
 */
export function droppedFiles(dataTransfer: DataTransfer): Promise<{ files: DroppedFile[]; skipped: { path: string; why: string }[] }>;

export interface MountUploadOptions {
  /** Where files go: '/apps/_citadel/uploads/<app>' in an app. */
  endpoint: string;
  /** The folder everything goes under; a picked or dropped folder keeps its own folders beneath it. */
  folder?: string;
  /** Kinds to take, as <input accept>: "image/*,video/*,.heic". Others go on the "left out" line. Default all. */
  accept?: string;
  /** Offer "Choose a folder" (default true). Dropped folders are walked either way. */
  folders?: boolean;
  /** The drop zone's words (default "Drop files or folders here"). */
  label?: string;
  /** Each file once it's in place. */
  onDone?: (result: UploadResult, file: File) => void;
}

export interface UploadZone {
  readonly element: HTMLElement;
  /** Queue files as if dropped. */
  add(files: DroppedFile[]): void;
  /** Pause everything, the files still waiting their turn too. */
  pause(): void;
  resume(): void;
  /** Whether a file is still sending or waiting (worth a beforeunload warning). */
  readonly busy: boolean;
}

/**
 * Append a div.cui-upload to `root`: a drop zone with "Choose files" and "Choose a folder", then a row per file (its
 * progress, Pause or Resume, ✕ to cancel), a total with Pause all, and a line naming what it left out (hidden files,
 * kinds `accept` doesn't take). Files go one at a time. Its look is base.css's cui-upload.
 */
export function mountUpload(root: Element, options: MountUploadOptions): UploadZone;
