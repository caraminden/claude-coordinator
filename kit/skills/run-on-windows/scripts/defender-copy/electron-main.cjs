// A bare Electron window on one address, for check.ps1 (#1186): nothing but the page, so a Defender detection while
// copying in it is about the process and the address, not Citadel's app. check.ps1 drives it over the debugging port.
// Usage: electron electron-main.cjs <url>  (with --remote-debugging-port=<n> before the script)
const { app, BrowserWindow } = require('electron');

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1000, height: 700, title: 'defender-copy electron' });
  win.loadURL(process.argv[process.argv.length - 1]);
});
app.on('window-all-closed', () => app.quit());
