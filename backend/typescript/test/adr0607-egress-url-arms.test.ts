/**
 * ADR 0607 — one ordered egress predicate, and a ratchet so the next call site
 * cannot adopt the address arm without the scheme arm.
 *
 * ADR 0606 fixed webhooks: registration accepted plaintext `http://` and the
 * worker delivered it. While verifying a UNIVERSAL claim that ADR made — "the
 * one egress path with the address arm but not the scheme arm" — two more
 * instances turned up, both structurally identical:
 *
 *   - `a2aTaskStore.assertPushUrlAllowed` — rejects a non-http(s) scheme, checks
 *     the denied ranges, ACCEPTS `http:`. Its own docblock supplies the premise:
 *     "a push URL is the same SSRF surface as a webhook".
 *   - `federationService.validateBaseUrl` — same shape, and the worst of the
 *     three: `rawPeerGet` sends `authorization: Bearer ${token}` to the
 *     tenant-configured host, so plaintext meant a peer credential in the clear.
 *
 * Three hand-rolled near-copies of one predicate is the drift `isDeniedWebhookHost`
 * was extracted to prevent, one arm later.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { assertReachableUrl } from '../src/routes/webhooks.js';
import { assertPushUrlAllowed } from '../src/host/a2aTaskStore.js';
import { validateBaseUrl } from '../src/features/priority-matrix/federationService.js';

/** Reduce any guard to a comparable disposition so every case reads alike. */
/** For OpenwopError-shaped guards whose `code` is the same for every arm,
 *  the message is the only thing that says WHICH arm fired — so assert on it. */
function reason(fn: () => unknown): string {
  try {
    fn();
    return 'ACCEPTED';
  } catch (e) {
    const m = (e as { message?: string }).message ?? '';
    if (m.includes('https:')) return 'insecure_scheme';
    if (m.includes('blocked range')) return 'denied_host';
    if (m.includes('http(s)')) return 'unsupported_protocol';
    return `other:${m}`;
  }
}

function outcome(fn: () => unknown): string {
  try {
    fn();
    return 'ACCEPTED';
  } catch (e) {
    const err = e as { code?: string; message?: string; details?: { reason?: string } };
    return `REJECTED:${err.details?.reason ?? err.code ?? err.message ?? 'error'}`;
  }
}

afterEach(() => {
  delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
});

describe('ADR 0607 — A2A push config refuses plaintext, and stays strict', () => {
  it('refuses a plaintext http:// push url to a PUBLIC host — the case that was accepted', () => {
    expect(outcome(() => assertPushUrlAllowed('http://example.com/push'))).toBe(
      'REJECTED:OPENWOP_A2A_PUSH_EGRESS_DENIED',
    );
  });

  // POSITIVE CONTROL — without it, a guard that refused everything would look
  // identical to one that refuses only plaintext.
  it('positive control — an https push url to a public host is still ACCEPTED', () => {
    expect(outcome(() => assertPushUrlAllowed('https://example.com/push'))).toBe('ACCEPTED');
  });

  it('still refuses a private address — the arm `a2a-push-egress-ssrf` pins', () => {
    expect(outcome(() => assertPushUrlAllowed('https://127.0.0.1/push'))).toBe(
      'REJECTED:OPENWOP_A2A_PUSH_EGRESS_DENIED',
    );
  });

  // The load-bearing asymmetry. A2A push must NOT honour the dev flag: the
  // `a2a-push-egress-ssrf` conformance leg asserts a private push url is refused,
  // and it runs in the same process as `webhook-signed-delivery`, which requires
  // the flag ON. If both surfaces shared a posture the two would be mutually
  // unsatisfiable — so this is a compatibility constraint, not a preference.
  it('the dev flag does NOT reopen A2A push, even though it reopens webhooks', () => {
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    expect(outcome(() => assertPushUrlAllowed('https://127.0.0.1/push'))).toBe(
      'REJECTED:OPENWOP_A2A_PUSH_EGRESS_DENIED',
    );
    // ...and the webhook surface, same flag, same process, DOES reopen.
    expect(outcome(() => assertReachableUrl('http://127.0.0.1:8787/receiver'))).toBe('ACCEPTED');
  });
});

describe('ADR 0607 — priority-matrix federation refuses plaintext peers', () => {
  it('refuses a plaintext http:// peer — the fetch to it carries a bearer token', () => {
    expect(reason(() => validateBaseUrl('http://peer.example.com'))).toBe('insecure_scheme');
  });

  it('positive control — an https peer is still ACCEPTED and normalised to its origin', () => {
    expect(validateBaseUrl('https://peer.example.com/some/path?q=1')).toBe('https://peer.example.com');
  });

  it('still refuses a private peer host', () => {
    expect(reason(() => validateBaseUrl('https://127.0.0.1:9000'))).toBe('denied_host');
  });

  it('the dev flag reopens a loopback peer (local testing), matching the webhook posture', () => {
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    expect(validateBaseUrl('http://127.0.0.1:9000')).toBe('http://127.0.0.1:9000');
  });
});

describe('ADR 0607 — the shared predicate preserves ADR 0606 ordering everywhere', () => {
  it('a non-http(s) scheme is refused ahead of everything, and the dev flag does not reopen it', () => {
    expect(outcome(() => assertReachableUrl('file:///etc/passwd'))).toBe('REJECTED:unsupported_protocol');
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    expect(outcome(() => assertReachableUrl('file:///etc/passwd'))).toBe('REJECTED:unsupported_protocol');
    expect(outcome(() => assertPushUrlAllowed('file:///etc/passwd'))).toBe(
      'REJECTED:OPENWOP_A2A_PUSH_EGRESS_DENIED',
    );
  });

  it('plaintext to a PRIVATE host reports the scheme, not the host — one reason true of every retry', () => {
    expect(outcome(() => assertReachableUrl('http://169.254.169.254/computeMetadata/v1/'))).toBe(
      'REJECTED:insecure_scheme',
    );
  });
});

/**
 * The RATCHET. Not a regex over source — a first pass at classifying these files
 * by grepping for `protocol !== 'https:'` produced two false negatives and a
 * false positive on code the author had just written, so pattern-matching for
 * "does this file have the arm" is not a check, it is a guess.
 *
 * Instead: enumerate every file that dials the guarded dispatcher and require an
 * explicit entry here. A new egress call site turns this red until someone
 * writes down which arm covers it. That is the whole mechanism — it does not try
 * to verify the arm, it forces the question to be answered by a human once.
 */
const DISPATCHER_SITES: Record<string, string> = {
  // Fixed by ADR 0606/0607 — now delegate to the shared ordered predicate.
  'host/webhookDeliveryWorker.ts': 'assertEgressSchemeAllowed at delivery; registration uses assertEgressUrlAllowed',
  'routes/registerAllRoutes.ts': 'A2A push sink — assertEgressSchemeAllowed, honorDevFlag:false',
  'features/priority-matrix/federationService.ts': 'assertEgressUrlAllowed at config time + assertEgressSchemeAllowed on the peer GET',
  // ADR 0747 (RFC 0201 §D) — the endpoint-verification POST. Registration runs
  // assertEgressUrlAllowed (via assertReachableUrl) first; the verifier then
  // re-checks the scheme and dials the same pinned dispatcher as a delivery.
  'host/webhookEndpointVerification.ts': 'assertEgressUrlAllowed at registration + assertEgressSchemeAllowed before the verification dial',

  // Pre-existing hand-rolled copies. Each ALREADY carries BOTH arms (verified by
  // reading, not grepping). Candidates for consolidation onto the shared
  // predicate; not defects, so not churned under this ADR.
  'host/sandboxAdapter.ts': 'own scheme + denied-host arms',
  'host/triggerIngestionService.ts': 'own scheme + denied-host arms',
  'host/webResearchSurface.ts': 'own scheme + denied-host arms',
  'host/mcpClient.ts': 'own scheme + denied-host arms',
  'host/imageProviderAdapter.ts': 'own scheme + denied-host arms',
  'host/sandboxAdapters/e2bAdapter.ts': 'own scheme + denied-host arms',
  'providers/dispatch.ts': 'own scheme + denied-host arms',
  'features/kicktodo-integrations/calendarProviderAdapter.ts': 'own scheme + denied-host arms',
  'host/knowledgeSourceFetch.ts': 'routes through guardedEgressFetch (scheme arm is its step 2)',
  'host/brokeredEgress.ts': 'tenant egress-policy engine (assertEgressAllowed) in front of the dial',

  // No caller-supplied URL reaches a dial in these.
  'host/connectionInjection.ts': 'pack-facing safeFetch — its OWN flag (safeFetchPrivateEgressAllowed), deliberately not the webhook one',
  'host/effectEscapeLedger.ts': 'docblock reference only — no dial in this file',
};

describe('ADR 0607 ratchet — every guarded-dispatcher site is classified', () => {
  const SRC = join(__dirname, '..', 'src');

  function walk(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, acc);
      else if (entry.endsWith('.ts')) acc.push(full);
    }
    return acc;
  }

  const sites = walk(SRC)
    .filter((f) => !f.endsWith('webhookEgressGuard.ts'))
    .filter((f) => readFileSync(f, 'utf8').includes('webhookEgressDispatcher'))
    .map((f) => f.slice(SRC.length + 1).split(/[\\/]/).join('/'))
    .sort();

  it('finds the dispatcher sites at all (non-vacuity floor)', () => {
    // Without this, a broken walk would make every assertion below pass on an
    // empty set — the ratchet would report green having enumerated nothing.
    expect(sites.length).toBeGreaterThanOrEqual(15);
  });

  it('no UNCLASSIFIED egress site — a new one must declare which arm covers it', () => {
    const unclassified = sites.filter((f) => !(f in DISPATCHER_SITES));
    expect(unclassified, `new egress call sites must be added to DISPATCHER_SITES with the arm that covers them: ${unclassified.join(', ')}`).toEqual([]);
  });

  it('no STALE registry entry — a removed site must be removed here too', () => {
    const stale = Object.keys(DISPATCHER_SITES).filter((f) => !sites.includes(f));
    expect(stale, `these no longer dial the dispatcher: ${stale.join(', ')}`).toEqual([]);
  });

  it('the three ADR 0606/0607 sites reference the shared predicate by name', () => {
    for (const f of [
      'host/webhookDeliveryWorker.ts',
      'routes/registerAllRoutes.ts',
      'features/priority-matrix/federationService.ts',
      'host/webhookEndpointVerification.ts',
    ]) {
      const src = readFileSync(join(SRC, f), 'utf8');
      expect(src, `${f} must call the shared scheme arm`).toContain('assertEgressSchemeAllowed(');
    }
  });
});
