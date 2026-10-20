#!/usr/bin/env node
/**
 * ADR 0927 D2 — reset the synthetic agency demo in ONE command: clear the
 * `demo-agency-ops` seeder's rows, then seed them fresh, through the existing
 * example-data endpoints (the seed lock and the toggle check apply).
 *
 *   OPENWOP_BASE_URL=https://app.openwop.dev/api OPENWOP_COOKIE='__session=…' \
 *     node scripts/demo-agency-ops-reset.mjs
 *
 * Run it signed in to the DEMO workspace (the cookie's active workspace), never a
 * customer's. It clears only the two synthetic client orgs and their rows.
 */
const base = (process.env.OPENWOP_BASE_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const cookie = process.env.OPENWOP_COOKIE;
if (!cookie) {
  console.error('Set OPENWOP_COOKIE to your session cookie for the demo workspace.');
  process.exit(2);
}
const steps = ['demo-agency-ops'];
async function post(path) {
  const res = await fetch(`${base}/host/openwop-app/example-data/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ steps }),
  });
  const body = await res.text();
  if (!res.ok) {
    console.error(`${path}: HTTP ${res.status} ${body.slice(0, 300)}`);
    process.exit(1);
  }
  return JSON.parse(body);
}
const cleared = await post('clear');
console.log('cleared:', JSON.stringify(cleared.summary ?? cleared));
const seeded = await post('run');
console.log('seeded:', JSON.stringify(seeded.summary ?? seeded));
