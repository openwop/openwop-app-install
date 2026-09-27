// Job-search live-verify driver — the re-runnable evidence behind the
// UX-ASSESSMENT-job-search-vertical CT-3/4/6/7 and JS-FE-2 closures (goal
// round 2 phase B). Screenshots every job-search page in light+dark at
// desktop+mobile widths and probes the click-through items to the
// HTTP-reachable limit (CT-8 records the human remainder).
//
// Boot the local stack first (both from the repo root):
//   1. backend:  ( cd backend/typescript && npm run build && \
//        OPENWOP_TEST_SEAMS=true OPENWOP_DEMO_MODE=true OPENWOP_MOUNT_LOCAL_PACKS=false \
//        node lib/index.js )
//   2. frontend: ( cd frontend/react && VITE_OPENWOP_AUTH_MODE=cookie npm run dev )
//      — cookie mode is REQUIRED: the default 'bearer' leaves the driver's
//      test-login session behind and every page renders the anonymous shell.
// Then:
//   OUT=/tmp/js-verify-shots BASE_URL=http://localhost:15185 \
//     node scripts/job-search-live-verify.mjs
//
// Playwright rides the frontend workspace's own dependency.
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { chromium } = await import(join(root, 'frontend/react/node_modules/playwright-core/index.mjs'));

const API = '/api/v1/host/openwop-app';
const BASE = process.env.BASE_URL ?? 'http://localhost:15185';
const OUT = process.env.OUT ?? '/tmp/js-verify-shots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();

const login = await ctx.request.post(`${API}/test/login`, { data: { email: 'verify@e2e.test', tenantId: 'e2e-verify' } });
console.log('login', login.status());
async function enableToggle(id) {
  const get = await ctx.request.get(`${API}/feature-toggles/admin/configs/${id}`);
  if (!get.ok()) { console.log('toggle get', id, get.status()); return; }
  const config = await get.json();
  const put = await ctx.request.put(`${API}/feature-toggles/admin/configs/${id}`, { data: { ...config, id, status: 'on' } });
  console.log('toggle', id, put.status());
}
for (const id of ['job-search', 'crm', 'consent']) await enableToggle(id);
// An org first (job-search pages are org-scoped), then the EXAMPLE-DATA run
// (demo-crm + demo-job-search seeders — /example-data/seed is the agent seed).
const org = await ctx.request.post(`${API}/orgs`, { data: { name: 'Verify Co' } });
console.log('org', org.status());
const run = await ctx.request.post(`${API}/example-data/run`, { data: {} });
console.log('example-data run', run.status(), (await run.text()).slice(0, 200));

const routes = [
  ['applications', '/job-search/applications'],
  ['answers', '/job-search/answers'],
  ['exceptions', '/job-search/exceptions'],
  ['funnel', '/job-search/funnel'],
  ['listings', '/job-search/listings'],
  ['authority', '/job-search/authority'], // apply-grants live here, not /apply-grants
];
async function shoot(name, theme, vw, vh) {
  await page.setViewportSize({ width: vw, height: vh });
  await page.evaluate((t) => {
    document.documentElement.classList.remove('theme-light', 'theme-dark');
    document.documentElement.classList.add(`theme-${t}`);
  }, theme);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${name}-${theme}-${vw}.png`, fullPage: true });
}
for (const [name, route] of routes) {
  await page.goto(route);
  await page.waitForSelector('main', { timeout: 15000 });
  await page.waitForTimeout(1200);
  for (const theme of ['light', 'dark']) {
    await shoot(name, theme, 1280, 900);
    await shoot(name, theme, 375, 812);
  }
}

// CT-3/CT-4 — the share dialog + one-time link modal on /job-search/applications
await page.setViewportSize({ width: 375, height: 812 });
await page.goto('/job-search/applications');
await page.waitForTimeout(1500);
const shareBtn = page.getByRole('button', { name: /share|verification|link/i }).first();
if (await shareBtn.count()) {
  await shareBtn.click();
  await page.waitForTimeout(600);
  await shoot('ct3-share-dialog', 'light', 375, 812);
  await shoot('ct3-share-dialog', 'dark', 375, 812);
  const confirm = page.getByRole('button', { name: /create|generate|confirm|agree|share/i }).first();
  if (await confirm.count()) {
    await confirm.click();
    await page.waitForTimeout(800);
    await shoot('ct4-one-time-link', 'light', 375, 812);
  }
} else {
  console.log('CT3: no share button found on applications (state:', await page.locator('main').innerText().then((t) => t.slice(0, 120)), ')');
}

// CT-7 — answers yes/no pressed state in dark. NOTE: aria-pressed is read
// AFTER an async save round-trip; a `false` here raced the save (the unit pin
// answerBankWizard.test.tsx is the authoritative assertion) — re-read the
// screenshot before calling it a defect.
await page.setViewportSize({ width: 1280, height: 900 });
await page.goto('/job-search/answers');
await page.waitForTimeout(1500);
const yesBtn = page.getByRole('button', { name: /^yes$/i }).first();
if (await yesBtn.count()) {
  await yesBtn.click();
  await page.waitForTimeout(800);
  await page.evaluate(() => { document.documentElement.classList.add('theme-dark'); });
  await page.waitForTimeout(300);
  console.log('CT7 aria-pressed:', await yesBtn.getAttribute('aria-pressed'));
  await page.screenshot({ path: `${OUT}/ct7-answers-pressed-dark.png`, fullPage: false });
} else console.log('CT7: no yes button found');

// CT-6 — exceptions keyboard pass: aria-labels on answer fields
await page.goto('/job-search/exceptions');
await page.waitForTimeout(1500);
const fields = page.locator('main input[type="text"], main textarea, main input:not([type])');
const n = await fields.count();
const labels = [];
for (let i = 0; i < Math.min(n, 6); i++) labels.push(await fields.nth(i).getAttribute('aria-label'));
console.log('CT6 fields:', n, 'aria-labels:', JSON.stringify(labels));
await page.screenshot({ path: `${OUT}/ct6-exceptions.png`, fullPage: true });

await browser.close();
console.log('DONE — screenshots in', OUT);
