/**
 * ADR 1158 — carry the ACTIVE workspace to a request that leaves the API's origin.
 *
 * Same-origin `/api` requests carry the active workspace on the `openwop.session`
 * cookie: the bearer lane reads `cookieSession.tenantId` and, for a shared workspace,
 * re-checks membership on every request (`middleware/auth.ts`). A request sent
 * straight to the backend host (the streamed example-data writes, which must dodge
 * the CDN's 60 s cap) carries that host's OWN cookie, which the switch never updated
 * (or none, when third-party cookies are blocked). So the bearer lane resolves the
 * caller's personal workspace, and a guard that compares the two refuses every write.
 *
 * This token is the cookie's selection, made portable: minted on the same-origin
 * workspace list (where the cookie IS sent, so it names the workspace the auth
 * middleware already resolved) and presented in a header on the direct request. It
 * grants nothing: the bearer lane takes it in place of the cookie's `tenantId` and
 * then runs the SAME membership check, so a removed member falls back to their
 * personal workspace exactly as with a stale cookie. It is bound to the caller's
 * personal tenant (one identity), so another person's bearer cannot use it, and it
 * expires quickly. Stateless: an HMAC over the fields with the session secret.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readSessionSecret } from '../middleware/cookieSession.js';

/** The request header the token rides on. */
export const WORKSPACE_SELECTION_HEADER = 'x-openwop-workspace-selection';
/** Long enough for a page to start a write after reading its workspace list. */
const TTL_SECONDS = 10 * 60;
const PREFIX = 'workspace-select:v1:';

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
const unb64 = (s: string): string | undefined => {
  try { return Buffer.from(s, 'base64url').toString('utf8'); } catch { return undefined; }
};

function sign(personalTenant: string, workspace: string, exp: number): string {
  return createHmac('sha256', readSessionSecret()).update(`${PREFIX}${personalTenant}\u0000${workspace}\u0000${exp}`).digest('base64url');
}

/** Mint a selection of `workspace` for the identity whose personal tenant is `personalTenant`. */
export function mintWorkspaceSelection(personalTenant: string, workspace: string, nowMs: number = Date.now()): string {
  const exp = Math.floor(nowMs / 1000) + TTL_SECONDS;
  return `ws1.${b64(workspace)}.${exp}.${sign(personalTenant, workspace, exp)}`;
}

/** The workspace `token` selects for this identity, or undefined when it is malformed,
 *  expired, or minted for someone else. Membership is NOT decided here: the caller runs
 *  the same check the cookie's selection gets. */
export function readWorkspaceSelection(token: unknown, personalTenant: string, nowMs: number = Date.now()): string | undefined {
  if (typeof token !== 'string' || token.length > 1024) return undefined;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'ws1') return undefined;
  const workspace = unb64(parts[1]!);
  const exp = Number(parts[2]);
  if (!workspace || !Number.isInteger(exp) || exp <= Math.floor(nowMs / 1000)) return undefined;
  const a = Buffer.from(parts[3]!);
  let expected: string;
  // An unreadable secret means no selection, never a failed sign-in: the header is
  // optional, and the request then resolves exactly as it would without it.
  try { expected = sign(personalTenant, workspace, exp); } catch { return undefined; }
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  return workspace;
}
