// ADR 0181 — preload: inject the tiny `window.openwopNative` bridge the SPA's
// nativeBridge.ts feature-detects. SECURITY (architect ruling): this runs with
// contextIsolation ON; it exposes ONLY the minimal, string/number surface via
// contextBridge — never `ipcRenderer` itself, never Node. The renderer loads a
// remote host origin, so nothing beyond this surface is reachable.

const { contextBridge, ipcRenderer } = require('electron');

const activationCallbacks = new Set();

// The main process forwards a notification click (with the in-app path).
ipcRenderer.on('native:notification-activated', (_evt, path) => {
  for (const cb of activationCallbacks) {
    try { cb(String(path ?? '')); } catch { /* never let one listener break others */ }
  }
});

contextBridge.exposeInMainWorld('openwopNative', {
  kind: 'electron',
  // Fire an OS notification; resolves true when shown. Params are plain
  // strings/booleans only (serialization-safe over IPC).
  notify: (params) => ipcRenderer.invoke('native:notify', {
    title: String(params?.title ?? ''),
    body: String(params?.body ?? ''),
    tag: params?.tag ? String(params.tag) : undefined,
    navigatePath: params?.navigatePath ? String(params.navigatePath) : undefined,
    requireInteraction: params?.requireInteraction === true,
  }),
  // Paint the dock/taskbar badge; 0 clears it.
  setBadgeCount: (count) => ipcRenderer.send('native:badge', Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0),
  // Subscribe to OS-notification clicks → returns an unsubscribe.
  onNotificationActivated: (callback) => {
    if (typeof callback !== 'function') return () => {};
    activationCallbacks.add(callback);
    return () => activationCallbacks.delete(callback);
  },
});

// Setup-page bridge. The `setup:save-host` main handler is guarded to accept
// ONLY file:// senders (the local setup page), so exposing this to a remote
// origin is inert — a host cannot repoint the shell.
contextBridge.exposeInMainWorld('openwopSetup', {
  saveHost: (input) => ipcRenderer.invoke('setup:save-host', String(input ?? '')),
  // Read-only recent-hosts list for the setup page (main gates to file:// senders).
  recentHosts: () => ipcRenderer.invoke('setup:recent-hosts'),
  // White-label branding for the setup chrome (ADR 0291; file://-gated in main).
  branding: () => ipcRenderer.invoke('setup:branding'),
});
