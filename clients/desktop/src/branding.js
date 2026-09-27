// ADR 0291 — white-label branding for the desktop shell.
//
// The shell brands ONLY its pre-connection chrome (setup page, native menu,
// app name/icon): once a host is connected, the UI is the host origin's own
// server-served SPA, which carries its own white-label branding
// (`frontend/react/WHITE-LABEL.md`, the VITE_BRAND_* seam). This module must
// therefore never grow toward a second brand resolver — it is the shell-chrome
// analogue of `src/brand/defaults.ts`, keyed with the same vocabulary.
//
// Pure logic over an injected file path (unit-testable without Electron),
// tolerant like settings.js: a missing/corrupt/partial branding.json reads as
// the stock OpenWOP defaults. CommonJS. Never throws.

'use strict';

const { readFileSync } = require('node:fs');
const { parseHostOrigin } = require('./url.js');

/** Stock OpenWOP identity + demo posture — the no-override behavior. */
const DEFAULTS = Object.freeze({
  productName: 'OpenWOP',
  appId: 'dev.openwop.desktop',
  // 'demo' shows the hosted-demo quick-connect on the setup page;
  // 'enterprise' removes every demo affordance (and honors lockedHost).
  mode: 'demo',
  defaultHost: 'http://localhost:8000',
  demoHost: 'https://app.openwop.dev',
  // Enterprise pinning: when set, the shell always loads this origin — the
  // setup page and "Change Server…" disappear entirely.
  lockedHost: null,
  helpUrl: 'https://app.openwop.dev',
  accent: '#b95c3a',
  iconSvg: '../../frontend/react/public/OpenWOP.svg',
  iconPlate: '#f4f1ea',
});

const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;

function cleanString(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function cleanOrigin(value, fallback) {
  if (value === null) return null;
  const origin = typeof value === 'string' ? parseHostOrigin(value) : null;
  return origin ?? fallback;
}

/** Full http(s) URL (path preserved — unlike hosts, a help link may have one). */
function cleanHttpUrl(value, fallback) {
  if (value === null) return null;
  if (typeof value !== 'string') return fallback;
  try {
    const u = new URL(value.trim());
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      // Bare origins stay bare (URL.toString() would append "/").
      return u.pathname === '/' && !u.search && !u.hash ? u.origin : u.toString();
    }
  } catch { /* fall through */ }
  return fallback;
}

/**
 * Validate a parsed branding object field-by-field; anything malformed falls
 * back to the stock default for that field (never a throw, never a half-broken
 * shell). Enterprise mode force-clears `demoHost` so a leftover demo entry in
 * an edited config can never resurface a demo affordance.
 */
function cleanBranding(data) {
  const src = data && typeof data === 'object' ? data : {};
  const mode = src.mode === 'enterprise' ? 'enterprise' : 'demo';
  const branding = {
    productName: cleanString(src.productName, DEFAULTS.productName),
    appId: cleanString(src.appId, DEFAULTS.appId),
    mode,
    defaultHost: cleanOrigin(src.defaultHost, DEFAULTS.defaultHost) ?? DEFAULTS.defaultHost,
    demoHost: mode === 'enterprise' ? null : cleanOrigin(src.demoHost, DEFAULTS.demoHost),
    lockedHost: cleanOrigin(src.lockedHost ?? null, null),
    helpUrl: src.helpUrl === undefined ? DEFAULTS.helpUrl : cleanHttpUrl(src.helpUrl, DEFAULTS.helpUrl),
    accent: HEX_COLOR.test(String(src.accent ?? '')) ? String(src.accent) : DEFAULTS.accent,
    iconSvg: cleanString(src.iconSvg, DEFAULTS.iconSvg),
    iconPlate: HEX_COLOR.test(String(src.iconPlate ?? '')) ? String(src.iconPlate) : DEFAULTS.iconPlate,
  };
  return branding;
}

/** Read + validate branding from `path`; missing/corrupt reads as DEFAULTS. */
function readBranding(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch { return { ...DEFAULTS }; }
  try {
    return cleanBranding(JSON.parse(raw));
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * The subset of branding the setup page needs (kept minimal on principle: the
 * renderer gets strings it renders, nothing about the build or the icon).
 */
function setupBranding(branding) {
  return {
    productName: branding.productName,
    mode: branding.mode,
    defaultHost: branding.defaultHost,
    demoHost: branding.demoHost,
    accent: branding.accent,
    // The stock OpenWOP mark is inlined in setup/index.html; a white-label
    // build renders a monogram instead. Derived here so the page stays dumb.
    stockMark: branding.productName === 'OpenWOP',
  };
}

module.exports = { DEFAULTS, cleanBranding, readBranding, setupBranding };
