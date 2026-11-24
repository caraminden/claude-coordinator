// The desktop app's saved sign-in (#1754, Cara 2026-11-24: "Citadel's own sign-in", fill only), kept apart from Electron so
// test/desktop-saved-login.test.ts can run it. One login and password, encrypted by Electron's safeStorage (Windows DPAPI,
// tied to the Windows account) in that account's own %APPDATA%\Citadel, so a shared PC never fills one person's password
// for another. Signing out keeps it; only forget() (the sign-in page's Forget, or signing in with Remember unticked) drops it.
const { readFileSync, writeFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');

const FILE = 'saved-login.bin';
const MAX = 1000; // the server reads at most this much of a password (src/routes/app.ts)

/** `dir`: Electron's userData; `box`: safeStorage (or a stand-in with its three calls). */
function savedLogin(dir, box) {
  const file = join(dir, FILE);
  const available = () => { try { return box.isEncryptionAvailable(); } catch { return false; } };
  return {
    available,
    /** The saved { login, password }, or null: none, unreadable, or written by another Windows account. */
    get() {
      if (!available()) return null;
      try {
        const v = JSON.parse(box.decryptString(readFileSync(file)));
        return typeof v?.login === 'string' && typeof v?.password === 'string' && v.login && v.password ? { login: v.login, password: v.password } : null;
      } catch { return null; }
    },
    /** Saves it encrypted; false (and nothing written) when Windows can't encrypt or the input is bad. */
    save(login, password) {
      if (typeof login !== 'string' || typeof password !== 'string') return false;
      login = login.trim();
      if (!login || login.length > 64 || !password || password.length > MAX || !available()) return false;
      try { writeFileSync(file, box.encryptString(JSON.stringify({ login, password }))); return true; } catch { return false; }
    },
    /** Deletes it; false only when Windows refused (a file that isn't there is already forgotten). */
    forget() { try { rmSync(file, { force: true }); return true; } catch { return false; } },
  };
}

/** Whether `frame` (an IPC event's senderFrame) is Citadel's own top page: not a frame in it, not an app, not another site. */
function fromCitadel(frame, start) {
  if (!frame || frame.parent) return false;
  try {
    const url = new URL(frame.url);
    return url.origin === start.origin && !url.pathname.startsWith('/apps/');
  } catch { return false; }
}

module.exports = { savedLogin, fromCitadel };
