/**
 * ADR 0799 — the CLI sign-in routes. `start` and `poll` are the CLI's and need
 * no credential (the device code is one); the rest are a signed-in person's.
 * `logout` is the one thing a key may do to a key: revoke ITSELF.
 */
import type { NextFunction, Request, Response } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { OpenwopError } from '../../types.js';
import { tenantOf } from '../featureRoute.js';
import { clientIp } from '../../host/clientIp.js';
import { appendAudit } from '../../host/auditChainService.js';
import { createLogger } from '../../observability/logger.js';
import { assertMayIssueDurableKey, getTenantKeyPolicy, revokeApiKey } from './apiKeyService.js';
import { CLI_LOGIN_PATHS } from './paths.js';
import { decideCliLogin, getPendingCliLogin, pollCliLogin, startCliLogin } from './cliLogin.js';

const log = createLogger('features.developer-keys.cli-login');

// Starts are cheap to issue and each holds a row for a day, so an address gets a
// handful per window on top of the global per-IP budget (the pairing route's rule).
const START_WINDOW_MS = 10 * 60 * 1000;
const STARTS_PER_WINDOW = 10;
const startsByIp = new Map<string, number[]>();
function allowStart(ip: string, now = Date.now()): boolean {
  const recent = (startsByIp.get(ip) ?? []).filter((t) => now - t < START_WINDOW_MS);
  if (recent.length >= STARTS_PER_WINDOW) { startsByIp.set(ip, recent); return false; }
  recent.push(now);
  startsByIp.set(ip, recent);
  if (startsByIp.size > 10_000) startsByIp.clear();
  return true;
}
/** Test-only. */
export function __resetCliLoginRateLimitForTest(): void { startsByIp.clear(); }

/** A signed-in PERSON: not an anonymous session, not a key. Returns the canonical subject. */
function requirePerson(req: Request): string {
  const kind = (req.principal as { auth?: { kind?: string } } | undefined)?.auth?.kind;
  const subject = req.userId ?? req.principal?.principalId;
  if (!subject || kind !== 'subject') {
    throw new OpenwopError('unauthenticated', 'Approving a CLI sign-in requires a signed-in person.', 401, {});
  }
  return subject;
}

const VERIFICATION_PATH = '/access?tab=api-keys';

/** `OPENWOP_PUBLIC_BASE_URL`'s origin + `path`, or `undefined` when it is unset or not http(s). */
function webOriginUrl(path: string): string | undefined {
  const raw = process.env.OPENWOP_PUBLIC_BASE_URL?.trim();
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? `${u.origin}${path}` : undefined;
  } catch { return undefined; }
}

const wrap = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction): void => { fn(req, res).catch(next); };

export function registerCliLoginRoutes({ app }: RouteDeps): void {
  app.post(CLI_LOGIN_PATHS.start, wrap(async (req, res) => {
    const ip = clientIp(req);
    if (!allowStart(ip)) {
      res.setHeader('Retry-After', String(Math.ceil(START_WINDOW_MS / 1000)));
      throw new OpenwopError('rate_limited', 'Too many sign-in attempts from this address. Try again later.', 429, {});
    }
    const started = await startCliLogin({ label: (req.body as { label?: unknown } | undefined)?.label, requesterIp: ip });
    const verificationUri = webOriginUrl(VERIFICATION_PATH);
    res.status(201).json({
      ...started,
      // WITHOUT the code (RFC 8628 §5.4): a link that carried it would be a
      // one-click lure. The person types the code their own terminal shows.
      verificationPath: VERIFICATION_PATH,
      // ADR 0827 — absolute, on the WEB origin. A CLI whose base is the protocol
      // origin (api.openwop.dev, no SPA and no session cookie) cannot build the
      // approval page from its own base. Omitted when no web origin is
      // configured; the CLI then falls back to base origin + verificationPath.
      ...(verificationUri ? { verificationUri } : {}),
    });
  }));

  app.post(CLI_LOGIN_PATHS.poll, wrap(async (req, res) => {
    const result = await pollCliLogin((req.body as { deviceCode?: unknown } | undefined)?.deviceCode);
    if (!result) throw new OpenwopError('not_found', 'That sign-in is unknown, expired, or already completed.', 404, {});
    res.setHeader('Cache-Control', 'no-store'); // the approved answer carries a credential, once
    if (result.status === 'approved') {
      await appendAudit(result.key.tenantId, 'apikey.created', {
        keyId: result.key.keyId, actor: result.key.createdBy, scopes: result.key.scopes, expiresAt: result.key.expiresAt, via: 'cli-login',
      }).catch((err: unknown) => log.error('cli-login audit append failed', { error: err instanceof Error ? err.message : String(err) }));
    }
    res.json(result);
  }));

  app.get(`${CLI_LOGIN_PATHS.requests}/:userCode`, wrap(async (req, res) => {
    requirePerson(req);
    const pending = await getPendingCliLogin(req.params.userCode ?? '');
    if (!pending) throw new OpenwopError('not_found', 'That sign-in code is unknown or has expired.', 404, {});
    // The key is minted in the caller's ACTIVE workspace: say which, before anyone clicks.
    res.json({ request: pending, workspaceId: tenantOf(req) });
  }));

  app.post(`${CLI_LOGIN_PATHS.requests}/:userCode/approve`, wrap(async (req, res) => {
    const subject = requirePerson(req);
    // ADR 0833 D2 — early and readable; `issueApiKey` refuses again at poll time.
    assertMayIssueDurableKey(subject);
    const tenantId = tenantOf(req);
    if ((await getTenantKeyPolicy(tenantId)).disabled) {
      throw new OpenwopError('forbidden', 'API keys are turned off for this workspace. A workspace admin can turn them back on.', 403, { code: 'keys_disabled' });
    }
    await decideCliLogin(req.params.userCode ?? '', { approve: true, subject, tenantId });
    res.status(204).end();
  }));

  app.post(`${CLI_LOGIN_PATHS.requests}/:userCode/deny`, wrap(async (req, res) => {
    requirePerson(req);
    await decideCliLogin(req.params.userCode ?? '', { approve: false });
    res.status(204).end();
  }));

  // `openwop logout` — the presented key revokes ITSELF. The one key-management
  // act a key is allowed (ADR 0800 D1 refuses the rest): it can only remove
  // authority, and only its own.
  app.post(CLI_LOGIN_PATHS.logout, wrap(async (req, res) => {
    const principal = req.principal as { principalId?: string; auth?: { kind?: string; issuer?: string } } | undefined;
    if (principal?.auth?.kind !== 'api-key' || !principal.principalId?.startsWith('apikey:') || !principal.auth.issuer) {
      throw new OpenwopError('validation_error', 'Sign-out revokes the API key it is called with; call it with one.', 400, {});
    }
    const keyId = principal.principalId.slice('apikey:'.length);
    const tenantId = tenantOf(req);
    await revokeApiKey(tenantId, keyId, { callerSubject: principal.auth.issuer, isAdmin: false });
    await appendAudit(tenantId, 'apikey.revoked', { keyId, actor: principal.auth.issuer, reason: 'cli-logout' }).catch(() => undefined);
    res.status(204).end();
  }));
}
