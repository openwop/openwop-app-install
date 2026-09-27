/**
 * Connector-pack certification lint (ADR 0270 / CDP-H) — a read-only pre-publish
 * check a submitter/reviewer runs on a candidate RFC 0095 connection-pack manifest.
 * Pure (no I/O): enforces the trust rules a certified connector must satisfy —
 * https-only endpoints, exactly-one transport, NO embedded credential material, and
 * the required identity fields. Complements the load-time schema validation; this is
 * the human-facing "would this pass certification?" gate for the marketplace flow.
 */

export interface CertResult {
  passed: boolean;
  errors: string[];
  warnings: string[];
}

/** Keys whose non-empty string value means a secret was embedded in the manifest. */
const CREDENTIAL_KEYS = new Set([
  'client_secret', 'clientSecret', 'api_key', 'apiKey', 'apikey', 'token', 'access_token',
  'accessToken', 'refresh_token', 'refreshToken', 'password', 'secret', 'privateKey', 'private_key',
]);

export function certifyConnectionPack(manifest: unknown): CertResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { passed: false, errors: ['manifest must be a JSON object'], warnings };
  }
  const m = manifest as Record<string, unknown>;

  if (m.kind !== 'connection') errors.push("`kind` must be 'connection'");
  if (typeof m.name !== 'string' || !m.name.trim()) errors.push('`name` is required');
  if (typeof m.version !== 'string' || !/^\d+\.\d+\.\d+/.test(String(m.version))) errors.push('`version` must be semver (x.y.z)');
  if (typeof m.description !== 'string' || m.description.trim().length < 12) warnings.push('`description` should explain what the connector does (>= 12 chars)');

  const p = m.provider;
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    errors.push('`provider` object is required');
  } else {
    const prov = p as Record<string, unknown>;
    if (typeof prov.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(prov.id)) errors.push('`provider.id` must be a kebab-case identifier');
    const reach = prov.reach;
    if (!reach || typeof reach !== 'object' || Array.isArray(reach) || Object.keys(reach as object).length !== 1) {
      errors.push('`provider.reach` must declare exactly one transport (RFC 0095 §A)');
    }
  }

  // deep scan: https-only URLs + no embedded credential material
  const seen = new WeakSet<object>();
  const walk = (v: unknown, path: string): void => {
    if (typeof v === 'string') {
      if (/^http:\/\//i.test(v)) errors.push(`non-https URL at ${path}: ${v}`);
    } else if (v && typeof v === 'object') {
      if (seen.has(v)) return;
      seen.add(v);
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (CREDENTIAL_KEYS.has(k) && typeof val === 'string' && val.trim()) {
          errors.push(`embedded credential material is forbidden (${path}.${k}) — credentials are supplied at runtime via BYOK/Connections`);
        }
        walk(val, `${path}.${k}`);
      }
    }
  };
  walk(m, 'manifest');

  return { passed: errors.length === 0, errors, warnings };
}
