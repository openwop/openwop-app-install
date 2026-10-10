/**
 * ADR 0785 P2 / D4 — the two WebSocket roles, over the host upgrade registry.
 *
 *   DEVICE  `/host/openwop-app/claude-code/device`
 *     The companion. Authenticated by its developer key as a Bearer header and
 *     nothing else. A browser cannot set that header on a WebSocket, and a
 *     request carrying an Origin IS a browser, so a device upgrade with an Origin
 *     is refused outright (no cross-site socket can ever act as a device).
 *
 *   VIEWER  `/host/openwop-app/claude-code/terminal/:sessionId?ticket=…`
 *     A browser tab. Origin-checked (CSWSH), then authenticated by a short-lived
 *     HMAC ticket minted over the signed-in `/api` session, bound to the tenant,
 *     the subject and the session. v1 viewers are the session's owner only.
 *
 * Both run the operator gate and the toggle before the handshake, and every
 * failure rejects the upgrade (the collab boundary, item for item). The key is
 * re-verified on every heartbeat, so a revoked device's socket closes within one
 * interval even if the revocation happened on another instance.
 */
import type { IncomingMessage } from 'node:http';
import { apiKeyIssuerRefused } from '../../middleware/auth.js';
import type { Duplex } from 'node:stream';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import { createLogger } from '../../observability/logger.js';
import { runUnderWorkerContract } from '../../storage/eventEraAdapter.js';
import { base64urlDecode, base64urlEncode, readSessionSecret } from '../../middleware/cookieSession.js';
import { originPolicy } from '../../middleware/cors.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { getInstanceId } from '../../host/instanceId.js';
import { publishHostExtEvent, subscribeHostExtEvent } from '../../host/hostExtPersistence.js';
import { denyUpgrade, registerUpgradeHandler, upgradePathname } from '../../host/upgradeRegistry.js';
import { VENDOR_ROOT } from '../../middleware/protocolVersion.js';
import { verifyApiKey } from '../developer-keys/apiKeyService.js';
import { CLAUDE_CODE_TOGGLE, claudeCodeOperatorEnabled } from './constants.js';
import { deviceForKey } from './pairingService.js';
import { TerminalRelay, type DeviceFrame, type RelayConn } from './terminalRelay.js';
import { clearPresence, getTerminalSession, markPresent, setTerminalStatus } from './terminalStore.js';

const log = createLogger('claude-code.terminal');

// Built from VENDOR_ROOT, the ADR 0652 version-agnostic vendor root the negotiator
// already serves unversioned — never as a literal, which would read to the
// unversioned-mount guard as this feature claiming a NEW root (`/host`).
const TERMINAL_ROOT = `${VENDOR_ROOT}/claude-code`;
const DEVICE_PATH = `${TERMINAL_ROOT}/device`;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const VIEWER_RE = new RegExp(`^${escapeRe(TERMINAL_ROOT)}/terminal/([A-Za-z0-9_-]{4,64})$`);
/** One PTY frame from a device or a viewer. Above this the socket is closed (1009). */
const MAX_PAYLOAD = 1024 * 1024;
const HEARTBEAT_MS = 30_000;
const TICKET_TTL_MS = 60_000;
const MAX_VIEWERS_PER_SESSION = 4;

let relay: TerminalRelay | null = null;

export function getRelay(): TerminalRelay {
  if (!relay) {
    relay = new TerminalRelay({
      instanceId: getInstanceId(),
      publish: publishHostExtEvent,
      subscribe: subscribeHostExtEvent,
      hooks: {
        onOpened: (sessionId) => { void setTerminalStatus(sessionId, 'running'); },
        onExit: (sessionId, code) => { void setTerminalStatus(sessionId, 'exited', code); },
      },
    });
  }
  return relay;
}

// ── Viewer tickets ──────────────────────────────────────────────────────────

interface Ticket { t: string; s: string; u: string; exp: number }
const TICKET_CONTEXT = 'owp-claude-code-terminal-ticket.v1';

export function mintViewerTicket(tenantId: string, sessionId: string, subject: string, now = Date.now()): string {
  const payload = base64urlEncode(Buffer.from(JSON.stringify({ t: tenantId, s: sessionId, u: subject, exp: now + TICKET_TTL_MS } satisfies Ticket)));
  const mac = createHmac('sha256', readSessionSecret()).update(`${TICKET_CONTEXT}.${payload}`).digest();
  return `${payload}.${base64urlEncode(mac)}`;
}

export function verifyViewerTicket(ticket: string, sessionId: string, now = Date.now()): Ticket | null {
  const [payload, sig] = ticket.split('.');
  if (!payload || !sig) return null;
  const expected = createHmac('sha256', readSessionSecret()).update(`${TICKET_CONTEXT}.${payload}`).digest();
  const given = base64urlDecode(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let t: Ticket;
  try { t = JSON.parse(base64urlDecode(payload).toString('utf8')) as Ticket; } catch { return null; }
  if (t.s !== sessionId || typeof t.exp !== 'number' || t.exp < now) return null;
  return t;
}

// ── Sockets ─────────────────────────────────────────────────────────────────

function asConn(ws: WebSocket): RelayConn {
  return {
    sendJson: (m) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); },
    sendBinary: (d) => { if (ws.readyState === ws.OPEN) ws.send(d, { binary: true }); },
    close: (code, reason) => { try { ws.close(code, reason.slice(0, 120)); } catch { /* closed */ } },
  };
}

const toBuffer = (data: RawData): Buffer => (Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer));

interface LiveDevice { deviceId: string; tenantId: string; token: string; ws: WebSocket; conn: RelayConn; connectedAt: string }
const liveDevices = new Map<string, LiveDevice>();
let heartbeat: NodeJS.Timeout | null = null;

function ensureHeartbeat(): void {
  if (heartbeat) return;
  // ADR 0650 — it writes presence rows, so it enters the seat under the named contract.
  heartbeat = setInterval(() => { void runUnderWorkerContract(() => beat()); }, HEARTBEAT_MS);
  heartbeat.unref();
}

async function beat(): Promise<void> {
  const r = getRelay();
  for (const d of liveDevices.values()) {
    // Revocation anywhere reaches here: an invalid key closes the socket.
    // ADR 0833 D1 (S11) — and so does an issuer who is no longer live (disabled,
    // removed): the upgrade asked that question, the heartbeat did not, so a
    // device paired by a since-disabled user stayed connected.
    const key = await verifyApiKey(d.token);
    if (!key || (await apiKeyIssuerRefused(key.keyId, key.tenantId))) { d.conn.close(4001, 'device key revoked or expired'); continue; }
    await markPresent(d.deviceId, d.tenantId, r.instanceId, d.connectedAt).catch(() => undefined);
  }
  await r.refreshInterest().catch(() => undefined);
}

/** Test seam: run one heartbeat now instead of waiting `HEARTBEAT_MS`. */
export const __runTerminalHeartbeatForTest = (): Promise<void> => beat();

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

function parseDeviceFrame(raw: Buffer): DeviceFrame | null {
  let m: Record<string, unknown>;
  try { m = JSON.parse(raw.toString('utf8')) as Record<string, unknown>; } catch { return null; }
  const sid = m.sessionId;
  if (typeof sid !== 'string' || !/^[A-Za-z0-9_-]{4,64}$/.test(sid)) return null;
  switch (m.type) {
    case 'output': return typeof m.data === 'string' ? { type: 'output', sessionId: sid, data: m.data } : null;
    case 'replay': return typeof m.data === 'string' && typeof m.viewerId === 'string' ? { type: 'replay', sessionId: sid, viewerId: m.viewerId, data: m.data } : null;
    case 'opened': return { type: 'opened', sessionId: sid, generation: Number(m.generation) || 0 };
    case 'exit': return { type: 'exit', sessionId: sid, code: typeof m.code === 'number' ? m.code : null, requested: m.requested === true };
    case 'error': return { type: 'error', sessionId: sid, message: String(m.message ?? '').slice(0, 500) };
    default: return null;
  }
}

async function handleDevice(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  if (!claudeCodeOperatorEnabled()) { denyUpgrade(socket, 404, 'Not Found'); return; }
  // A browser always sends Origin; a device never does. No browser may be a device.
  if (req.headers.origin) { denyUpgrade(socket, 403, 'Forbidden'); return; }
  const auth = req.headers.authorization ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const key = token ? await verifyApiKey(token) : null;
  // ADR 0795 D6 — this lane verifies the key itself, so it asks the same
  // question the auth middleware does: is whoever issued it still here?
  if (!key || (await apiKeyIssuerRefused(key.keyId, key.tenantId))) { denyUpgrade(socket, 401, 'Unauthorized'); return; }
  const device = await deviceForKey(key.keyId, key.tenantId);
  if (!device) { denyUpgrade(socket, 403, 'Forbidden'); return; } // a key, but not a paired device's
  const toggle = await resolveOne(CLAUDE_CODE_TOGGLE, { tenantId: device.tenantId, userId: device.subject });
  if (!toggle?.enabled) { denyUpgrade(socket, 404, 'Not Found'); return; }

  wss.handleUpgrade(req, socket, head, (ws) => {
    const conn = asConn(ws);
    const live: LiveDevice = { deviceId: device.deviceId, tenantId: device.tenantId, token, ws, conn, connectedAt: new Date().toISOString() };
    const r = getRelay();
    liveDevices.set(device.deviceId, live);
    ensureHeartbeat();
    void r.attachDevice(device.deviceId, conn).then(() => markPresent(device.deviceId, device.tenantId, r.instanceId, live.connectedAt));
    conn.sendJson({ type: 'hello', deviceId: device.deviceId });
    log.info('device_connected', { deviceId: device.deviceId, tenantId: device.tenantId });

    // A device may only speak for sessions opened on IT. Decided ONCE per session
    // per socket (review finding: a store read per output frame put steady load on
    // the database for every busy terminal). Sessions are never re-assigned to
    // another device, so the answer cannot go stale.
    const owned = new Map<string, Promise<boolean>>();
    const ownsSession = (sessionId: string): Promise<boolean> => {
      let v = owned.get(sessionId);
      if (!v) {
        v = getTerminalSession(sessionId).then((s) => Boolean(s && s.deviceId === device.deviceId)).catch(() => false);
        owned.set(sessionId, v);
        if (owned.size > 256) owned.delete(owned.keys().next().value as string);
      }
      return v;
    };
    ws.on('message', (data, isBinary) => {
      if (isBinary) return; // devices speak JSON frames only
      const frame = parseDeviceFrame(toBuffer(data));
      if (!frame) return;
      void (async () => {
        if (!(await ownsSession(frame.sessionId))) return;
        await r.onDeviceFrame(frame);
      })().catch((err: unknown) => log.warn('device_frame_failed', { error: err instanceof Error ? err.message : String(err) }));
    });
    ws.on('close', () => {
      if (liveDevices.get(device.deviceId)?.ws === ws) liveDevices.delete(device.deviceId);
      void r.detachDevice(device.deviceId, conn).then(() => clearPresence(device.deviceId, r.instanceId));
    });
  });
}

async function handleViewer(req: IncomingMessage, socket: Duplex, head: Buffer, sessionId: string): Promise<void> {
  if (!claudeCodeOperatorEnabled()) { denyUpgrade(socket, 404, 'Not Found'); return; }
  if (!originPolicy().allowed(req.headers.origin)) { denyUpgrade(socket, 403, 'Forbidden'); return; }
  const url = new URL(req.url ?? '/', 'http://x');
  const ticket = verifyViewerTicket(url.searchParams.get('ticket') ?? '', sessionId);
  if (!ticket) { denyUpgrade(socket, 401, 'Unauthorized'); return; }
  const s = await getTerminalSession(sessionId);
  // Uniform 404: no session, not this tenant, not this person, or already over.
  if (!s || s.tenantId !== ticket.t || s.subject !== ticket.u || s.status === 'exited') { denyUpgrade(socket, 404, 'Not Found'); return; }
  const toggle = await resolveOne(CLAUDE_CODE_TOGGLE, { tenantId: s.tenantId, userId: s.subject });
  if (!toggle?.enabled) { denyUpgrade(socket, 404, 'Not Found'); return; }
  const r = getRelay();
  if (r.localViewerCount(sessionId) >= MAX_VIEWERS_PER_SESSION) { denyUpgrade(socket, 429, 'Too Many Requests'); return; }

  wss.handleUpgrade(req, socket, head, (ws) => {
    const conn = asConn(ws);
    ensureHeartbeat();
    const attached = r.attachViewer(sessionId, s.deviceId, conn);
    ws.on('message', (data, isBinary) => {
      void attached.then(async () => {
        if (isBinary) return;
        let m: { type?: string; data?: string; cols?: number; rows?: number };
        try { m = JSON.parse(toBuffer(data).toString('utf8')) as typeof m; } catch { return; }
        if (m.type === 'input' && typeof m.data === 'string') await r.viewerInput(sessionId, Buffer.from(m.data, 'base64'));
        else if (m.type === 'resize' && Number.isFinite(m.cols) && Number.isFinite(m.rows)) await r.viewerResize(sessionId, Number(m.cols), Number(m.rows));
      }).catch(() => undefined);
    });
    ws.on('close', () => { void attached.then((viewerId) => r.detachViewer(sessionId, viewerId)); });
  });
}

let registered = false;

/** Called from the feature's `registerRoutes` (idempotent). */
export function registerClaudeCodeSockets(): void {
  if (registered) return;
  registered = true;
  registerUpgradeHandler({
    name: 'claude-code',
    match: (p) => p === DEVICE_PATH || VIEWER_RE.test(p),
    handle: (req, socket, head) => {
      const p = upgradePathname(req.url);
      if (p === DEVICE_PATH) return handleDevice(req, socket, head);
      const m = VIEWER_RE.exec(p);
      return m ? handleViewer(req, socket, head, m[1]!) : denyUpgrade(socket, 404, 'Not Found');
    },
  });
}
