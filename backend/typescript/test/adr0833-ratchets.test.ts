/**
 * ADR 0833 — the structural ratchets. Each one pins the EXIT SET of a decision
 * that used to be re-derived (or skipped) at a second site:
 *
 *  D1 — the session cookie is read and verified only in `middleware/` or by a
 *       lane that routes through `resolveLiveCookieSession` (the collab socket
 *       used bare `verifySession`, S1; `routes/migrate.ts` hand-rolled a second
 *       HMAC verifier).
 *  D2 — a session payload's lifetime fields (`exp`, `iat`) are set only by the
 *       builder in `cookieSession.ts`; `signSession` is called only by the
 *       files that mint through it (the switch re-mint set `exp = now + 24h`
 *       and dropped `noRefresh`, S2).
 *  D3 — the user row is written only through the CAS loop; one blind `put`
 *       remains, in `createUser` (review B3: a login's blind put could write
 *       back the pre-disable row, and would drop a logout's revocation).
 *  D6 — every users route that disables, deletes or signs out a TARGET row
 *       asks the owner-rank predicate (S7); so does the workflow surface.
 *
 * Each list is a reviewed allowlist with its reason: growing it is a decision,
 * not a drive-by.
 *
 * Sabotage that turns it red (one per decision): a `verifySession(` call added
 * to a non-allowlisted file such as `routes/account.ts` (D1); a `signSession(`
 * call from a new file (D2); `usersService.ts` swap loop writing
 * `await store.put(next)` instead of `compareAndSwap` (D3 — two puts); the
 * DELETE handler's `assertMayActOnUser(` call removed in
 * `features/users/routes.ts`, or the one in `surface.ts` (D6).
 *
 * Known limits (recorded, NOT to be "fixed" by changing a pattern — the counted
 * spellings are the baseline): D1's HMAC check matches the `.update(payloadB64`
 * spelling only, and the comment stripper removes whole-line `//` comments only
 * (a trailing comment can false-RED, never false-green).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts') && !p.includes('__tests__')) out.push(p);
  }
  return out;
}
const FILES = walk(SRC).map((p) => ({ rel: relative(SRC, p).split('\\').join('/'), text: readFileSync(p, 'utf8') }));
/** Source with line comments and block comments removed (a mention is not a call). */
const code = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('D1 — the session cookie is read only where its liveness is decided', () => {
  const ALLOWED: Record<string, string> = {
    'host/collab/collabServer.ts': 'routes the cookie through resolveLiveCookieSession (asserted below)',
    'routes/credentialLaneSeams.ts': 'the env-gated RFC 0170 test seam that MINTS the credential it echoes',
    'routes/migrate.ts': 'reads the ANON sandbox cookie only, through the shared verifier, into an already-authenticated personal tenant',
  };
  it('outside middleware/, only the reviewed files touch COOKIE_NAME / readCookie / verifySession', () => {
    const offenders = FILES
      .filter((f) => !f.rel.startsWith('middleware/'))
      .filter((f) => /\b(COOKIE_NAME|readCookie\(|verifySession\()/.test(code(f.text)))
      .map((f) => f.rel)
      .filter((rel) => !(rel in ALLOWED));
    expect(offenders).toEqual([]);
  });
  it('the collab lane asks the live-session resolver and never bare verifySession', () => {
    const collab = code(FILES.find((f) => f.rel === 'host/collab/collabServer.ts')!.text);
    expect(collab).toMatch(/resolveLiveCookieSession\(/);
    expect(collab).not.toMatch(/verifySession\(/);
  });
  it('no file hand-rolls the cookie HMAC (a second verifier the first’s hardening cannot reach)', () => {
    const rolled = FILES
      .filter((f) => f.rel !== 'middleware/cookieSession.ts')
      .filter((f) => /createHmac\(\s*['"]sha256['"]\s*,\s*(readSessionSecret\(\)|sessionSecret\(\)|secret)\)\s*\.update\(\s*payloadB64/.test(code(f.text)))
      .map((f) => f.rel);
    expect(rolled).toEqual([]);
  });
});

describe('D2 — one session-payload builder', () => {
  const SIGNERS = ['middleware/cookieSession.ts', 'middleware/auth.ts', 'routes/authBreakGlass.ts'];
  it('signSession is called only by the files that mint through buildSessionPayload', () => {
    const callers = FILES.filter((f) => /\bsignSession\(/.test(code(f.text))).map((f) => f.rel).sort();
    expect(callers).toEqual([...SIGNERS].sort());
  });
  it('outside the builder, no signer sets a lifetime field by hand', () => {
    for (const rel of SIGNERS.filter((r) => r !== 'middleware/cookieSession.ts')) {
      const text = code(FILES.find((f) => f.rel === rel)!.text);
      expect(text, `${rel} sets exp/iat by hand`).not.toMatch(/\bexp:\s|\.exp\s*=[^=]|\biat:\s|\.iat\s*=[^=]/);
    }
  });
});

describe('D3 — the user row is CAS-written', () => {
  it('usersService.ts has exactly one blind store.put — the create', () => {
    const text = code(FILES.find((f) => f.rel === 'features/users/usersService.ts')!.text);
    const puts = text.match(/\bstore\.put\(/g) ?? [];
    expect(puts.length).toBe(1);
    const createUser = text.slice(text.indexOf('export async function createUser('));
    expect(createUser.slice(0, createUser.indexOf('\n}\n'))).toMatch(/\bstore\.put\(/);
  });
});

describe('D6 — the owner-rank predicate guards every lockout of a target row', () => {
  it('each /users/users/:id handler that disables, deletes or signs out its target asks assertMayActOnUser', () => {
    const text = code(FILES.find((f) => f.rel === 'features/users/routes.ts')!.text);
    const blocks = text.split(/\n\s*app\.(?:get|post|patch|delete)\(/).slice(1);
    const lockouts = blocks.filter((b) => /^['`](?:\/v\d+)?\/host\/openwop-app\/users\/users\/:id/.test(b))
      .filter((b) => /\b(setUserStatus|deleteUser|bumpSessionEpoch)\(/.test(b));
    expect(lockouts.length, 'the route split found the lifecycle handlers').toBeGreaterThanOrEqual(3);
    for (const b of lockouts) expect(/assertMayActOnUser\(/.test(b), b.slice(0, 80)).toBe(true);
  });
  it('the workflow surface asks it too (UAUWF-8)', () => {
    expect(code(FILES.find((f) => f.rel === 'features/users/surface.ts')!.text)).toMatch(/assertMayActOnUser\(/);
  });
});
