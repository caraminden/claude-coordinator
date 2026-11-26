// The desktop app's bridge and the browser globals the page adds.
// Part of the page's shapes: the rules and the shared core are in ../types.d.ts.

/** The desktop app's bridge (desktop/preload.cjs), on `window` only in it. */
export interface CitadelDesktop {
  app: string;
  show(): void;
  /** A PNG of `rect` (desktop/main.cjs: capturePage().toPNG(), a Buffer over IPC). */
  capture(rect: object): Promise<Uint8Array<ArrayBuffer>>;
  inspect(x: number, y: number): void;
  /** The sign-in page's saved password (desktop/saved-login.cjs). */
  savedLogin(): Promise<{ canSave: boolean; login: { login: string; password: string } | null }>;
  saveLogin(login: string, password: string): Promise<boolean>;
  forgetLogin(): Promise<boolean>;
}

declare global {
  interface Window {
    citadelDesktop?: CitadelDesktop;
  }
  interface Navigator {
    /** Chromium's Network Information API. */
    connection?: { saveData?: boolean };
  }
  interface NotificationOptions {
    renotify?: boolean;
  }
}
