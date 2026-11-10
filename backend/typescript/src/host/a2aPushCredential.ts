/**
 * ADR 1045 push follow-up / RFC 0214 §A, §C — the A2A push DESTINATION
 * credential: read it from a push-config registration, hold it sealed, open it
 * only for a delivery to the registered URL.
 *
 * What the client registers (both protocol versions this host serves):
 *   - A2A 1.0 `PushNotificationConfig.authentication` = `{ scheme, credentials }`
 *   - A2A 0.3 `PushNotificationConfig.authentication` = `{ schemes[], credentials? }`
 *   - both: `token`
 *
 * What the host sends (`spec/v2/core/interop.md` §"A2A push delivery"):
 *   - `Authorization: {scheme} {credentials}` from `authentication`;
 *   - when `authentication` is absent and `token` is set, `Authorization: Bearer
 *     <token>` (RFC 0214 §C, a SHOULD; otherwise `token` is not sent).
 *   0.3 lists several `schemes`; the first one is the scheme the credentials are
 *   sent under. `authentication` with no `credentials` sends nothing.
 *
 * What the host keeps: the computed header value, SEALED, on the task record
 * (`A2aPushConfig.sealedAuthorization`). With KMS configured (mandatory in the
 * `auth` posture, set in production) it is the BYOK KMS envelope with the AAD
 * bound to the record's (tenant, task), so a sealed value copied onto another
 * task does not open. Without KMS (local dev / anonymous demo) it is stored with
 * a plaintext marker, the same posture as `webhookSecretCodec.ts`. The value is
 * never returned to a caller (`publicPushConfig`), never logged, and discarded
 * when the task reaches a terminal state (`a2aTaskStore.upsertA2aTask`).
 */

import { isKmsConfigured, kmsDecrypt, kmsEncrypt, type KmsAadContext, type KmsEncryptedRecord } from '../byok/kmsEncryption.js';

const KMS_PREFIX = 'a2apush:kms:v1:';
const PLAIN_PREFIX = 'a2apush:plain:v1:';

/** RFC 9110 §5.6.2 `token` — what an auth-scheme name may contain. */
const SCHEME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Credentials go on one header line: printable ASCII plus space, nothing else. */
const CREDENTIALS_RE = /^[\x20-\x7e]+$/;

export class A2aPushCredentialInvalidError extends Error {
  readonly code = 'OPENWOP_A2A_PUSH_CREDENTIAL_INVALID';
  constructor(what: string) {
    // Names the FIELD, never the value: the value is the client's secret.
    super(`a2a push config ${what} is not a valid HTTP Authorization value`);
    this.name = 'A2aPushCredentialInvalidError';
  }
}

/**
 * The `Authorization` header value a delivery carries for this registration, or
 * undefined when it carries none. Throws `A2aPushCredentialInvalidError` for a
 * scheme or credential that cannot be one header value (CR/LF, control bytes).
 */
export function pushAuthorizationFrom(cfg: { authentication?: unknown; token?: unknown } | undefined): string | undefined {
  const auth = cfg?.authentication;
  if (auth !== undefined && auth !== null) {
    if (typeof auth !== 'object') throw new A2aPushCredentialInvalidError('authentication');
    const a = auth as { scheme?: unknown; schemes?: unknown; credentials?: unknown };
    const scheme =
      typeof a.scheme === 'string'
        ? a.scheme
        : Array.isArray(a.schemes) && typeof a.schemes[0] === 'string'
          ? a.schemes[0]
          : undefined;
    if (a.credentials === undefined || a.credentials === null || a.credentials === '') return undefined;
    if (typeof a.credentials !== 'string' || !CREDENTIALS_RE.test(a.credentials)) {
      throw new A2aPushCredentialInvalidError('authentication.credentials');
    }
    if (scheme === undefined || !SCHEME_RE.test(scheme)) throw new A2aPushCredentialInvalidError('authentication.scheme');
    return `${scheme} ${a.credentials}`;
  }
  const token = cfg?.token;
  if (token === undefined || token === null || token === '') return undefined;
  if (typeof token !== 'string' || !CREDENTIALS_RE.test(token)) throw new A2aPushCredentialInvalidError('token');
  return `Bearer ${token}`;
}

/** The AAD a push credential is sealed under: the record's own tenant and task. */
export function pushCredentialAad(tenantId: string | undefined, taskId: string): KmsAadContext {
  return { tenantId: tenantId ?? '~a2a-unbound', credentialRef: `a2a-push:${taskId}` };
}

/** Seal a push `Authorization` value for storage on the task record. */
export async function sealPushAuthorization(authorization: string, aad: KmsAadContext): Promise<string> {
  if (!isKmsConfigured()) return `${PLAIN_PREFIX}${authorization}`;
  return `${KMS_PREFIX}${JSON.stringify(await kmsEncrypt(authorization, aad))}`;
}

/** Open a stored push credential. Throws on tamper, wrong AAD or an unknown form. */
export async function openPushAuthorization(sealed: string, aad: KmsAadContext): Promise<string> {
  if (sealed.startsWith(KMS_PREFIX)) {
    return kmsDecrypt(JSON.parse(sealed.slice(KMS_PREFIX.length)) as KmsEncryptedRecord, aad);
  }
  if (sealed.startsWith(PLAIN_PREFIX)) return sealed.slice(PLAIN_PREFIX.length);
  throw new Error('a2a push credential: unrecognised storage form');
}
