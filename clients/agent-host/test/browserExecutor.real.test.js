// ADR 1136 P2b — the real-browser witness: the installed Google Chrome, driven by
// the companion's executor against a local fixture page.
//
// What it shows (P2 entry criterion 3 and condition 6):
//   - a checkbox whose page script submits the form, and a Tab key whose
//     script-bound handler submits it, both report `effects` (submitted and
//     navigated), so the host stops the session with `unapproved_effect`;
//   - a plain Tab and a plain checkbox report no effect;
//   - refs go stale on navigation;
//   - the executor refuses `file:`, `data:`, `javascript:` and private-address
//     navigations itself (the fixture host is allowed only through the
//     test-only `allowHosts`).
//
// Skipped when Google Chrome is not installed, or OPENWOP_AGENT_HOST_SKIP_REAL_BROWSER=1.
// `npm run ci` does not run this file: run `node --test` in clients/agent-host.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlaywright, PlaywrightBrowserExecutor } from '../src/browserExecutor.js';

const CHROME = '/Applications/Google Chrome.app';
const skip = process.env.OPENWOP_AGENT_HOST_SKIP_REAL_BROWSER === '1' || (process.platform === 'darwin' && !existsSync(CHROME));

const FORM = `<!doctype html><title>Form</title>
<form id="f" method="post" action="/sent">
  <label><input id="agree" type="checkbox" onchange="document.getElementById('f').submit()"> Agree and send</label>
  <label><input id="plainbox" type="checkbox"> Plain box</label>
  <label>Scripted <input id="scripted" name="a" onkeydown="if (event.key === 'Tab') { event.preventDefault(); document.getElementById('f').requestSubmit(); }"></label>
  <label>Plain <input id="plain" name="b"></label>
  <button type="submit">Send</button>
</form>
<a href="/other">Other page</a>
<a href="/download">Get the file</a>
<label>Attach <input id="up" type="file"></label>`;

let server; let base; let ex;
before(async () => {
  if (skip) return;
  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url === '/form') return res.end(FORM);
    if (req.url === '/sent') return res.end('<title>Sent</title><p>Sent</p>');
    if (req.url === '/other') return res.end('<title>Other</title><button>Nothing</button>');
    if (req.url === '/download') { res.setHeader('content-type', 'application/octet-stream'); res.setHeader('content-disposition', 'attachment; filename="x.bin"'); return res.end('BYTES'); }
    res.statusCode = 404; res.end('no');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const pw = await loadPlaywright();
  assert.ok(pw.ok, pw.reason);
  ex = new PlaywrightBrowserExecutor({ chromium: pw.chromium, profileDir: mkdtempSync(join(tmpdir(), 'owp-profile-')), executorId: 'ex_t', headless: true, allowHosts: ['127.0.0.1'] });
  await ex.start();
});
after(async () => { await ex?.stop(); server?.close(); });

const T = { timeoutMs: 10_000 };
const refOf = (snap, name) => snap.elements.find((e) => e.name.includes(name))?.ref;

test('the snapshot reports roles and refs, and a ref goes stale on navigation', { skip }, async () => {
  const r = await ex.perform({ op: 'navigate', url: `${base}/form` }, T);
  assert.equal(r.ok, true);
  const s = r.snapshot;
  assert.equal(s.title, 'Form');
  const roles = Object.fromEntries(s.elements.map((e) => [e.name, e.role]));
  assert.equal(roles['Agree and send'], 'checkbox');
  assert.equal(s.elements.find((e) => e.role === 'button' && e.name === 'Send')?.submits, true);
  assert.equal(s.elements.find((e) => e.role === 'link')?.href, `${base}/other`);
  const oldRef = refOf(s, 'Plain box');
  await ex.perform({ op: 'navigate', url: `${base}/other` }, T);
  assert.deepEqual(await ex.perform({ op: 'click', ref: oldRef }, T), { ok: false, error: 'stale_ref' });
});

test('a checkbox whose script submits reports the submit; a plain checkbox does not', { skip }, async () => {
  let s = (await ex.perform({ op: 'navigate', url: `${base}/form` }, T)).snapshot;
  const plain = await ex.perform({ op: 'click', ref: refOf(s, 'Plain box') }, T);
  assert.deepEqual(plain, { ok: true, effects: { navigated: false, submitted: false } });
  s = (await ex.perform({ op: 'snapshot' }, T)).snapshot;
  const promoted = await ex.perform({ op: 'click', ref: refOf(s, 'Agree and send') }, T);
  assert.deepEqual(promoted, { ok: true, effects: { navigated: true, submitted: true } });
});

test('a script-bound Tab handler that submits reports the submit; a plain Tab does not', { skip }, async () => {
  let s = (await ex.perform({ op: 'navigate', url: `${base}/form` }, T)).snapshot;
  const plain = await ex.perform({ op: 'press', ref: refOf(s, 'Plain'), key: 'Tab' }, T);
  assert.deepEqual(plain, { ok: true, effects: { navigated: false, submitted: false } });
  s = (await ex.perform({ op: 'snapshot' }, T)).snapshot;
  const promoted = await ex.perform({ op: 'press', ref: refOf(s, 'Scripted'), key: 'Tab' }, T);
  assert.deepEqual(promoted, { ok: true, effects: { navigated: true, submitted: true } });
});

test('a download is blocked and a file input is never filled', { skip }, async () => {
  const logs = [];
  ex.log = (m) => logs.push(m);
  let s = (await ex.perform({ op: 'navigate', url: `${base}/form` }, T)).snapshot;
  const dl = await ex.perform({ op: 'click', ref: refOf(s, 'Get the file') }, T);
  assert.equal(dl.ok, true);
  assert.ok(logs.includes('download blocked'), `logs: ${logs.join(' | ')}`);
  s = (await ex.perform({ op: 'snapshot' }, T)).snapshot;
  const up = await ex.perform({ op: 'click', ref: refOf(s, 'Attach') }, T);
  assert.equal(up.ok, true);
  assert.ok(logs.includes('file upload blocked'), `logs: ${logs.join(' | ')}`);
  assert.equal(await ex.page.evaluate(() => document.getElementById('up').files.length), 0);
});

test('the executor refuses non-web and private navigations on its own', { skip }, async () => {
  for (const url of ['file:///etc/passwd', 'chrome://settings', 'chrome-extension://abcdefghijklmnop/x.html', 'about:config', 'data:text/html,<p>x</p>', 'javascript:alert(1)', 'http://10.0.0.1/', 'http://169.254.169.254/']) {
    assert.deepEqual(await ex.perform({ op: 'navigate', url }, T), { ok: false, error: 'navigation_refused' }, url);
  }
});
