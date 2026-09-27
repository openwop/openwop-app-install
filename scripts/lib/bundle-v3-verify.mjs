/**
 * WHD-18 / ADR 0735 — the host-binding verifier for a certification bundle v3,
 * in plain ESM for the deploy-side tools (`check-wire-claims.mjs`, called by
 * `verify-deploy.sh`, and `publish-evidence.sh`).
 *
 * A SECOND copy of `backend/typescript/src/host/certificationEvidence.ts`'s
 * `verifyServedBundle`, and the duplication is deliberate for the reason
 * `check-wire-claims.mjs` gives for its `canonicalJson`: these scripts run
 * against a deployed host from a checkout that may have no compiled backend,
 * and importing TypeScript from here would make the deploy verifier depend on
 * the build. The two copies cannot drift silently:
 * `backend/typescript/test/whd18-scripts.test.ts` runs BOTH over the real signed
 * fixture and a set of tampers and asserts they return the same reason for every
 * case. A copy that disagrees reds there, not in production.
 *
 * It answers the question the HOST asks before serving ("may this host serve
 * this as its own evidence for this commit and major?"), not the suite's
 * question ("which profiles does this certify?"). For the latter, run
 * `openwop-conformance --verify <bundle> --host-key <pem>`.
 */
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';

import { isEntryModule } from './entry-module.mjs';

import { JcsRefusal, canonicalJSON, codeUnitCompare, parseIJson } from './jcs.mjs';

/**
 * RFC 0212: canonical JSON is RFC 8785 JCS over I-JSON (`./jcs.mjs`, a mirror of
 * the suite's `src/lib/jcs.ts`). It REFUSES rather than coerces: a duplicate
 * member name, a lone surrogate, an integer literal beyond ±(2^53 − 1) or a
 * non-finite number fails verification with reason `non-ijson` — the old
 * `Object.keys().sort()` + `JSON.stringify` helper turned NaN into `null` and
 * kept the last duplicate, so two verifiers could read one document differently.
 */
export { canonicalJSON, parseIJson, JcsRefusal };

const RESULTS = ['executed-pass', 'executed-fail', 'skipped', 'inapplicable', 'blocked'];
const TOTAL_KEY = { 'executed-pass': 'executedPass', 'executed-fail': 'executedFail', skipped: 'skipped', inapplicable: 'inapplicable', blocked: 'blocked' };
export const SIGNATURE_OVER = ['witnessSha256', 'host.build', 'suite.version', 'discovery.sha256'];

/**
 * RFC 0148 §C witness digest. Rows by UTF-16 code unit, never a collation, and
 * `host.relaxations[]` in the preimage only when non-empty — see the TS twin
 * (ADR 0744) for why.
 */
export function witnessDigest(rows, relaxations) {
  const canonicalRows = [...rows]
    .sort((a, b) => codeUnitCompare(a.id, b.id))
    .map((r) => ({
      id: r.id, scenario: r.scenario, result: r.result,
      ...(r.assertions === undefined ? {} : { assertions: r.assertions }),
      ...(r.detail === undefined ? {} : { detail: r.detail }),
      ...(r.evidence === undefined ? {} : { evidence: r.evidence }),
    }));
  const preimage = Array.isArray(relaxations) && relaxations.length > 0 ? { rows: canonicalRows, relaxations } : canonicalRows;
  return createHash('sha256').update(canonicalJSON(preimage), 'utf8').digest('hex');
}

const rec = (v) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v : undefined);
const fromBase64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const reject = (reason, detail) => ({ ok: false, reason, detail });

/**
 * @param {unknown} doc
 * @param {{ commit: string, major: 1|2, signingKeys: Array<Record<string, unknown>> }} expect
 * @returns {{ ok: true, keyId: string } | { ok: false, reason: string, detail: string }}
 */
export function verifyServedBundle(doc, expect) {
  const b = rec(doc);
  if (b === undefined) return reject('not-an-object', 'the object is not a JSON object');
  if (b.bundleVersion !== '3') return reject('not-v3', `bundleVersion is ${JSON.stringify(b.bundleVersion)}, expected "3"`);
  const build = rec(rec(b.host)?.build);
  if (build === undefined || build.kind !== 'commit') return reject('build-kind', `host.build.kind is ${JSON.stringify(build?.kind)}, expected "commit"`);
  if (build.id !== expect.commit) return reject('build-mismatch', `host.build.id ${String(build.id).slice(0, 12)} is not the expected commit ${expect.commit.slice(0, 12)}`);
  const suite = rec(b.suite);
  if (suite?.targetMajor !== expect.major) return reject('target-major', `suite.targetMajor is ${JSON.stringify(suite?.targetMajor)}, expected ${expect.major}`);

  const results = rec(b.results);
  if (!Array.isArray(results?.requirements)) return reject('rows-malformed', 'results.requirements is not an array');
  const rows = [];
  const seen = new Set();
  for (const r of results.requirements) {
    const row = rec(r);
    if (row === undefined || typeof row.id !== 'string' || typeof row.scenario !== 'string' || !RESULTS.includes(row.result)) {
      return reject('rows-malformed', 'a requirement row is missing id/scenario or carries an unknown result');
    }
    if (seen.has(row.id)) return reject('rows-malformed', `requirement ${row.id} has more than one row (RFC 0148 §A)`);
    seen.add(row.id);
    rows.push(row);
  }
  const totals = rec(results.totals);
  for (const k of RESULTS) {
    const counted = rows.filter((r) => r.result === k).length;
    if (totals?.[TOTAL_KEY[k]] !== counted) return reject('totals-mismatch', `totals.${TOTAL_KEY[k]} is ${String(totals?.[TOTAL_KEY[k]])} but the rows count ${counted}`);
  }
  const assertionSum = rows.reduce((n, r) => n + (typeof r.assertions === 'number' ? r.assertions : 0), 0);
  if (b.assertionCount !== assertionSum) return reject('assertion-count', `assertionCount is ${String(b.assertionCount)} but the rows sum to ${assertionSum}`);
  let digest;
  try {
    digest = witnessDigest(rows, rec(b.host)?.relaxations);
  } catch (err) {
    if (err instanceof JcsRefusal) return reject('non-ijson', err.message);
    throw err;
  }
  if (b.witnessSha256 !== digest) return reject('witness-digest', `witnessSha256 ${String(b.witnessSha256).slice(0, 12)} is not the digest of the rows (${digest.slice(0, 12)})`);

  const sig = rec(b.signature);
  if (sig === undefined || sig.alg !== 'ed25519' || typeof sig.keyId !== 'string' || typeof sig.sig !== 'string' || sig.sig === '') {
    return reject('signature-missing', 'signature.{alg: ed25519, keyId, sig} is required');
  }
  if (JSON.stringify(sig.over) !== JSON.stringify(SIGNATURE_OVER)) return reject('signature-over', `signature.over must be ${JSON.stringify(SIGNATURE_OVER)}`);
  const key = expect.signingKeys.find((k) => k.keyId === sig.keyId);
  if (key === undefined || typeof key.publicKey !== 'string') return reject('signature-key-unknown', `signature.keyId ${JSON.stringify(sig.keyId)} is not among the host's published signingKeys`);
  const generatedAt = typeof b.generatedAt === 'string' ? Date.parse(b.generatedAt) : Number.NaN;
  if (Number.isNaN(generatedAt)) return reject('generated-at-invalid', 'generatedAt is missing or not a timestamp');
  if (key.retiredAt !== undefined) {
    const retiredAt = typeof key.retiredAt === 'string' ? Date.parse(key.retiredAt) : Number.NaN;
    if (Number.isNaN(retiredAt) || retiredAt < generatedAt) return reject('signature-key-retired', `key ${sig.keyId} was retired at ${String(key.retiredAt)}, before generatedAt ${String(b.generatedAt)}`);
  }
  const discoverySha = rec(b.discovery)?.sha256;
  if (typeof suite.version !== 'string' || typeof discoverySha !== 'string') {
    return reject('signature-invalid', 'suite.version or discovery.sha256 is missing, so the signed bytes cannot be reconstructed');
  }
  let payload;
  try {
    payload = Buffer.from(canonicalJSON({ witnessSha256: digest, 'host.build': build, 'suite.version': suite.version, 'discovery.sha256': discoverySha }), 'utf8');
  } catch (err) {
    if (err instanceof JcsRefusal) return reject('non-ijson', err.message);
    throw err;
  }
  let ok = false;
  try {
    ok = edVerify(null, payload, createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.publicKey }, format: 'jwk' }), fromBase64url(sig.sig));
  } catch (err) {
    return reject('signature-invalid', `the signature could not be checked: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!ok) return reject('signature-invalid', `the attestation does not verify under ${sig.keyId}`);
  return { ok: true, keyId: sig.keyId };
}

/**
 * Verify bundle TEXT: parse it through the RFC 0212 I-JSON boundary first, so a
 * duplicate member name or an out-of-range integer literal — both invisible
 * after `JSON.parse` — is refused as `non-ijson` (or `not-json` for text that
 * is not JSON at all) instead of being silently rewritten and then verified.
 */
export function verifyServedBundleText(text, expect) {
  let doc;
  try {
    doc = parseIJson(text);
  } catch (err) {
    if (err instanceof JcsRefusal) return reject(err.kind === 'not-json' ? 'not-json' : 'non-ijson', err.message);
    throw err;
  }
  return verifyServedBundle(doc, expect);
}

/** A published 32-byte base64url Ed25519 key as SPKI PEM — the form `openwop-conformance --host-key` reads. */
export function rawKeyToPem(publicKey) {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' }).export({ type: 'spki', format: 'pem' });
}

// CLI: node bundle-v3-verify.mjs <bundle.json> --commit <sha> --major <1|2> --keys-json <file|->
//      node bundle-v3-verify.mjs --pem <base64url-key>
// Exit 0 = verified, 1 = refused (reason printed), 2 = usage.
if (isEntryModule(import.meta.url)) {
  const { readFileSync } = await import('node:fs');
  const args = process.argv.slice(2);
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  if (flag('--pem') !== undefined) { process.stdout.write(rawKeyToPem(flag('--pem'))); process.exit(0); }
  const file = args[0];
  const commit = flag('--commit');
  const major = Number(flag('--major'));
  const keysFile = flag('--keys-json');
  if (!file || !commit || (major !== 1 && major !== 2) || !keysFile) {
    process.stderr.write('usage: bundle-v3-verify.mjs <bundle.json> --commit <sha> --major <1|2> --keys-json <file|->\n');
    process.exit(2);
  }
  const keys = JSON.parse(readFileSync(keysFile === '-' ? 0 : keysFile, 'utf8'));
  const verdict = verifyServedBundleText(readFileSync(file, 'utf8'), { commit, major, signingKeys: Array.isArray(keys) ? keys : (keys.signingKeys ?? []) });
  if (verdict.ok) { process.stdout.write(`verified: signed by ${verdict.keyId}, build ${commit.slice(0, 12)}, major ${major}\n`); process.exit(0); }
  process.stdout.write(`REFUSED [${verdict.reason}] ${verdict.detail}\n`);
  process.exit(1);
}
