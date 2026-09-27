// ADR 0291 — white-label branding: validation, file tolerance, posture rules,
// and the electron-builder sync. Pure `node --test` (no Electron runtime).

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const { DEFAULTS, cleanBranding, readBranding, setupBranding } = require('../src/branding.js');
const { applyBranding } = require('../tools/apply-branding.js');

test('missing / corrupt branding.json reads as the stock defaults', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'owp-brand-'));
  assert.deepEqual(readBranding(path.join(dir, 'nope.json')), { ...DEFAULTS });
  const corrupt = path.join(dir, 'bad.json');
  writeFileSync(corrupt, '{ not json');
  assert.deepEqual(readBranding(corrupt), { ...DEFAULTS });
});

test('the tracked stock branding.json IS the defaults (no silent drift)', () => {
  assert.deepEqual(readBranding(path.join(__dirname, '..', 'branding.json')), { ...DEFAULTS });
});

test('cleanBranding falls back field-by-field on malformed values', () => {
  const b = cleanBranding({
    productName: '  ',
    mode: 'kiosk',
    defaultHost: 'not a url',
    demoHost: 'ftp://nope',
    lockedHost: 'javascript:alert(1)',
    helpUrl: 42,
    accent: 'red',
    iconPlate: '#ggg',
  });
  assert.equal(b.productName, 'OpenWOP');
  assert.equal(b.mode, 'demo');
  assert.equal(b.defaultHost, DEFAULTS.defaultHost);
  assert.equal(b.demoHost, DEFAULTS.demoHost);
  assert.equal(b.lockedHost, null);
  assert.equal(b.helpUrl, DEFAULTS.helpUrl);
  assert.equal(b.accent, DEFAULTS.accent);
  assert.equal(b.iconPlate, DEFAULTS.iconPlate);
});

test('a white-label config carries through, hosts normalized', () => {
  const b = cleanBranding({
    productName: 'Acme Flow',
    appId: 'example.acme.flow',
    mode: 'demo',
    defaultHost: 'flow.acme.example', // schemeless → coerced like url.js
    demoHost: 'https://try.acme.example/',
    helpUrl: 'https://support.acme.example/docs/flow',
    accent: '#2563eb',
  });
  assert.equal(b.productName, 'Acme Flow');
  assert.equal(b.appId, 'example.acme.flow');
  assert.equal(b.defaultHost, 'http://flow.acme.example');
  assert.equal(b.demoHost, 'https://try.acme.example');
  // helpUrl keeps its PATH (it's a link, not a host origin)
  assert.equal(b.helpUrl, 'https://support.acme.example/docs/flow');
  assert.equal(b.accent, '#2563eb');
});

test('enterprise mode force-clears demoHost and honors lockedHost', () => {
  const b = cleanBranding({
    mode: 'enterprise',
    demoHost: 'https://app.openwop.dev', // leftover demo entry must not survive
    lockedHost: 'https://flow.acme.example',
  });
  assert.equal(b.mode, 'enterprise');
  assert.equal(b.demoHost, null);
  assert.equal(b.lockedHost, 'https://flow.acme.example');
});

test('helpUrl: explicit null disables the Help menu (distinct from invalid)', () => {
  assert.equal(cleanBranding({ helpUrl: null }).helpUrl, null);
  assert.equal(cleanBranding({ helpUrl: 'nonsense::' }).helpUrl, DEFAULTS.helpUrl);
});

test('setupBranding exposes only the setup-page surface + stockMark', () => {
  const stock = setupBranding(cleanBranding({}));
  assert.deepEqual(Object.keys(stock).sort(),
    ['accent', 'defaultHost', 'demoHost', 'mode', 'productName', 'stockMark']);
  assert.equal(stock.stockMark, true);
  assert.equal(setupBranding(cleanBranding({ productName: 'Acme Flow' })).stockMark, false);
});

test('applyBranding rewrites only the builder identity fields', () => {
  const pkg = {
    name: 'openwop-desktop',
    build: { appId: 'dev.openwop.desktop', productName: 'OpenWOP', files: ['src/**/*'] },
  };
  const next = applyBranding(pkg, cleanBranding({ productName: 'Acme Flow', appId: 'example.acme.flow' }));
  assert.equal(next.build.productName, 'Acme Flow');
  assert.equal(next.build.appId, 'example.acme.flow');
  assert.deepEqual(next.build.files, ['src/**/*']); // untouched
  assert.equal(next.name, 'openwop-desktop');      // package name is internal
  assert.equal(pkg.build.productName, 'OpenWOP');   // input not mutated
});

test('applyBranding derives the Linux executable name + deb homepage', () => {
  const pkg = { name: 'openwop-desktop', build: {} };
  const acme = applyBranding(pkg, cleanBranding({ productName: 'Acme Flow!', helpUrl: 'https://acme.example' }));
  // slugged: path-safe, no leading/trailing separators (a scoped npm name
  // as the electron-builder default broke the Linux build — ADR 0291 addendum)
  assert.equal(acme.build.linux.executableName, 'acme-flow');
  assert.equal(acme.homepage, 'https://acme.example'); // deb requires one
  // helpUrl null (Help menu disabled) still leaves a valid deb homepage
  const noHelp = applyBranding(pkg, cleanBranding({ helpUrl: null }));
  assert.equal(noHelp.homepage, 'https://openwop.dev/');
  assert.equal(noHelp.build.linux.executableName, 'openwop');
});
