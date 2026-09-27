/**
 * WHD-18 / ADR 0735 — the PURE parts of `scripts/publish-evidence.sh`, in one
 * place a test can reach (`backend/typescript/test/whd18-scripts.test.ts`).
 *
 * The script itself is operator-run against production (Secret Manager, a
 * cloudflared tunnel, a 10-minute suite run, a bucket write) and cannot be run
 * end-to-end from a test. What CAN be pinned is every parse whose silent
 * misreading would produce a wrong cut without failing: the client keys pulled
 * out of the host's key binding, the tunnel URL out of cloudflared's log, the
 * webhook ids out of the list response, and the key-pair consistency check.
 * Each is a place the 2026-09-21 manual cut did by hand.
 *
 *   node scripts/lib/publish-evidence-helpers.mjs client-keys   < binding     # one key per line
 *   node scripts/lib/publish-evidence-helpers.mjs tunnel-url    < tunnel.log  # the https URL
 *   node scripts/lib/publish-evidence-helpers.mjs webhook-ids   < list.json   # one bare id per line
 *   node scripts/lib/publish-evidence-helpers.mjs discovery-field <path> < doc.json
 *   node scripts/lib/publish-evidence-helpers.mjs key-matches <keyId> <private.pem> < discovery.json
 */
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { isEntryModule } from './entry-module.mjs';

/**
 * `openwop-conformance-api-key` holds the HOST's binding, `key:tenant,key:tenant`
 * — what `OPENWOP_API_KEYS` reads — not a client key. The client key is the part
 * before the FIRST `:` of each entry (a tenant id may itself contain `:`; a key
 * does not). Order is kept: first = primary (`OPENWOP_API_KEY`), second =
 * `OPENWOP_TEST_SECONDARY_API_KEY`.
 */
/**
 * The key to hand the suite as `OPENWOP_TEST_TENANT_B_API_KEY`, or null.
 *
 * The suite's cross-tenant legs (RFC 0213 §A cursor-after-authorization, RFC 0200
 * non-disclosure, the webhook/tenant isolation rows — 10 scenario files) read
 * TENANT_B; this script used to export the binding's second key only as
 * `OPENWOP_TEST_SECONDARY_API_KEY`, so every production cut recorded those legs
 * `blocked` although the binding held a second key on a DIFFERENT tenant
 * (MEASURED 2026-09-24: `…:conformance-prod,…:conformance-verify`).
 *
 * Returned ONLY when the first two entries name two DIFFERENT, non-empty tenants:
 * a second key on the SAME tenant is not a tenant-B principal, and handing it over
 * would make an isolation leg pass for the wrong reason (it would be comparing a
 * tenant with itself).
 */
export function tenantBKeyFromBinding(value) {
  const entries = String(value)
    .trim()
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e !== '')
    .map((e) => {
      const i = e.indexOf(':');
      return i < 0 ? { key: e, tenant: '' } : { key: e.slice(0, i).trim(), tenant: e.slice(i + 1).trim() };
    })
    .filter((e) => e.key !== '');
  if (entries.length < 2) return null;
  const [a, b] = entries;
  if (!a.tenant || !b.tenant || a.tenant === b.tenant) return null;
  return b.key;
}

export function clientKeysFromBinding(value) {
  const keys = String(value)
    .trim()
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e !== '')
    .map((e) => {
      const i = e.indexOf(':');
      return (i < 0 ? e : e.slice(0, i)).trim();
    })
    .filter((k) => k !== '');
  if (keys.length === 0) throw new Error('the api-key binding holds no key — refusing to run the suite unauthenticated');
  return keys;
}

/** The quick-tunnel URL cloudflared prints, or null while it has not printed one yet. */
export function tunnelUrlFromLog(text) {
  const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(String(text));
  return m ? m[0] : null;
}

/**
 * Subscription ids from `GET /v1/webhooks`, BARE. The v2 projection spells ids
 * `tenant/uuid`; `DELETE /v1/webhooks/{id}` takes the bare uuid, so a projected
 * id is cut at its last `/` rather than URL-encoded into a path that 404s.
 */
export function webhookIds(listResponse) {
  const doc = typeof listResponse === 'string' ? JSON.parse(listResponse) : listResponse;
  const subs = Array.isArray(doc?.subscriptions) ? doc.subscriptions : null;
  if (subs === null) throw new Error('not a webhook list response (no subscriptions[])');
  return subs
    .map((s) => s?.subscriptionId ?? s?.webhookId)
    .filter((id) => typeof id === 'string' && id !== '')
    .map((id) => id.slice(id.lastIndexOf('/') + 1));
}

/** Read a dotted path out of a JSON document; undefined when absent. */
export function field(doc, path) {
  return path.split('.').reduce((v, k) => (v !== null && typeof v === 'object' ? v[k] : undefined), doc);
}

/**
 * Does the PRIVATE key we are about to sign with correspond to the public key
 * the live host publishes under `keyId`? If not, every bundle cut now would be
 * withheld by the host (signature-invalid) — so refuse BEFORE the ten-minute
 * run, not after it. Returns a reason string on mismatch, or null.
 */
export function keyMismatch(discoveryDoc, keyId, privatePem) {
  const keys = Array.isArray(discoveryDoc?.signingKeys) ? discoveryDoc.signingKeys : [];
  const published = keys.find((k) => k?.keyId === keyId);
  if (!published) return `keyId ${keyId} is not in the live host's signingKeys[] — publish it (OPENWOP_BUNDLE_SIGNING_KEYS) before cutting`;
  if (published.retiredAt !== undefined) return `keyId ${keyId} is RETIRED on the live host (retiredAt ${published.retiredAt}) — a bundle signed now would be withheld`;
  const der = createPublicKey(createPrivateKey(privatePem)).export({ type: 'spki', format: 'der' });
  const raw = der.subarray(der.length - 32).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return raw === published.publicKey ? null : `the signing key's public half does not match the published ${keyId} — wrong secret version?`;
}

if (isEntryModule(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const stdin = () => readFileSync(0, 'utf8');
  try {
    switch (cmd) {
      case 'client-keys': process.stdout.write(`${clientKeysFromBinding(stdin()).join('\n')}\n`); break;
      case 'tenant-b-key': { const k = tenantBKeyFromBinding(stdin()); if (k === null) process.exit(1); process.stdout.write(`${k}\n`); break; }
      case 'tunnel-url': {
        const url = tunnelUrlFromLog(stdin());
        if (url === null) process.exit(1);
        process.stdout.write(`${url}\n`);
        break;
      }
      case 'webhook-ids': { const ids = webhookIds(stdin()); if (ids.length > 0) process.stdout.write(`${ids.join('\n')}\n`); break; }
      case 'discovery-field': {
        const v = field(JSON.parse(stdin()), rest[0] ?? '');
        if (v === undefined) process.exit(1);
        process.stdout.write(`${typeof v === 'string' ? v : JSON.stringify(v)}\n`);
        break;
      }
      case 'key-matches': {
        const why = keyMismatch(JSON.parse(stdin()), rest[0], readFileSync(rest[1], 'utf8'));
        if (why !== null) { process.stderr.write(`${why}\n`); process.exit(1); }
        break;
      }
      default:
        process.stderr.write('usage: publish-evidence-helpers.mjs <client-keys|tenant-b-key|tunnel-url|webhook-ids|discovery-field <path>|key-matches <keyId> <pem>>\n');
        process.exit(2);
    }
  } catch (err) {
    process.stderr.write(`publish-evidence-helpers: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}
