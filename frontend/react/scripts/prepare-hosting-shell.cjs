// ADR 0384 P4 — hosting-shell preparation (firebase predeploy).
// Firebase Hosting serves an EXACT static match before rewrites, so a static
// dist/index.html shadows the `/` → Cloud Run document rewrite and bots can
// never get the prerendered home page. Rename the shell to app-shell.html
// (the `**` catch-all + the backend's OPENWOP_SPA_SHELL_URL point there) and
// remove index.html so `/` falls through to the rewrite.
//
// CJS on purpose: the pkg-bundled firebase CLI runs predeploy hooks with its
// embedded Node, which cannot load an ESM (.mjs) hook — ERR_REQUIRE_ESM broke
// the 2026-07-17 deploy and forced a strip-the-hook workaround every deploy.
const { copyFileSync, rmSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const dist = join(__dirname, '..', 'dist');
const index = join(dist, 'index.html');
const shell = join(dist, 'app-shell.html');
if (!existsSync(index)) {
  if (existsSync(shell)) process.exit(0); // already prepared (re-deploy)
  console.error('prepare-hosting-shell: dist/index.html missing — run the build first');
  process.exit(1);
}
copyFileSync(index, shell);
rmSync(index);
console.log('prepare-hosting-shell: index.html → app-shell.html (/ falls through to the document rewrite)');
