#!/usr/bin/env node
/**
 * Runtime CSP verification. Serves the built `dist/` with the CSP from
 * firebase.json applied as ENFORCING (the `-Report-Only` suffix dropped),
 * loads every app route in a real Chromium, and fails if the page reports any
 * CSP violation. This turns the "deploy report-only and watch" step into a
 * local, deterministic gate for everything that happens on boot + navigation
 * (the SPA shell: scripts, styles, fonts, images, and the Firebase-SDK /
 * capabilities connects that fire at init).
 *
 * NOT a CI gate by default (needs a browser). Run: npm run check:csp-runtime.
 *
 * Known gap it cannot cover: the INTERACTIVE Google sign-in popup flow
 * (OAuth can't be driven headless) — its connect/frame/script origins are
 * enumerated from code, not runtime-verified here.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { chromium } from '@playwright/test';

const DIST = 'dist';
if (!existsSync(join(DIST, 'index.html'))) {
  console.error(`check-csp-runtime: ${DIST}/index.html missing — run \`npm run build\` first.`);
  process.exit(1);
}

// Derive the enforcing CSP from firebase.json's report-only value.
const fb = JSON.parse(readFileSync('../../firebase.json', 'utf8'));
const headers = fb.hosting.headers.flatMap((h) => h.headers);
const csp = headers.find((h) => /Content-Security-Policy/i.test(h.key))?.value;
if (!csp) { console.error('check-csp-runtime: no CSP found in firebase.json'); process.exit(1); }
console.log('Enforcing CSP:\n  ' + csp + '\n');

const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.map': 'application/json' };

const server = createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  let file = join(DIST, normalize(url).replace(/^(\.\.[/\\])+/, ''));
  // SPA fallback: non-asset paths → index.html
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html');
  const body = readFileSync(file);
  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('Content-Type', MIME[extname(file)] ?? 'text/html; charset=utf-8');
  res.end(body);
});

await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const base = `http://localhost:${port}`;

const ROUTES = ['/', '/agents', '/builder', '/boards', '/inbox', '/prompts', '/memory', '/keys', '/capabilities', '/cli', '/runs', '/mission', '/orgs', '/admin', '/roster', '/compare', '/workforces', '/example-data', '/privacy'];

const browser = await chromium.launch();
const violations = [];
for (const route of ROUTES) {
  const page = await browser.newPage();
  page.on('console', (msg) => {
    const t = msg.text();
    if (/Content Security Policy|Refused to (load|execute|connect|apply|frame)/i.test(t)) {
      violations.push({ route, text: t });
    }
  });
  page.on('pageerror', (err) => {
    if (/Content Security Policy/i.test(String(err))) violations.push({ route, text: String(err) });
  });
  await page.goto(`${base}${route}`, { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(800); // let Firebase init + boot fetches fire
  await page.close();
}
await browser.close();
server.close();

if (violations.length === 0) {
  console.log(`✓ check-csp-runtime: 0 CSP violations across ${ROUTES.length} routes under the enforcing policy.`);
  process.exit(0);
}
console.error(`✗ check-csp-runtime: ${violations.length} CSP violation(s):`);
const seen = new Set();
for (const v of violations) {
  const key = v.text.slice(0, 160);
  if (seen.has(key)) continue;
  seen.add(key);
  console.error(`  [${v.route}] ${v.text.slice(0, 240)}`);
}
process.exit(1);
