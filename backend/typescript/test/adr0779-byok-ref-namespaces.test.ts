/**
 * ADR 0779 D2 — the owned-namespace list stays complete.
 *
 * A new namespace is born where a new file starts writing secrets, so the
 * ratchet is on the WRITER, not the ref: most `setSecret(` call sites pass a
 * variable, so a grep of the ref argument could never fail. Every non-test file
 * that calls `setSecret(` must be classified below. A new one fails this test
 * until someone decides whether it mints an owned namespace (add it to
 * `byok/refNamespaces.ts` and build its refs from there) or writes on the Keys
 * lane's behalf.
 *
 * The second leg pins that each owner builds its refs FROM the shared prefix,
 * so the list and the refs cannot drift apart.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { OWNED_REF_PREFIXES, systemOwnedRefOwner } from '../src/byok/refNamespaces.js';

const SRC = join(__dirname, '..', 'src');

/** file (relative to src/) → what it writes. */
const WRITERS: Record<string, string> = {
  'byok/secretResolver.ts': 'the resolver itself',
  'byok/subscriptionCredential.ts': 'owned: subscription',
  'features/connections/connectionsService.ts': 'owned: connection',
  'features/connections/inboundWebhooks.ts': 'owned: connectionInbound',
  'features/email/bounceWebhooks.ts': 'owned: emailWebhook',
  'features/priority-matrix/federationService.ts': 'owned: pmPeer',
  'routes/compatEndpoints.ts': 'owned: compatKey',
  'routes/byok.ts': 'the Keys lane',
  'routes/adminVault.ts': 'the superadmin vault',
  'index.ts': 'boot: conformance canary',
  'routes/anonSurfaceSeam.ts': 'test seam: anon canary',
  'routes/chainDeferredExpandSeam.ts': 'test seam',
  // Writers below `setSecret` (the storage primitives and the subscription store).
  'providers/managedProvider.ts': 'owned: managed',
  'byok/copilotOAuth.ts': 'writes through subscriptionCredential.ts (the subscription owner)',
  'storage/postgres/index.ts': 'storage adapter',
  'storage/sqlite/index.ts': 'storage adapter',
  'storage/storage.ts': 'storage interface',
};

/** Every call that can write a secret row: the resolver API and the primitives under it. */
const WRITE_CALL = /\b(?:setSecret|upsertTenantSecret|upsertEncryptedSecret|storeSubscriptionCredential)\s*\(/;

/** Drop comments so a doc comment that MENTIONS a writer is not counted as one. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__') continue;
      walk(p, out);
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      out.push(p);
    }
  }
  return out;
}

describe('ADR 0779 D2 — owned ref namespaces', () => {
  const writers = walk(SRC)
    .filter((f) => WRITE_CALL.test(code(readFileSync(f, 'utf8'))))
    .map((f) => relative(SRC, f).split('\\').join('/'))
    .sort();

  it('every file that writes secrets is classified (a new writer is a decision, not a default)', () => {
    const unclassified = writers.filter((f) => !(f in WRITERS));
    // Shrink-only in the other direction too: a classified file that stopped
    // writing is a stale entry that would let a future writer hide behind it.
    const stale = Object.keys(WRITERS).filter((f) => !writers.includes(f));
    expect(stale, 'remove classified entries that no longer write secrets').toEqual([]);
    expect(unclassified, 'classify each new secret writer in this test and, if it mints a namespace, in byok/refNamespaces.ts').toEqual([]);
    // The anti-vacuity floor: the scan must actually see the known writers.
    expect(writers.length).toBeGreaterThanOrEqual(10);
    expect(writers).toContain('routes/byok.ts');
  });

  it('every owned namespace is built from the shared prefix by its owner', () => {
    for (const [file, what] of Object.entries(WRITERS)) {
      const m = /^owned: (\w+)/.exec(what);
      if (!m) continue;
      const key = m[1] as keyof typeof OWNED_REF_PREFIXES;
      expect(OWNED_REF_PREFIXES[key], `${file} names an unknown namespace ${key}`).toBeTypeOf('string');
      expect(readFileSync(join(SRC, file), 'utf8'), `${file} must build its refs from OWNED_REF_PREFIXES.${key}`).toContain(`OWNED_REF_PREFIXES.${key}`);
    }
  });

  it('systemOwnedRefOwner reads prefixes, not substrings', () => {
    expect(systemOwnedRefOwner('connection:abc')).toBe('connections');
    expect(systemOwnedRefOwner('connection-inbound:abc')).toBe('connections (inbound webhooks)');
    expect(systemOwnedRefOwner('byok:google')).toBeNull();
    expect(systemOwnedRefOwner('my-connection:abc')).toBeNull();
    expect(systemOwnedRefOwner('auth:workload-identity-subject-salt')).toBeNull();
  });
});
