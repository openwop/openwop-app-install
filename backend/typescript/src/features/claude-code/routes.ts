/**
 * ADR 0785 P1 — Claude Code pairing + paired-device routes, under
 * `/v1/host/openwop-app/claude-code/*` (host extension, non-normative).
 *
 * Two gates, in this order, on EVERY route:
 *   1. the operator gate (`OPENWOP_CLAUDE_CODE_AT_OWN_RISK=true`, ADR 0785 D2
 *      lever 1) — unset ⇒ uniform 404, the surface does not exist;
 *   2. for the signed-in routes, the `claude-code` toggle for the caller
 *      (bucket `user`) — off ⇒ 404.
 *
 * The device start/poll pair is the ONLY public surface (`PUBLIC_PATH_PREFIXES`):
 * it carries no identity by design — the companion has none until it is paired.
 * It holds only a device code, is rate-limited per IP, and expires in ten
 * minutes. Everything else requires a HUMAN session (`auth.kind === 'subject'`):
 * an api-key principal must not be able to pair further devices (a key minting
 * keys is an escalation path) or approve anything.
 */
import type { Request, Response, NextFunction } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { requireFeatureEnabled, tenantOf } from '../featureRoute.js';
import { clientIp } from '../../host/clientIp.js';
import { VENDOR_ROOT } from '../../middleware/protocolVersion.js';
import { personalTenantOf } from '../../host/requestSubject.js';
import { resolveCallerUser } from '../users/usersGuards.js';
import {
  CLAUDE_CODE_BASE,
  CLAUDE_CODE_PUBLIC_PREFIX,
  CLAUDE_CODE_TOGGLE,
  CONSENT_TEXT,
  claudeCodeOperatorEnabled,
  consentHash,
} from './constants.js';
import {
  decidePairing,
  getPendingPairing,
  listDevices,
  ownedDevice,
  pollPairing,
  revokeDevice,
  setWorkflowTasks,
  startPairing,
} from './pairingService.js';
import { createTerminalSession, getTerminalSession, isDeviceOnline, listTerminalSessions } from './terminalStore.js';
import { getRelay, mintViewerTicket } from './terminalSockets.js';

const LABEL = 'Claude Code';

/** Operator gate (ADR 0785 D2 lever 1) — a uniform 404 when unset, public or not. */
function requireOperatorGate(): void {
  if (!claudeCodeOperatorEnabled()) {
    throw new OpenwopError('not_found', `${LABEL} is not available on this host.`, 404, { feature: CLAUDE_CODE_TOGGLE });
  }
}

/** A signed-in HUMAN, with the toggle on. Returns the canonical subject. */
async function requireHuman(req: Request): Promise<string> {
  requireOperatorGate();
  const kind = (req.principal as { auth?: { kind?: string } } | undefined)?.auth?.kind;
  const subject = req.userId ?? req.principal?.principalId;
  if (!subject || kind !== 'subject') {
    throw new OpenwopError('unauthenticated', 'Pairing a Claude Code device requires a signed-in person.', 401, {});
  }
  await requireFeatureEnabled(req, CLAUDE_CODE_TOGGLE, LABEL);
  return subject;
}

// ── Public-route abuse bound ────────────────────────────────────────────────
// The global per-IP write budget (middleware/rateLimit.ts) already applies;
// this is the tighter, route-specific one: pairing starts are cheap to issue
// and each one holds a row for up to a day, so an IP gets a handful per window.
const START_WINDOW_MS = 10 * 60 * 1000;
const STARTS_PER_WINDOW = 10;
const startsByIp = new Map<string, number[]>();

function allowStart(ip: string, now = Date.now()): boolean {
  const recent = (startsByIp.get(ip) ?? []).filter((t) => now - t < START_WINDOW_MS);
  if (recent.length >= STARTS_PER_WINDOW) { startsByIp.set(ip, recent); return false; }
  recent.push(now);
  startsByIp.set(ip, recent);
  if (startsByIp.size > 10_000) startsByIp.clear(); // bounded memory; a reset only loosens briefly
  return true;
}

/** Test-only. */
export function __resetPairingRateLimitForTest(): void { startsByIp.clear(); }

const wrap = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction): void => { fn(req, res).catch(next); };

export function registerClaudeCodeRoutes({ app }: RouteDeps): void {
  // ── Public: the companion starts and polls (RFC 8628 in form) ─────────────
  app.post(`${CLAUDE_CODE_PUBLIC_PREFIX}/start`, wrap(async (req, res) => {
    requireOperatorGate();
    // NOT `req.ip`: the app does not set `trust proxy` (host/requestOrigin.ts), so
    // behind Cloud Run `req.ip` is the front end's address and a per-IP limit
    // would be ONE global limit — ten starts anywhere would lock pairing for
    // everyone (code review #1). `clientIp` is the one forwarded-for reading
    // (host/clientIp.ts, ADR 0851).
    const ip = clientIp(req);
    if (!allowStart(ip)) {
      res.setHeader('Retry-After', String(Math.ceil(START_WINDOW_MS / 1000)));
      throw new OpenwopError('rate_limited', 'Too many pairing attempts from this address. Try again later.', 429, {});
    }
    const b = (req.body ?? {}) as { label?: unknown; platform?: unknown };
    const started = await startPairing({ label: b.label, platform: b.platform, requesterIp: ip });
    res.status(201).json({
      ...started,
      // Relative on purpose: the companion joins it to the origin it was pointed at.
      // Deliberately WITHOUT the code (RFC 8628 §5.4): a link that carries the code
      // is a one-click phishing lure — an attacker starts a pairing and mails the
      // victim the link. The user must TYPE the code their own terminal shows.
      verificationPath: '/claude-code/pair',
    });
  }));

  app.post(`${CLAUDE_CODE_PUBLIC_PREFIX}/poll`, wrap(async (req, res) => {
    requireOperatorGate();
    const result = await pollPairing((req.body as { deviceCode?: unknown } | undefined)?.deviceCode);
    if (!result) throw new OpenwopError('not_found', 'That pairing is unknown, expired, or already completed.', 404, {});
    res.setHeader('Cache-Control', 'no-store'); // the approved response carries a credential, once
    res.json(result);
  }));

  // ── Signed-in: the approval page ──────────────────────────────────────────
  app.get(`${CLAUDE_CODE_BASE}/consent`, wrap(async (req, res) => {
    await requireHuman(req);
    res.json({ consent: CONSENT_TEXT, consentHash: consentHash() });
  }));

  app.get(`${CLAUDE_CODE_BASE}/pair/requests/:userCode`, wrap(async (req, res) => {
    await requireHuman(req);
    const pending = await getPendingPairing(req.params.userCode ?? '');
    if (!pending) throw new OpenwopError('not_found', 'That pairing code is unknown or has expired.', 404, {});
    // `workspaceId`: the approval mints the key in the caller's ACTIVE workspace,
    // so the page names it before anyone clicks.
    res.json({ request: pending, workspaceId: tenantOf(req), consent: CONSENT_TEXT, consentHash: consentHash() });
  }));

  app.post(`${CLAUDE_CODE_BASE}/pair/requests/:userCode/approve`, wrap(async (req, res) => {
    const subject = await requireHuman(req);
    // The personal board's two keys, exactly as `/kanban/boards/personal` derives
    // them (ADR 0003 canonical user; the session's personal tenant) — captured here
    // because the MCP tools that use them run with no request (ADR 0785 P3).
    const personalTenant = personalTenantOf(req);
    const ownerUserId = (await resolveCallerUser(req).catch(() => null))?.userId;
    await decidePairing(req.params.userCode ?? '', {
      approve: true,
      subject,
      tenantId: tenantOf(req),
      consentHash: (req.body as { consentHash?: unknown } | undefined)?.consentHash,
      ...(personalTenant ? { personalTenant } : {}),
      ...(ownerUserId ? { ownerUserId } : {}),
    });
    res.status(204).end();
  }));

  app.post(`${CLAUDE_CODE_BASE}/pair/requests/:userCode/deny`, wrap(async (req, res) => {
    const subject = await requireHuman(req);
    await decidePairing(req.params.userCode ?? '', { approve: false, subject });
    res.status(204).end();
  }));

  // ── Signed-in: paired devices (a view over developer keys) ────────────────
  app.get(`${CLAUDE_CODE_BASE}/devices`, wrap(async (req, res) => {
    const subject = await requireHuman(req);
    const devices = await listDevices(tenantOf(req), subject);
    const withPresence = await Promise.all(devices.map(async (d) => ({ ...d, online: d.status === 'active' && await isDeviceOnline(d.deviceId) })));
    res.json({ devices: withPresence });
  }));

  app.delete(`${CLAUDE_CODE_BASE}/devices/:deviceId`, wrap(async (req, res) => {
    const subject = await requireHuman(req);
    if (!(await revokeDevice(tenantOf(req), req.params.deviceId ?? '', subject))) {
      throw new OpenwopError('not_found', 'Device not found.', 404, {});
    }
    // The key is already dead; also close its live socket now, wherever it is.
    await getRelay().closeDevice(req.params.deviceId ?? '', 'device revoked').catch(() => undefined);
    res.status(204).end();
  }));

  // ADR 0785 D7 — the owner's per-device opt-in to workflow tasks. `requireHuman`
  // refuses key principals, so a device can never grant itself unattended work.
  app.put(`${CLAUDE_CODE_BASE}/devices/:deviceId/workflow-tasks`, wrap(async (req, res) => {
    const subject = await requireHuman(req);
    const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled;
    if (typeof enabled !== 'boolean') throw new OpenwopError('validation_error', '`enabled` must be true or false.', 400, {});
    const rec = await setWorkflowTasks(tenantOf(req), req.params.deviceId ?? '', subject, enabled);
    if (!rec) throw new OpenwopError('not_found', 'Device not found.', 404, {});
    res.json({ deviceId: rec.deviceId, workflowTasks: rec.workflowTasks ?? null });
  }));

  // ── Signed-in: terminals (ADR 0785 P2) ────────────────────────────────────
  app.get(`${CLAUDE_CODE_BASE}/terminals`, wrap(async (req, res) => {
    const subject = await requireHuman(req);
    res.json({ terminals: await listTerminalSessions(tenantOf(req), subject) });
  }));

  app.post(`${CLAUDE_CODE_BASE}/terminals`, wrap(async (req, res) => {
    const subject = await requireHuman(req);
    const b = (req.body ?? {}) as { deviceId?: unknown; cols?: unknown; rows?: unknown; prompt?: unknown; title?: unknown; approveFromAnywhere?: unknown };
    const device = typeof b.deviceId === 'string' ? await ownedDevice(tenantOf(req), b.deviceId, subject) : null;
    if (!device) throw new OpenwopError('not_found', 'Device not found.', 404, {});
    if (!(await isDeviceOnline(device.deviceId))) {
      throw new OpenwopError('conflict', 'That device is offline. Start the companion on it (openwop-agent-host run), then try again.', 409, { reason: 'device_offline' });
    }
    const prompt = typeof b.prompt === 'string' ? b.prompt.slice(0, 4000) : undefined;
    const title = typeof b.title === 'string' && b.title.trim() ? b.title.trim().slice(0, 80) : `Claude Code · ${device.label}`;
    const session = await createTerminalSession({ deviceId: device.deviceId, tenantId: device.tenantId, subject, title });
    await getRelay().sendToDevice(device.deviceId, {
      type: 'open', sessionId: session.sessionId,
      cols: clampDim(b.cols, 120, 20, 400), rows: clampDim(b.rows, 32, 5, 200),
      ...(prompt ? { prompt } : {}),
      // ADR 0785 P4 — opt-in: this session's permission prompts also become
      // approval cards (the TUI prompt returns if nobody answers in time).
      ...(b.approveFromAnywhere === true ? { approveFromAnywhere: true } : {}),
    });
    res.status(201).json({ terminal: session });
  }));

  app.post(`${CLAUDE_CODE_BASE}/terminals/:sessionId/ticket`, wrap(async (req, res) => {
    const subject = await requireHuman(req);
    const s = await getTerminalSession(req.params.sessionId ?? '');
    if (!s || s.tenantId !== tenantOf(req) || s.subject !== subject) throw new OpenwopError('not_found', 'Terminal not found.', 404, {});
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ticket: mintViewerTicket(s.tenantId, s.sessionId, subject), path: `${VENDOR_ROOT}/claude-code/terminal/${s.sessionId}` });
  }));

  app.delete(`${CLAUDE_CODE_BASE}/terminals/:sessionId`, wrap(async (req, res) => {
    const subject = await requireHuman(req);
    const s = await getTerminalSession(req.params.sessionId ?? '');
    if (!s || s.tenantId !== tenantOf(req) || s.subject !== subject) throw new OpenwopError('not_found', 'Terminal not found.', 404, {});
    await getRelay().sendToDevice(s.deviceId, { type: 'stop', sessionId: s.sessionId });
    res.status(204).end();
  }));
}

function clampDim(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
}
