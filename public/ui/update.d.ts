// Citadel UI: the Android update banner. Types for /apps/_citadel/ui/update.js. A stable API: names and options are only
// ever added (test/ui-contract.test.ts checks this file against the module's exports).
// Like every file in public/ui/, standalone: apps fetch it from /apps/_citadel/ui/ beside the module.

export interface UpdateOptions {
  /** The feed Citadel publishes after each deploy, resolved against the page. Default 'android/latest.json'. */
  feed?: string;
}

export interface Update {
  versionCode: number;
  versionName: string | null;
  /** The APK's absolute URL. */
  url: string;
}

export interface MountUpdateOptions extends UpdateOptions {
  /** How the APK is opened. Default: Capacitor's Browser or AppLauncher plugin, else a plain navigation. */
  open?: (url: string) => unknown;
  /** The banner's words. Default 'A new version of the app is ready.' */
  text?: string;
  /** The button's words. Default 'Update the app'. */
  button?: string;
}

/** The update waiting for this app, or null: none newer, not inside the Android app, or the feed can't be read. */
export declare function checkUpdate(opts?: UpdateOptions): Promise<Update | null>;

/** Check for an update and, when there is one, put the banner at the top of `parent` (default document.body). Null in an app on Citadel's shared Android shell, which asks natively. */
export declare function mountUpdate(parent?: HTMLElement, opts?: MountUpdateOptions): Promise<HTMLElement | null>;
