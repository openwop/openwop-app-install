#!/usr/bin/env node

// Persistent headless browser server wrapping Playwright.
// Communicates via HTTP on localhost. Managed by browse.sh CLI.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseAriaSnapshot } from './snapshot.mjs';
import {
  parseWaitUrlPattern,
  urlMatchesPattern,
  resolveEvalFilePath,
} from './helpers.mjs';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let browser = null;
let context = null;
const pages = new Map();      // tabId -> Page
let activeTabId = 0;
let nextTabId = 1;
const refMap = new Map();     // refId -> { role, name, nthIndex }
let lastSnapshot = null;
let idleTimer = null;
let stopping = false;
const consoleMessages = [];

const IDLE_TIMEOUT = parseInt(process.env.BROWSE_IDLE_TIMEOUT || '1800000'); // 30 min
const PROJECT_ROOT = process.env.BROWSE_PROJECT_ROOT || process.cwd();
const STATE_FILE = path.join(PROJECT_ROOT, '.browser-state.json');

// ---------------------------------------------------------------------------
// Browser lifecycle
// ---------------------------------------------------------------------------
async function ensureBrowser() {
  if (browser?.isConnected()) return;

  const pw = await import('playwright');
  browser = await pw.chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
  });

  const page = await context.newPage();
  const tabId = nextTabId++;
  pages.set(tabId, page);
  activeTabId = tabId;
  wirePageListeners(page);

  browser.on('disconnected', () => {
    if (stopping) return;
    console.error('[browser] Disconnected — exiting');
    cleanup();
    process.exit(1);
  });
}

function wirePageListeners(page) {
  page.on('console', (msg) => {
    consoleMessages.push(`[${msg.type()}] ${msg.text()}`);
    if (consoleMessages.length > 200) consoleMessages.shift();
  });
  page.on('dialog', (d) => d.accept().catch(() => {}));
}

function getPage() {
  const p = pages.get(activeTabId);
  if (!p) throw new Error('No active page. Run "newtab" first.');
  return p;
}

// ---------------------------------------------------------------------------
// Ref resolution
// ---------------------------------------------------------------------------
function resolveRef(raw) {
  const id = raw.replace(/^@/, '');
  const ref = refMap.get(id);
  if (!ref) throw new Error(`Ref @${id} not found. Run "snapshot" to get element refs.`);
  return ref;
}

function buildLocator(page, ref) {
  const opts = {};
  if (ref.name) { opts.name = ref.name; opts.exact = true; }
  let loc = page.getByRole(ref.role, opts);
  if (ref.nthIndex > 0) loc = loc.nth(ref.nthIndex);
  return loc;
}

async function getLocator(refArg) {
  const ref = resolveRef(refArg);
  const page = getPage();
  const loc = buildLocator(page, ref);
  const count = await loc.count();
  if (count === 0) {
    throw new Error(`Ref @${refArg.replace(/^@/, '')} is stale (element gone). Run "snapshot" again.`);
  }
  return loc;
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

// -- Navigation --
async function cmdGoto(args) {
  if (!args[0]) throw new Error('Usage: goto <url>');
  await ensureBrowser();
  const page = getPage();
  const resp = await page.goto(args[0], { waitUntil: 'domcontentloaded', timeout: 30000 });
  return `Navigated to ${args[0]} (${resp?.status() ?? '?'})\nTitle: ${await page.title()}`;
}

async function cmdBack() {
  await getPage().goBack({ waitUntil: 'domcontentloaded' });
  return `Back -> ${getPage().url()}`;
}

async function cmdForward() {
  await getPage().goForward({ waitUntil: 'domcontentloaded' });
  return `Forward -> ${getPage().url()}`;
}

async function cmdReload() {
  await getPage().reload({ waitUntil: 'domcontentloaded' });
  return `Reloaded ${getPage().url()}`;
}

// -- Reading --
async function cmdText(args) {
  const page = getPage();
  if (args[0]?.startsWith('@')) return await (await getLocator(args[0])).innerText();
  return await page.innerText('body');
}

async function cmdHtml(args) {
  const page = getPage();
  if (args[0]?.startsWith('@')) return await (await getLocator(args[0])).innerHTML();
  return await page.innerHTML('body');
}

async function cmdTitle() { return await getPage().title(); }
async function cmdUrl()   { return getPage().url(); }

async function cmdLinks() {
  const links = await getPage().evaluate(() =>
    Array.from(document.querySelectorAll('a[href]')).map(a => ({
      text: (a.textContent || '').trim().substring(0, 80),
      href: a.href,
    }))
  );
  if (!links.length) return 'No links found.';
  return links.map(l => `${l.text || '(empty)'} -> ${l.href}`).join('\n');
}

async function cmdEval(args) {
  if (!args.length) throw new Error('Usage: eval <javascript>');
  const result = await getPage().evaluate(args.join(' '));
  return typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result);
}

async function cmdConsole() {
  return consoleMessages.slice(-50).join('\n') || 'No console messages.';
}

// -- Interaction --
async function cmdClick(args) {
  if (!args[0]) throw new Error('Usage: click @ref | click "css-selector"');
  if (args[0].startsWith('@')) {
    await (await getLocator(args[0])).click({ timeout: 10000 });
    return `Clicked @${args[0].replace(/^@/, '')}`;
  }
  await getPage().click(args[0], { timeout: 10000 });
  return `Clicked "${args[0]}"`;
}

async function cmdFill(args) {
  if (args.length < 2) throw new Error('Usage: fill @ref "text"');
  const loc = await getLocator(args[0]);
  const text = args.slice(1).join(' ');
  await loc.fill(text);
  return `Filled @${args[0].replace(/^@/, '')} with "${text}"`;
}

// Stable alternatives to ref-based click/fill for long workflows where
// `@eN` refs drift mid-session. Targets elements by `data-testid="..."`.
// Prefer these for chat / clarification / approval automation — the app
// exposes stable test-ids on all those surfaces (see browser skill doc).
// Uses Playwright's native `getByTestId` which handles CSS-attribute
// escaping for us (no injection surface).
async function cmdClickByTestId(args) {
  if (!args[0]) throw new Error('Usage: clickByTestId <testid>');
  const testId = args[0];
  const loc = getPage().getByTestId(testId).first();
  await loc.click({ timeout: 10000 });
  return `Clicked [data-testid="${testId}"]`;
}

async function cmdFillByTestId(args) {
  if (args.length < 2) throw new Error('Usage: fillByTestId <testid> "text"');
  const testId = args[0];
  const text = args.slice(1).join(' ');
  const loc = getPage().getByTestId(testId).first();
  await loc.fill(text);
  return `Filled [data-testid="${testId}"] with "${text}"`;
}

// Load a JavaScript file from disk and run it via page.evaluate. Bypasses
// the parseCommandString quote-stripping that makes inline `eval` payloads
// fragile for anything containing strings with spaces or special chars.
// Path is resolved relative to PROJECT_ROOT so callers pass e.g.
// `evalFile tools/browser/scripts/fill-clarification.js`.
//
// Sandbox: paths MUST resolve under PROJECT_ROOT or /tmp. The server is
// loopback-only + bearer-auth'd so the risk is narrow, but this prevents
// a compromised client from reading arbitrary files on the host. Path
// resolution logic is in helpers.mjs so it's unit-testable.
async function cmdEvalFile(args) {
  if (!args[0]) throw new Error('Usage: evalFile <path-relative-to-repo-root>');
  const resolved = resolveEvalFilePath(args[0], PROJECT_ROOT);
  if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);
  const source = fs.readFileSync(resolved, 'utf8');
  const result = await getPage().evaluate(source);
  return typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result);
}

// Assert the current URL matches a substring or `/regex/` before
// returning. Fails fast instead of letting a test proceed past a
// silent redirect. Polls every 100ms for up to 10s by default.
// Pattern parsing is in helpers.mjs so it's unit-testable.
async function cmdWaitUrl(args) {
  if (!args[0]) throw new Error('Usage: waitUrl <substring | /regex/>');
  const pattern = args[0];
  const timeoutMs = args[1] ? parseInt(args[1], 10) : 10_000;
  const parsed = parseWaitUrlPattern(pattern);
  const page = getPage();
  const deadline = Date.now() + timeoutMs;
  let currentUrl = page.url();
  while (Date.now() < deadline) {
    currentUrl = page.url();
    const ok = urlMatchesPattern(currentUrl, parsed);
    if (ok) return `URL matches (${currentUrl})`;
    await page.waitForTimeout(100);
  }
  throw new Error(
    `URL did not match "${pattern}" within ${timeoutMs}ms (current: ${currentUrl})`,
  );
}

async function cmdSelect(args) {
  if (args.length < 2) throw new Error('Usage: select @ref "value"');
  await (await getLocator(args[0])).selectOption(args.slice(1).join(' '));
  return `Selected in @${args[0].replace(/^@/, '')}`;
}

async function cmdHover(args) {
  if (!args[0]) throw new Error('Usage: hover @ref');
  await (await getLocator(args[0])).hover();
  return `Hovered @${args[0].replace(/^@/, '')}`;
}

async function cmdType(args) {
  if (!args.length) throw new Error('Usage: type "text"');
  await getPage().keyboard.type(args.join(' '));
  return `Typed "${args.join(' ')}"`;
}

async function cmdPress(args) {
  if (!args[0]) throw new Error('Usage: press <key>  (Enter, Tab, Escape, ...)');
  await getPage().keyboard.press(args[0]);
  return `Pressed ${args[0]}`;
}

async function cmdCheck(args) {
  if (!args[0]) throw new Error('Usage: check @ref');
  await (await getLocator(args[0])).check();
  return `Checked @${args[0].replace(/^@/, '')}`;
}

async function cmdUncheck(args) {
  if (!args[0]) throw new Error('Usage: uncheck @ref');
  await (await getLocator(args[0])).uncheck();
  return `Unchecked @${args[0].replace(/^@/, '')}`;
}

async function cmdScroll(args) {
  const dir = args[0] || 'down';
  const amount = parseInt(args[1]) || 500;
  const map = { down: [0, amount], up: [0, -amount], right: [amount, 0], left: [-amount, 0] };
  const [dx, dy] = map[dir] || map.down;
  await getPage().mouse.wheel(dx, dy);
  return `Scrolled ${dir} ${amount}px`;
}

async function cmdWait(args) {
  if (!args[0]) throw new Error('Usage: wait <ms | css-selector>');
  const page = getPage();
  if (/^\d+$/.test(args[0])) {
    await page.waitForTimeout(parseInt(args[0]));
    return `Waited ${args[0]}ms`;
  }
  await page.waitForSelector(args[0], { timeout: 30000 });
  return `"${args[0]}" appeared`;
}

// -- Meta --
async function cmdSnapshot(args) {
  await ensureBrowser();
  const page = getPage();
  const options = {};
  let selector = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-i' || args[i] === '--interactive') options.interactive = true;
    else if ((args[i] === '-s' || args[i] === '--selector') && args[i + 1]) selector = args[++i];
  }

  const locator = selector ? page.locator(selector) : page.locator('body');
  const raw = await locator.ariaSnapshot({ timeout: 10000 });
  const { annotated, refs } = parseAriaSnapshot(raw, options);

  refMap.clear();
  for (const r of refs) refMap.set(r.id, r);
  lastSnapshot = annotated;

  const hdr = [
    `Page: ${await page.title()}`,
    `URL: ${page.url()}`,
    `Refs: ${refs.length} elements`,
    '\u2500'.repeat(60),
  ].join('\n');
  return hdr + '\n' + annotated;
}

async function cmdScreenshot(args) {
  await ensureBrowser();
  const page = getPage();
  const dir = path.join(PROJECT_ROOT, '.browser-screenshots');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const fullPage = args.includes('--full');
  const refArg = args.find(a => a.startsWith('@'));
  const explicit = args.find(a => !a.startsWith('@') && !a.startsWith('-'));
  const outPath = explicit || path.join(dir, `screenshot-${Date.now()}.png`);

  if (refArg) {
    await (await getLocator(refArg)).screenshot({ path: outPath });
  } else {
    await page.screenshot({ path: outPath, fullPage });
  }
  return `Screenshot saved: ${outPath}`;
}

async function cmdPdf(args) {
  await ensureBrowser();
  const page = getPage();
  const dir = path.join(PROJECT_ROOT, '.browser-screenshots');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const outPath = args[0] || path.join(dir, `page-${Date.now()}.pdf`);
  await page.pdf({ path: outPath, format: 'A4' });
  return `PDF saved: ${outPath}`;
}

async function cmdViewport(args) {
  if (args.length < 2) throw new Error('Usage: viewport <width> <height>');
  const [w, h] = [parseInt(args[0]), parseInt(args[1])];
  if (isNaN(w) || isNaN(h)) throw new Error('Width and height must be numbers.');
  await getPage().setViewportSize({ width: w, height: h });
  return `Viewport: ${w}x${h}`;
}

function cmdTabs() {
  const lines = [];
  for (const [id, p] of pages) {
    lines.push(`Tab ${id}${id === activeTabId ? ' *' : ''}: ${p.url()}`);
  }
  return lines.join('\n') || 'No tabs.';
}

async function cmdNewTab(args) {
  await ensureBrowser();
  const page = await context.newPage();
  const tabId = nextTabId++;
  pages.set(tabId, page);
  activeTabId = tabId;
  wirePageListeners(page);
  if (args[0]) {
    await page.goto(args[0], { waitUntil: 'domcontentloaded', timeout: 30000 });
    return `Tab ${tabId}: ${args[0]}`;
  }
  return `Tab ${tabId} (blank)`;
}

async function cmdCloseTab() {
  const page = pages.get(activeTabId);
  if (!page) throw new Error('No tab to close.');
  await page.close();
  pages.delete(activeTabId);
  const remaining = [...pages.keys()];
  activeTabId = remaining.length ? remaining[remaining.length - 1] : 0;
  return remaining.length ? `Closed. Active: tab ${activeTabId}` : 'Closed last tab.';
}

async function cmdSwitchTab(args) {
  if (!args[0]) throw new Error('Usage: tab <id>');
  const id = parseInt(args[0]);
  if (!pages.has(id)) throw new Error(`Tab ${id} not found. Run "tabs" to list.`);
  activeTabId = id;
  return `Switched to tab ${id}: ${pages.get(id).url()}`;
}

function cmdStatus() {
  return [
    `Browser: ${browser?.isConnected() ? 'connected' : 'stopped'}`,
    `Tabs: ${pages.size}`,
    `Active: tab ${activeTabId}`,
    `Refs: ${refMap.size}`,
    `URL: ${pages.get(activeTabId)?.url() || 'none'}`,
  ].join('\n');
}

async function cmdStop() {
  stopping = true;
  setTimeout(async () => { await cleanup(); process.exit(0); }, 200);
  return 'Server stopping.';
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------
const COMMANDS = {
  goto: cmdGoto, back: cmdBack, forward: cmdForward, reload: cmdReload,
  text: cmdText, html: cmdHtml, title: cmdTitle, url: cmdUrl, links: cmdLinks,
  eval: cmdEval, evalfile: cmdEvalFile, console: cmdConsole,
  click: cmdClick, fill: cmdFill, select: cmdSelect, hover: cmdHover,
  clickbytestid: cmdClickByTestId, fillbytestid: cmdFillByTestId,
  type: cmdType, press: cmdPress, check: cmdCheck, uncheck: cmdUncheck,
  scroll: cmdScroll, wait: cmdWait, waiturl: cmdWaitUrl,
  snapshot: cmdSnapshot, screenshot: cmdScreenshot, pdf: cmdPdf,
  viewport: cmdViewport, tabs: cmdTabs, newtab: cmdNewTab, closetab: cmdCloseTab,
  tab: cmdSwitchTab, status: cmdStatus, stop: cmdStop,
};

async function handleCommand(raw) {
  const { command, args } = parseCommandString(raw);
  resetIdleTimer();
  const handler = COMMANDS[command];
  if (!handler) {
    throw new Error(`Unknown command "${command}". Available: ${Object.keys(COMMANDS).join(', ')}`);
  }
  return await handler(args);
}

// ---------------------------------------------------------------------------
// Command-string parser (handles quoted args)
// ---------------------------------------------------------------------------
function parseCommandString(input) {
  const tokens = [];
  let cur = '';
  let inQ = false;
  let qch = '';

  for (const ch of input.trim()) {
    if (inQ) {
      if (ch === qch) { inQ = false; tokens.push(cur); cur = ''; }
      else cur += ch;
    } else if ((ch === '"' || ch === "'") && cur === '') {
      // Only enter quote mode at the start of a token (not mid-word like querySelector('a'))
      inQ = true; qch = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (cur) { tokens.push(cur); cur = ''; }
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push(cur);
  return { command: (tokens[0] || '').toLowerCase(), args: tokens.slice(1) };
}

// ---------------------------------------------------------------------------
// Error wrapper — make errors actionable for AI agents
// ---------------------------------------------------------------------------
function wrapError(err) {
  const m = err.message || String(err);
  if (m.includes('browserType.launch'))
    return `Error: Browser not installed. Run:  npx playwright install chromium\n${m}`;
  if (m.includes('not found') || m.includes('no element'))
    return `Error: Element not found. Run "snapshot -i" to see interactive elements.\n${m}`;
  if (m.includes('Timeout') || m.includes('timeout'))
    return `Error: Timed out.\n${m}`;
  if (m.includes('stale')) return m;
  return `Error: ${m}`;
}

// ---------------------------------------------------------------------------
// Idle timer & cleanup
// ---------------------------------------------------------------------------
function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    console.log('[server] Idle timeout — shutting down');
    await cleanup();
    process.exit(0);
  }, IDLE_TIMEOUT);
}

async function cleanup() {
  if (browser) { try { await browser.close(); } catch {} browser = null; }
  try { fs.unlinkSync(STATE_FILE); } catch {}
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
async function startServer() {
  const port = await new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });

  const token = crypto.randomUUID();

  const srv = http.createServer(async (req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200); res.end('ok'); return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401); res.end('Unauthorized'); return;
    }
    if (req.url === '/command' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const result = await handleCommand(body);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(result);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(wrapError(err));
      }
      return;
    }
    res.writeHead(404); res.end('Not found');
  });

  srv.listen(port, '127.0.0.1', () => {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ pid: process.pid, port, token, startedAt: new Date().toISOString() }, null, 2));
    console.log(`[browser-server] http://127.0.0.1:${port}  (PID ${process.pid})`);
    resetIdleTimer();
  });

  const shutdown = async () => { await cleanup(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('uncaughtException', async (e) => { console.error('[server]', e); await cleanup(); process.exit(1); });
}

startServer();
