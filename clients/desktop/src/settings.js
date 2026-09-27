// ADR 0181 — persisted desktop settings (the saved host origin + recent hosts).
//
// Pure logic over an injected file path so it is unit-testable without Electron.
// In the app, the main process passes Electron's `userData/settings.json` path.
// Never throws: a missing/corrupt file reads as empty settings. CommonJS.

'use strict';

const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { dirname } = require('node:path');
const { parseHostOrigin, normalizeOrigin } = require('./url.js');

const MAX_RECENT = 8;

/**
 * ADR 0181 Phase E — validate the OPTIONAL `localServer` block (the config-gated
 * ManagedProcesses wiring): `command` a non-empty string array, `probeUrl` /
 * `origin` http(s) URLs. Anything malformed reads as "not configured" (the
 * Server menu simply doesn't grow the Start/Stop items) — never a throw.
 */
function cleanLocalServer(data) {
  if (!data || typeof data !== 'object') return undefined;
  const command = Array.isArray(data.command)
    ? data.command.filter((c) => typeof c === 'string' && c.trim()).map((c) => c.trim())
    : [];
  if (command.length === 0) return undefined;
  const probeUrl = parseHostOrigin(String(data.probeUrl ?? '')) ? String(data.probeUrl).trim() : undefined;
  const origin = parseHostOrigin(String(data.origin ?? '')) ?? undefined;
  return { command, ...(probeUrl ? { probeUrl } : {}), ...(origin ? { origin } : {}) };
}

/** Read settings from `path`, tolerating missing/corrupt files. */
function readSettings(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch { return { host: null, recent: [] }; }
  try {
    const data = JSON.parse(raw);
    const host = typeof data?.host === 'string' ? normalizeOrigin(data.host) || null : null;
    const recent = Array.isArray(data?.recent)
      ? data.recent.filter((h) => typeof h === 'string').map(normalizeOrigin).filter(Boolean)
      : [];
    const localServer = cleanLocalServer(data?.localServer);
    return { host, recent, ...(localServer ? { localServer } : {}) };
  } catch {
    return { host: null, recent: [] };
  }
}

/** Persist settings to `path` (creating the dir). Best-effort; returns bool. */
function writeSettings(path, settings) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(settings), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Set the active host to `input` (validated), moving it to the front of the
 * recent list (deduped, capped). Returns the next settings, or `null` when the
 * input is not a valid origin (caller keeps the setup page open).
 */
function selectHost(prev, input) {
  const origin = parseHostOrigin(input);
  if (!origin) return null;
  const recent = [origin, ...(prev?.recent ?? []).filter((h) => h !== origin)].slice(0, MAX_RECENT);
  // Preserve the optional localServer config across host switches.
  return { host: origin, recent, ...(prev?.localServer ? { localServer: prev.localServer } : {}) };
}

module.exports = { readSettings, writeSettings, selectHost };
