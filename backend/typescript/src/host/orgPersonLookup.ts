/**
 * ADR 1123 D2 — a host superadmin's exact-email lookup, carried as a short-lived,
 * single-use token so the client never sends a subject.
 *
 * The token is `v1.<payload>.<sig>`. The payload is base64url JSON
 * `{ u, o, a, exp, j }`, where `u` is the user to add, `o` the target org, `a` a
 * hash of the issuing superadmin's subject, `exp` the expiry (seconds) and `j` a
 * random id. The HMAC uses the session secret (`readSessionSecret`, the SEC-1
 * single source), domain-separated by its own prefix. A token is refused when
 * the signature does not verify, it has expired, it names another org, or
 * another caller presents it. It is burned on bind: `putIfAbsent` on its `j`,
 * kept until it expires. Every refusal reads alike to the caller.
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { readSessionSecret } from '../middleware/cookieSession.js';
import { DurableCollection } from './hostExtPersistence.js';
import { registerKvAgeOut } from './kvAgeOut.js';

/** Long enough to pick roles and press Add; short enough to bound a leaked token. */
export const LOOKUP_TOKEN_TTL_SECONDS = 300;
const PREFIX = 'orgs:person-lookup:v1:';

interface UsedLookup { jti: string; tenantId: string; expiresAt: string }
// Holds no subject (the id and an expiry only), so it is outside subject
// erasure. Aged out once the token it burns could no longer verify anyway.
const used = new DurableCollection<UsedLookup>('orgs:person-lookup-used', (r) => r.jti, undefined, (r) => r.tenantId);
registerKvAgeOut({ id: 'orgs:person-lookup-used', prefix: 'hostext:orgs:person-lookup-used:', ttlDays: 1, timestampField: 'expiresAt' });

const actorHash = (subject: string): string => createHash('sha256').update(subject).digest('base64url').slice(0, 22);
const sign = (payload: string): string => createHmac('sha256', readSessionSecret()).update(`${PREFIX}${payload}`).digest('base64url');

interface Claims { u: string; o: string; a: string; exp: number; j: string }

/** Mint a token that lets `actor` add `userId` to `orgId`, once, for five minutes. */
export function mintLookupToken(args: { userId: string; orgId: string; actor: string }, nowMs: number = Date.now()): string {
  const claims: Claims = { u: args.userId, o: args.orgId, a: actorHash(args.actor), exp: Math.floor(nowMs / 1000) + LOOKUP_TOKEN_TTL_SECONDS, j: randomUUID() };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `v1.${payload}.${sign(payload)}`;
}

/** The token's claims when it verifies for `orgId` and `actor` and has not
 *  expired, else null. Does NOT burn it: see {@link burnLookupToken}. */
export function verifyLookupToken(token: string, args: { orgId: string; actor: string | undefined }, nowMs: number = Date.now()): Claims | null {
  if (!args.actor) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const a = Buffer.from(parts[2]!);
  const b = Buffer.from(sign(parts[1]!));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let c: Partial<Claims>;
  try { c = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Partial<Claims>; } catch { return null; }
  if (typeof c.u !== 'string' || typeof c.o !== 'string' || typeof c.a !== 'string' || typeof c.exp !== 'number' || typeof c.j !== 'string') return null;
  if (c.exp <= Math.floor(nowMs / 1000)) return null;
  if (c.o !== args.orgId || c.a !== actorHash(args.actor)) return null;
  return c as Claims;
}

/** Burn a verified token. False when it was already used. */
export async function burnLookupToken(claims: Claims, tenantId: string): Promise<boolean> {
  return used.putIfAbsent({ jti: claims.j, tenantId, expiresAt: new Date(claims.exp * 1000).toISOString() });
}
