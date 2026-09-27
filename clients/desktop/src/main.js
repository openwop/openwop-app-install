// ADR 0181 — Electron main process for the thin desktop shell.
//
// Zero UI duplication: bundles only the setup page; once a host origin is saved
// it loads the HOST's own origin (the server-served SPA). Adds OS notifications,
// a dock/taskbar unread badge, a foreground attention cue, multi-window /
// multi-host, and the native menu. SECURITY: BrowserWindow runs with
// contextIsolation ON, sandbox ON, nodeIntegration OFF; the renderer only ever
// gets the tiny preload bridge.
//
// NOTE: this file is Electron-runtime code (requires a display + the electron
// binary), so it is exercised by manual verification, not `node --test`. The
// pure logic it delegates to (url.js, settings.js, serverManager.js) is unit
// tested.

const { app, BrowserWindow, Notification, ipcMain, Menu, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { readSettings, writeSettings, selectHost } = require('./settings.js');
const { readBranding, setupBranding } = require('./branding.js');

// ADR 0291 — white-label branding + shell posture (demo vs enterprise). The
// bundled branding.json is the trusted source; the env override exists so the
// self-test can exercise a non-stock identity without editing the bundle.
const BRANDING = readBranding(
  process.env.OPENWOP_SHELL_BRANDING || path.join(__dirname, '..', 'branding.json'),
);

// Self-test runs against an ISOLATED userData dir so a developer's saved host
// never skips the setup-page leg (and the test never touches real settings).
if (process.env.OPENWOP_SHELL_SELFTEST === '1') {
  app.setPath('userData', path.join(process.env.OPENWOP_SHELL_SELFTEST_DIR || process.cwd(), 'selftest-user-data'));
}

const SETTINGS_PATH = () => path.join(app.getPath('userData'), 'settings.json');
const SETUP_URL = pathToFileURL(path.join(__dirname, '..', 'setup', 'index.html')).href;

/** Unread badge is app-wide (one count for all windows). */
let unreadBadge = 0;
const windows = new Set();

function createWindow(targetOrigin) {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  windows.add(win);
  win.on('closed', () => windows.delete(win));

  const settings = readSettings(SETTINGS_PATH());
  // Enterprise pinning (ADR 0291): lockedHost beats the saved host, so a stale
  // settings.json from a previous install can never unpin an enterprise build.
  const origin = targetOrigin || BRANDING.lockedHost || settings.host;
  if (origin) win.loadURL(origin);
  else win.loadURL(SETUP_URL);
  return win;
}

// --- IPC: the window.openwopNative bridge lands here ----------------------

ipcMain.handle('native:notify', (_evt, params) => {
  if (!Notification.isSupported()) return false;
  const n = new Notification({
    title: String(params?.title ?? ''),
    body: String(params?.body ?? ''),
    // Coalesce duplicates (SSE reconnect racing REST) by tag.
    ...(params?.tag ? { tag: String(params.tag) } : {}),
  });
  n.on('click', () => {
    // Foreground the app + route the click back to the SPA's in-app path.
    const win = BrowserWindow.getFocusedWindow() || [...windows][0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      if (params?.navigatePath) win.webContents.send('native:notification-activated', String(params.navigatePath));
    }
  });
  n.show();
  return true;
});

ipcMain.on('native:badge', (_evt, count) => {
  unreadBadge = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  // macOS dock badge / Linux Unity count. Windows has no numeric badge API here;
  // the taskbar overlay would be the equivalent (left as a Phase-C refinement).
  if (typeof app.setBadgeCount === 'function') app.setBadgeCount(unreadBadge);
});

// --- Setup page handshake: the renderer posts a chosen host origin --------

ipcMain.handle('setup:branding', (evt) => {
  // file://-gated like its siblings: only the local setup page reads branding.
  const senderUrl = evt.senderFrame?.url ?? '';
  if (!senderUrl.startsWith('file://')) return null;
  return setupBranding(BRANDING);
});

ipcMain.handle('setup:recent-hosts', (evt) => {
  // file://-gated like save-host: only the local setup page may read settings.
  const senderUrl = evt.senderFrame?.url ?? '';
  if (!senderUrl.startsWith('file://')) return [];
  return readSettings(SETTINGS_PATH()).recent ?? [];
});

ipcMain.handle('setup:save-host', (evt, input) => {
  // SECURITY: only the LOCAL setup page (file://) may repoint the shell — a
  // remote host origin must never be able to redirect the app to another server.
  const senderUrl = evt.senderFrame?.url ?? '';
  if (!senderUrl.startsWith('file://')) return { ok: false };
  const prev = readSettings(SETTINGS_PATH());
  const next = selectHost(prev, input);
  if (!next) return { ok: false };
  writeSettings(SETTINGS_PATH(), next);
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (win) win.loadURL(next.host);
  return { ok: true, host: next.host };
});

// --- Local host lifecycle (ADR 0181 Phase E / ADR 0182) --------------------
// Config-gated integration of `ManagedProcesses`: a power user (or a future
// installer) writes `localServer: { command: ["node", ".../lib/index.js"],
// probeUrl: "http://localhost:8000/api/readiness" }` into settings.json, and
// the Server menu gains Start/Stop Local Host. Owns only what it starts
// (already-running backends are ADOPTED, never killed on quit). No config ⇒
// the menu items don't exist and this block is inert.

const { ManagedProcesses } = require('./serverManager.js');
const { spawn } = require('node:child_process');

const managed = new ManagedProcesses({
  spawnFn: (cmd, args) => spawn(cmd, args, { stdio: 'ignore', detached: false }),
  isRunningFn: async () => {
    const cfg = readSettings(SETTINGS_PATH()).localServer;
    if (!cfg?.probeUrl) return false;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 1500);
      const res = await fetch(cfg.probeUrl, { signal: ctl.signal });
      clearTimeout(t);
      return res.ok;
    } catch {
      return false;
    }
  },
});

async function startLocalHost() {
  const cfg = readSettings(SETTINGS_PATH()).localServer;
  if (!cfg?.command?.length) return;
  const [cmd, ...args] = cfg.command;
  const { started, adopted } = await managed.ensure('local-backend', cmd, args);
  if (started || adopted) {
    // Give a cold-started backend a moment, then point the focused window at it.
    const origin = cfg.origin || 'http://localhost:8000';
    setTimeout(() => {
      const w = BrowserWindow.getFocusedWindow() || [...windows][0];
      if (w) w.loadURL(origin);
    }, started ? 2500 : 0);
  }
}

app.on('will-quit', () => managed.stopAll());

// --- Native menu (so Cmd/Ctrl-A/C/V/X/Z work in webview inputs) -----------

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const localServerConfigured = Boolean(readSettings(SETTINGS_PATH()).localServer?.command?.length);
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    {
      label: 'Server',
      submenu: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
        // An enterprise build pinned to one host has no server to change to.
        ...(BRANDING.lockedHost ? [] : [
          { label: 'Change Server…', click: () => { const w = BrowserWindow.getFocusedWindow(); if (w) w.loadURL(SETUP_URL); } },
        ]),
        ...(localServerConfigured ? [
          { type: 'separator' },
          { label: 'Start Local Host', click: () => { void startLocalHost(); } },
          { label: 'Stop Local Host', click: () => managed.stop('local-backend') },
        ] : []),
      ],
    },
    { role: 'windowMenu' },
    ...(BRANDING.helpUrl ? [{
      role: 'help',
      submenu: [{ label: BRANDING.productName, click: () => shell.openExternal(BRANDING.helpUrl) }],
    }] : []),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- Self-test mode (ADR 0181 §Verification) --------------------------------
// `OPENWOP_SHELL_SELFTEST=1 npx electron .` launches the real shell, verifies
// the pieces that "need a display" end-to-end, and exits 0/1 — closing the
// ADR's "Electron runtime is not verifiable headlessly" gate:
//   1. the setup page renders and BOTH preload bridges are injected;
//   2. saving a host via the real `setup:save-host` IPC persists + navigates;
//   3. the REMOTE origin gets `window.openwopNative` (kind: 'electron').
// Screenshots land beside the JSON report in OPENWOP_SHELL_SELFTEST_DIR (or
// the cwd) so a human can eyeball light/dark rendering.
async function runSelfTest() {
  const { writeFileSync } = require('node:fs');
  const outDir = process.env.OPENWOP_SHELL_SELFTEST_DIR || process.cwd();
  const host = process.env.OPENWOP_SHELL_SELFTEST_HOST
    || BRANDING.lockedHost || BRANDING.demoHost || 'https://app.openwop.dev';
  const report = {
    setupBridges: false, setupBranded: false, hostSaved: false, remoteBridge: null, host,
    branding: { productName: BRANDING.productName, mode: BRANDING.mode, lockedHost: BRANDING.lockedHost },
  };
  let exitCode = 1;
  try {
    let win;
    if (BRANDING.lockedHost) {
      // Enterprise-pinned build: there IS no setup page — the first window must
      // load the locked origin directly. The setup legs are honestly skipped.
      report.setupBridges = 'skipped (lockedHost)';
      report.setupBranded = 'skipped (lockedHost)';
      report.hostSaved = 'skipped (lockedHost)';
      win = createWindow();
      const loaded = new Promise((res, rej) => {
        win.webContents.once('did-finish-load', res);
        win.webContents.once('did-fail-load', (_e, code, desc) => rej(new Error(`load failed: ${code} ${desc}`)));
      });
      await loaded;
    } else {
      win = createWindow();
      await new Promise((res) => win.webContents.once('did-finish-load', res));
      report.setupBridges = await win.webContents.executeJavaScript(
        "Boolean(window.openwopSetup && window.openwopNative && window.openwopNative.kind === 'electron')",
      );
      // ADR 0291: the setup page must render the branded identity, and the
      // demo quick-connect must exist exactly when the posture says demo.
      await new Promise((res) => setTimeout(res, 300)); // let the branding IPC apply
      report.setupBranded = await win.webContents.executeJavaScript(
        `(document.querySelector('.brand span')?.textContent === ${JSON.stringify(BRANDING.productName)})`
        + ` && (document.getElementById('demo').hidden === ${JSON.stringify(!(BRANDING.mode === 'demo' && BRANDING.demoHost))})`,
      );
      writeFileSync(path.join(outDir, 'selftest-setup.png'), (await win.webContents.capturePage()).toPNG());

      // Drive the REAL save path (validation + persistence), then load the host.
      const next = selectHost(readSettings(SETTINGS_PATH()), host);
      if (next) {
        writeSettings(SETTINGS_PATH(), next);
        report.hostSaved = true;
        const loaded = new Promise((res, rej) => {
          win.webContents.once('did-finish-load', res);
          win.webContents.once('did-fail-load', (_e, code, desc) => rej(new Error(`load failed: ${code} ${desc}`)));
        });
        win.loadURL(next.host);
        await loaded;
      }
    }
    // Give the SPA a beat to paint before probing + capturing.
    await new Promise((res) => setTimeout(res, 4000));
    report.remoteBridge = await win.webContents.executeJavaScript(
      "window.openwopNative ? String(window.openwopNative.kind) : null",
    );
    writeFileSync(path.join(outDir, 'selftest-app.png'), (await win.webContents.capturePage()).toPNG());
    const setupOk = BRANDING.lockedHost
      ? true
      : report.setupBridges === true && report.setupBranded === true && report.hostSaved === true;
    exitCode = setupOk && report.remoteBridge === 'electron' ? 0 : 1;
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
  }
  writeFileSync(path.join(outDir, 'selftest-report.json'), JSON.stringify(report, null, 2));
  console.log(`[selftest] ${JSON.stringify(report)}`);
  app.exit(exitCode);
}

app.whenReady().then(() => {
  if (process.env.OPENWOP_SHELL_SELFTEST === '1') { void runSelfTest(); return; }
  buildMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
