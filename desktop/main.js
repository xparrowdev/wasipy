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
//   - Google sign-in / service connect opens in the default browser (Chrome)
//     instead of inside the app window: the app listens on a loopback
//     address (127.0.0.1:8765) for Google's redirect back, then finishes the
//     sign-in with the server and saves the session in the app.
const { app, BrowserWindow, Tray, Menu, Notification, shell, net, dialog, session } = require('electron');
const path = require('node:path');
const http = require('node:http');

const SITE_URL = 'https://wasipy.vercel.app/';
const REMINDERS_URL = 'https://wasipy.vercel.app/api/reminders';
// Plain Chrome user agent (no Electron token) so Google sign-in works.
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const POLL_MS = 60 * 1000;
// Fixed loopback port for the Google redirect. It must match EXACTLY the
// redirect URI registered in Google Cloud
// (http://127.0.0.1:8765/auth/callback) — Web clients match the URI including
// the port, so a random port would be rejected with redirect_uri_mismatch.
const DESKTOP_AUTH_PORT = 8765;
const AUTH_CALLBACK_PATH = '/auth/callback';

let win = null;
let tray = null;
let quitting = false;
let authServer = null;
let authFlow = null;

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

  // Links that open a new window go to the system browser instead. A Google
  // sign-in link starts the desktop sign-in flow (Chrome + loopback).
  win.webContents.setWindowOpenHandler(({ url }) => {
    const auth = parseAuthUrl(url);
    if (auth) startDesktopAuth(auth.action, auth.service);
    else shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    const auth = parseAuthUrl(url);
    if (auth) {
      // Sign-in / service connect opens in the user's real browser (Chrome),
      // not inside the app window. The app itself keeps running in the
      // built-in browser as before.
      event.preventDefault();
      startDesktopAuth(auth.action, auth.service);
      return;
    }
    // Keep Wasipy + Google sign-in inside the app; anything else opens outside.
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

// ---------------------------------------------------------------------------
// Desktop sign-in: Google auth happens in the user's real browser (Chrome).
//
// Flow: the app asks our server for a Google sign-in link whose redirect is
// the app's loopback address, opens it in Chrome, and waits. After the user
// approves, Google redirects Chrome to http://127.0.0.1:8765/auth/callback,
// the app catches the code, sends it to the server, and (for login) saves
// the returned session cookie in the app — so the app is signed in even
// though the sign-in itself happened in Chrome.
// ---------------------------------------------------------------------------

// Returns { action, service } when the URL is a Wasipy Google sign-in or
// service-connect link, otherwise null.
function parseAuthUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname !== 'wasipy.vercel.app') return null;
    if (!u.pathname.startsWith('/api/auth/google')) return null;
    return {
      action: u.searchParams.get('action') || 'login',
      service: u.searchParams.get('service') || null,
    };
  } catch {
    return null;
  }
}

function cleanupAuthFlow() {
  if (authFlow && authFlow.timer) clearTimeout(authFlow.timer);
  authFlow = null;
  if (authServer) {
    try {
      authServer.close();
    } catch {}
    authServer = null;
  }
}

function authPage(ok, message) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Wasipy</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#101013;color:#f4f4f5;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}main{text-align:center;padding:32px}h1{font-size:22px;margin:0 0 8px}p{color:#a1a1aa;margin:0}.mark{width:56px;height:56px;border-radius:16px;margin:0 auto 16px;display:flex;align-items:center;justify-content:center;font-size:30px;font-weight:700;color:#fff;background:linear-gradient(135deg,#4f46e5,#7c3aed,#2563eb)}</style></head><body><main><div class="mark">W</div><h1>${
    ok ? 'All done' : 'Not completed'
  }</h1><p>${message}</p></main></body></html>`;
}

async function startDesktopAuth(action, service) {
  if (authFlow) return; // a sign-in is already in progress in the browser
  authFlow = { action, service: service || null, sessionToken: null, timer: null };

  // For connecting a service the server needs to know who is signed in.
  try {
    const cookies = await session.defaultSession.cookies.get({ url: SITE_URL });
    const c = cookies.find((x) => x.name === 'wasipy_session');
    if (c) authFlow.sessionToken = c.value;
  } catch {}

  const redirectUri = `http://127.0.0.1:${DESKTOP_AUTH_PORT}${AUTH_CALLBACK_PATH}`;

  // Local listener (this computer only) that catches Google's redirect back.
  authServer = http.createServer((req, res) => handleAuthCallback(req, res));
  try {
    await new Promise((resolve, reject) => {
      authServer.once('error', reject);
      authServer.listen(DESKTOP_AUTH_PORT, '127.0.0.1', resolve);
    });
  } catch {
    cleanupAuthFlow();
    dialog.showErrorBox(
      'Wasipy sign-in',
      `Could not start the sign-in helper (port ${DESKTOP_AUTH_PORT} is busy). Close the other app using it and try again.`
    );
    return;
  }

  // Ask our server for the Google sign-in link, then open it in Chrome.
  let data = null;
  try {
    const res = await net.fetch(`${SITE_URL}api/auth/desktop/url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action,
        service: service || undefined,
        redirectUri,
        session: authFlow.sessionToken || undefined,
      }),
    });
    data = await res.json();
  } catch {}
  if (!data || !data.ok) {
    cleanupAuthFlow();
    dialog.showErrorBox(
      'Wasipy sign-in',
      (data && data.error) || 'Could not reach Wasipy. Check your internet and try again.'
    );
    return;
  }
  await shell.openExternal(data.url);
  // The sign-in link expires after 10 minutes — stop listening after that.
  authFlow.timer = setTimeout(cleanupAuthFlow, 10 * 60 * 1000);
}

async function handleAuthCallback(req, res) {
  const flow = authFlow;
  if (!flow) {
    res.writeHead(404);
    res.end('No sign-in in progress.');
    return;
  }
  let u;
  try {
    u = new URL(req.url, `http://127.0.0.1:${DESKTOP_AUTH_PORT}`);
  } catch {
    res.writeHead(400);
    res.end('Bad request.');
    return;
  }
  if (u.pathname !== AUTH_CALLBACK_PATH) {
    res.writeHead(404);
    res.end('Not found.');
    return;
  }
  const code = u.searchParams.get('code');
  const state = u.searchParams.get('state');
  const error = u.searchParams.get('error');
  if (error || !code || !state) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(authPage(false, 'Sign-in was not completed. You can close this tab.'));
    cleanupAuthFlow();
    dialog.showErrorBox('Wasipy sign-in', 'Google sign-in was not completed.');
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(authPage(true, 'Signed in! You can close this tab and go back to Wasipy.'));

  // Finish the sign-in with our server (code -> session / connection).
  let data = null;
  try {
    const r = await net.fetch(`${SITE_URL}api/auth/desktop/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, state, session: flow.sessionToken || undefined }),
    });
    data = await r.json();
  } catch {}
  cleanupAuthFlow();
  if (!data || !data.ok) {
    dialog.showErrorBox(
      'Wasipy sign-in',
      (data && data.error) || 'Could not finish the sign-in. Please try again.'
    );
    return;
  }
  if (data.action === 'login' && data.sessionToken) {
    try {
      await session.defaultSession.cookies.set({
        url: SITE_URL,
        name: data.cookieName || 'wasipy_session',
        value: data.sessionToken,
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        expirationDate: Math.floor(Date.now() / 1000) + (data.maxAge || 30 * 24 * 3600),
      });
    } catch {
      dialog.showErrorBox(
        'Wasipy sign-in',
        'Signed in, but the app could not save the session. Please try again.'
      );
      return;
    }
    if (win) win.loadURL(SITE_URL);
  } else if (data.action === 'connect' && data.service) {
    // The ?connected= flag triggers the same celebration as on the website.
    if (win) win.loadURL(`${SITE_URL}?connected=${encodeURIComponent(data.service)}`);
  } else if (win) {
    win.loadURL(SITE_URL);
  }
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

app.on('before-quit', cleanupAuthFlow);
