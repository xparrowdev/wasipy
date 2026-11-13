// Wasipy Desktop — Windows x64 app (Electron).
//
// The app loads the live Wasipy web app (https://wasipy.vercel.app), so the
// desktop app is always up to date — no reinstall needed when the website
// changes. The desktop shell adds:
//   - a system tray icon (Wasipy keeps running when the window is closed)
//   - native Windows notifications for due reminders
//   - auto-start when Windows starts
//   - an offline page with a retry link
//   - external links open in the default browser
const { app, BrowserWindow, Tray, Menu, Notification, shell, net } = require('electron');
const path = require('node:path');

const SITE_URL = 'https://wasipy.vercel.app/';
const REMINDERS_URL = 'https://wasipy.vercel.app/api/reminders';
// Plain Chrome user agent (no Electron token) so Google sign-in works.
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const POLL_MS = 60 * 1000;

let win = null;
let tray = null;
let quitting = false;

// Only one Wasipy at a time — a second launch just shows the open window.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', showWindow);

function showWindow() {
  if (!win) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Wasipy',
    backgroundColor: '#101013',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setUserAgent(CHROME_UA);

  // Links that open a new window go to the system browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Keep Wasipy + Google sign-in inside the app; anything else opens outside.
  win.webContents.on('will-navigate', (event, url) => {
    try {
      const host = new URL(url).hostname;
      const inside =
        host === 'wasipy.vercel.app' ||
        host === 'accounts.google.com' ||
        host.endsWith('.google.com') ||
        host.endsWith('.googleapis.com');
      if (!inside) {
        event.preventDefault();
        shell.openExternal(url);
      }
    } catch {
      // Unparseable URL — let it through rather than breaking navigation.
    }
  });

  // Closing the window hides to the tray instead of quitting.
  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    win = null;
  });

  // No internet (or the site is down): show the friendly offline page.
  win.webContents.on('did-fail-load', (_event, _code, _desc, _url, isMainFrame) => {
    if (isMainFrame && win) win.loadFile(path.join(__dirname, 'offline.html'));
  });

  win.loadURL(SITE_URL);
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'build', 'tray.png'));
  tray.setToolTip('Wasipy — your AI agent');
  const menu = Menu.buildFromTemplate([
    { label: 'Open Wasipy', click: showWindow },
    { label: 'Check reminders now', click: () => pollReminders() },
    { type: 'separator' },
    {
      label: 'Quit Wasipy',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', showWindow);
}

// Check for due reminders using the signed-in session's cookies, and fire a
// native Windows notification for each one. Quietly does nothing when the
// user is not signed in yet or the computer is offline.
async function pollReminders() {
  try {
    const res = await net.fetch(REMINDERS_URL, { method: 'GET' });
    if (!res.ok) return;
    const data = await res.json();
    for (const r of data.due || []) {
      new Notification({
        title: `Reminder: ${r.title}`,
        body: r.note || 'Wasipy reminder',
        icon: path.join(__dirname, 'build', 'icon.png'),
      }).show();
    }
  } catch {
    // Offline — the next poll will retry.
  }
}

app.whenReady().then(() => {
  // Start Wasipy automatically when Windows starts (user can turn this off
  // in Windows Settings > Apps > Startup).
  app.setLoginItemSettings({ openAtLogin: true });
  createWindow();
  createTray();
  // First reminder check after 30 seconds, then every minute.
  setTimeout(pollReminders, 30 * 1000);
  setInterval(pollReminders, POLL_MS);
});

// Keep running in the tray when all windows are closed (Windows behaviour
// for tray apps). Quit only via the tray menu.
app.on('window-all-closed', () => {});
