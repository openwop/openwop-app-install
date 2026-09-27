// ADR 0291 — sync `branding.json` into the electron-builder fields.
//
// electron-builder reads the packaged app's name/id from `package.json`
// (`build.productName`, `build.appId`) — it cannot read branding.json itself.
// This tool is the ONE writer that keeps the two in step, so a white-label
// adopter edits branding.json only and never hand-patches package.json:
//
//   node tools/apply-branding.js      # rewrite package.json from branding.json
//   npx electron tools/make-icon.js   # re-render build/icon.png from iconSvg
//   npm run build:mac                 # package under the new identity
//
// Pure `applyBranding(pkg, branding)` is exported for `node --test`.

'use strict';

const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { readBranding } = require('../src/branding.js');

/**
 * Linux executable/desktop name: electron-builder derives it from the npm
 * package name by default, which for a scoped name (`@openwop/desktop`)
 * produces path-unsafe characters and fails the build — so it is always set
 * explicitly, slugged from the product name.
 */
function linuxExecutableName(productName) {
  const slug = productName.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'openwop-shell';
}

/** Return a new package.json object with the branded builder fields set. */
function applyBranding(pkg, branding) {
  return {
    ...pkg,
    // deb packaging requires a homepage; ride the branded help link.
    homepage: branding.helpUrl || pkg.homepage || 'https://openwop.dev/',
    build: {
      ...(pkg.build ?? {}),
      appId: branding.appId,
      productName: branding.productName,
      linux: {
        ...(pkg.build?.linux ?? {}),
        executableName: linuxExecutableName(branding.productName),
      },
    },
  };
}

function main() {
  const dir = path.join(__dirname, '..');
  const pkgPath = path.join(dir, 'package.json');
  const branding = readBranding(path.join(dir, 'branding.json'));
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const next = applyBranding(pkg, branding);
  writeFileSync(pkgPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  console.log(`[apply-branding] package.json build → productName="${next.build.productName}" appId="${next.build.appId}"`);
  console.log('[apply-branding] next: `npx electron tools/make-icon.js` to re-render build/icon.png, then package.');
}

if (require.main === module) main();

module.exports = { applyBranding };
