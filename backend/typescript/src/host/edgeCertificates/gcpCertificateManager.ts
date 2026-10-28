/**
 * ADR 0906 D1/D2/D4 — the `gcp-certificate-manager` provider, over the
 * Certificate Manager v1 REST API. REST, not the gRPC SDK: about nine calls,
 * the house metadata-token pattern, and egress stays behind the guard.
 *
 * Idempotent by construction (D4):
 *   - resource ids are deterministic per hostname (`owp-cd-<sha256[0:20]>` +
 *     `-auth` / `-cert` / `-entry`), so a crash at any point resumes onto the
 *     same resources;
 *   - every create is GET-then-POST, and a 409 ALREADY_EXISTS is success;
 *   - a create's long-running operation is waited on for at most a few
 *     seconds. If it has not finished, the step reports pending and the next
 *     advance re-GETs; nothing blocks a request on certificate issuance.
 *
 * DNS authorization is `PER_PROJECT_RECORD` (D2, architect C3): its CNAME is
 * `_acme-challenge_<id>.<host>`, so it never collides with an existing
 * `_acme-challenge.<host>` record (for example one a customer CDN already owns).
 */
import { createHash } from 'node:crypto';
import { guardedEgressFetch } from '../webhookEgressGuard.js';
import { GcpMetadataError, gcpMetadata } from '../gcpAdc.js';
import type { DnsRecord, EdgeCertificateProvider, EdgeHandle, EdgeIssue, EdgeStatus, StepResult } from './port.js';

const API = 'https://certificatemanager.googleapis.com/v1';

/**
 * The metadata-server reads this adapter needs: an access token for the
 * runtime service account and the project id. Production reads both through
 * the ONE shared metadata client, `host/gcpAdc.ts` (ADR 0904 D12). Tests pass a
 * fake.
 */
export interface EdgeMetadata {
  accessToken(): Promise<string>;
  projectId(): Promise<string>;
  /** Drop the cached token (after a 401/403). */
  invalidate(): void;
}

/** `EdgeMetadata` over the shared client. A metadata failure becomes a typed provider error. */
function sharedMetadata(): EdgeMetadata {
  const typed = async <T>(read: () => Promise<T>): Promise<T> => {
    try { return await read(); } catch (err) {
      if (err instanceof GcpMetadataError) throw new EdgeProviderError(503, `${err.message} (not running on GCP?)`);
      throw err;
    }
  };
  return {
    accessToken: () => typed(() => gcpMetadata().accessToken(AbortSignal.timeout(3_000))),
    projectId: () => typed(() => gcpMetadata().metadataText('project/project-id', AbortSignal.timeout(3_000))),
    invalidate: () => gcpMetadata().invalidate(),
  };
}

const OP_WAIT_MS = 5_000;
const OP_POLL_MS = 500;
const DETAIL_MAX = 300;

export class EdgeProviderError extends Error {
  constructor(readonly status: number, detail: string) {
    super(`certificate manager: HTTP ${status}: ${detail.slice(0, DETAIL_MAX)}`);
    this.name = 'EdgeProviderError';
  }
}

/** Deterministic resource ids for one hostname (D4). */
export function edgeResourceIds(hostname: string): { auth: string; cert: string; entry: string } {
  const base = `owp-cd-${createHash('sha256').update(hostname).digest('hex').slice(0, 20)}`;
  return { auth: `${base}-auth`, cert: `${base}-cert`, entry: `${base}-entry` };
}

type HttpResponse = { ok: boolean; status: number; text(): Promise<string> };
type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<HttpResponse>;

export interface GcpCertificateManagerDeps {
  certMap: string;
  project?: string;
  fetch?: FetchFn;
  metadata?: EdgeMetadata;
  /**
   * ADR 0906 D7 — a dedicated service account to act as. When set, every
   * Certificate Manager call uses a short-lived token minted for it through
   * IAM Credentials `generateAccessToken` (the runtime SA holds
   * `serviceAccountTokenCreator` on that account only), so the certificate
   * rights live on an account that does nothing else.
   */
  impersonate?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  opWaitMs?: number;
}

export const IAM_CREDENTIALS = 'https://iamcredentials.googleapis.com/v1';
const IMPERSONATED_LIFETIME_S = 3600;

/**
 * Wrap `base` so `accessToken()` returns a token for `serviceAccount`, minted
 * with the base (runtime) token and cached until a minute before it expires.
 * The project id still comes from the base (it is not the target's).
 */
export function impersonatedMetadata(base: EdgeMetadata, serviceAccount: string, fetchFn: FetchFn, now: () => number = Date.now): EdgeMetadata {
  let cached: { value: string; expiresAt: number } | null = null;
  return {
    projectId: () => base.projectId(),
    invalidate() { cached = null; base.invalidate(); },
    async accessToken() {
      if (cached && cached.expiresAt > now()) return cached.value;
      const res = await fetchFn(`${IAM_CREDENTIALS}/projects/-/serviceAccounts/${encodeURIComponent(serviceAccount)}:generateAccessToken`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await base.accessToken()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ scope: ['https://www.googleapis.com/auth/cloud-platform'], lifetime: `${IMPERSONATED_LIFETIME_S}s` }),
      });
      const text = await res.text().catch(() => '');
      if (res.status === 401 || res.status === 403) base.invalidate();
      if (!res.ok) throw new EdgeProviderError(res.status, `impersonating ${serviceAccount} failed (does the runtime SA hold serviceAccountTokenCreator on it?)`);
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* handled below */ }
      const token = typeof body['accessToken'] === 'string' ? body['accessToken'] : '';
      if (!token) throw new EdgeProviderError(500, 'generateAccessToken returned no accessToken');
      const expireMs = typeof body['expireTime'] === 'string' ? Date.parse(body['expireTime']) : NaN;
      const expiresAt = Number.isFinite(expireMs) ? expireMs - 60_000 : now() + 50 * 60_000;
      cached = { value: token, expiresAt };
      return token;
    },
  };
}

type Json = Record<string, unknown>;
const rec = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const undot = (s: string): string => s.replace(/\.$/, '');

export function createGcpCertificateManagerProvider(deps: GcpCertificateManagerDeps): EdgeCertificateProvider {
  const fetchFn: FetchFn = deps.fetch ?? ((url, init) => guardedEgressFetch(url, init));
  const runtime = deps.metadata ?? sharedMetadata();
  const metadata = deps.impersonate ? impersonatedMetadata(runtime, deps.impersonate, fetchFn, deps.now) : runtime;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const opWaitMs = deps.opWaitMs ?? OP_WAIT_MS;
  let projectId = deps.project;

  const base = async (): Promise<string> => {
    projectId ??= await metadata.projectId();
    return `${API}/projects/${projectId}/locations/global`;
  };

  const call = async (method: string, url: string, body?: Json): Promise<{ status: number; json: Json }> => {
    const token = await metadata.accessToken();
    const res = await fetchFn(url, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) metadata.invalidate();
    let json: Json = {};
    try { json = rec(JSON.parse(text)); } catch { /* empty or non-JSON body */ }
    return { status: res.status, json };
  };

  const fail = (status: number, json: Json): never => {
    throw new EdgeProviderError(status, str(rec(json['error'])['message']) || 'unexpected response');
  };

  /** Wait (bounded) for a long-running operation. True when it finished without error. */
  const waitOp = async (op: Json): Promise<boolean> => {
    let cur = op;
    const deadline = opWaitMs;
    for (let waited = 0; ; waited += OP_POLL_MS) {
      if (cur['done'] === true) {
        if (cur['error']) throw new EdgeProviderError(500, str(rec(cur['error'])['message']) || 'operation failed');
        return true;
      }
      if (waited >= deadline || !str(cur['name'])) return false;
      await sleep(OP_POLL_MS);
      const r = await call('GET', `${API}/${str(cur['name'])}`);
      if (r.status !== 200) return false;
      cur = r.json;
    }
  };

  /** GET-then-CREATE one resource. Returns the resource when it is visible, else null (pending). */
  const ensure = async (resourceUrl: string, createUrl: string, body: Json): Promise<Json | null> => {
    const got = await call('GET', resourceUrl);
    if (got.status === 200) return got.json;
    if (got.status !== 404) fail(got.status, got.json);
    const created = await call('POST', createUrl, body);
    if (created.status === 200) await waitOp(created.json);
    else if (created.status !== 409) fail(created.status, created.json);
    const again = await call('GET', resourceUrl);
    if (again.status === 200) return again.json;
    if (again.status === 404) return null;
    return fail(again.status, again.json);
  };

  const remove = async (url: string): Promise<boolean> => {
    const r = await call('DELETE', url);
    if (r.status === 404) return true;
    if (r.status !== 200) return false;
    try { await waitOp(r.json); } catch { return false; }
    // Done or still deleting: confirm by reading it back.
    const check = await call('GET', url);
    return check.status === 404;
  };

  return {
    id: 'gcp-certificate-manager',

    async prepare(hostname): Promise<StepResult<{ handle: EdgeHandle; dnsRecords: DnsRecord[] }>> {
      const ids = edgeResourceIds(hostname);
      const b = await base();
      const auth = await ensure(
        `${b}/dnsAuthorizations/${ids.auth}`,
        `${b}/dnsAuthorizations?dnsAuthorizationId=${ids.auth}`,
        { domain: hostname, type: 'PER_PROJECT_RECORD' },
      );
      const rr = rec(auth?.['dnsResourceRecord']);
      if (!auth || !str(rr['name']) || !str(rr['data'])) return { done: false };
      return {
        done: true,
        value: {
          handle: { dnsAuthName: str(auth['name']) },
          dnsRecords: [{ type: 'CNAME', name: undot(str(rr['name'])), value: undot(str(rr['data'])), purpose: 'certificate' }],
        },
      };
    },

    async issue(hostname, handle): Promise<StepResult<EdgeHandle>> {
      if (!handle.dnsAuthName) throw new EdgeProviderError(400, 'issue called before the DNS authorization exists');
      const ids = edgeResourceIds(hostname);
      const b = await base();
      const cert = await ensure(
        `${b}/certificates/${ids.cert}`,
        `${b}/certificates?certificateId=${ids.cert}`,
        { managed: { domains: [hostname], dnsAuthorizations: [handle.dnsAuthName] } },
      );
      if (!cert) return { done: false };
      const certName = str(cert['name']);
      const entry = await ensure(
        `${b}/certificateMaps/${deps.certMap}/certificateMapEntries/${ids.entry}`,
        `${b}/certificateMaps/${deps.certMap}/certificateMapEntries?certificateMapEntryId=${ids.entry}`,
        { hostname, certificates: [certName] },
      );
      if (!entry) return { done: false };
      return { done: true, value: { ...handle, certName, mapEntryName: str(entry['name']) } };
    },

    async status(handle): Promise<EdgeStatus> {
      if (!handle.certName) return { tls: 'awaiting_dns' };
      const r = await call('GET', `${API}/${handle.certName}`);
      if (r.status !== 200) fail(r.status, r.json);
      const managed = rec(r.json['managed']);
      const state = str(managed['state']);
      if (state === 'ACTIVE') return { tls: 'active' };
      if (state === 'FAILED') {
        const p = rec(managed['provisioningIssue']);
        return { tls: 'failed', issue: issueOf(str(p['reason']) || 'FAILED', str(p['details'])) };
      }
      const attempts = Array.isArray(managed['authorizationAttemptInfo']) ? (managed['authorizationAttemptInfo'] as unknown[]).map(rec) : [];
      const unauthorized = attempts.find((a) => str(a['state']) !== 'AUTHORIZED');
      if (attempts.length === 0 || unauthorized) {
        const failed = attempts.find((a) => str(a['state']) === 'FAILED');
        return failed
          ? { tls: 'awaiting_dns', issue: issueOf(str(failed['failureReason']) || 'AUTHORIZATION_FAILED', str(failed['details'])) }
          : { tls: 'awaiting_dns' };
      }
      return { tls: 'provisioning' };
    },

    async release(hostname): Promise<'released' | 'partial'> {
      const ids = edgeResourceIds(hostname);
      const b = await base();
      // Order matters: an entry references the certificate, the certificate the
      // authorization. Stop at the first failure; the sweep retries (D4).
      for (const url of [
        `${b}/certificateMaps/${deps.certMap}/certificateMapEntries/${ids.entry}`,
        `${b}/certificates/${ids.cert}`,
        `${b}/dnsAuthorizations/${ids.auth}`,
      ]) {
        if (!(await remove(url))) return 'partial';
      }
      return 'released';
    },
  };
}

function issueOf(reason: string, detail: string): EdgeIssue {
  return { reason: reason.slice(0, 64), detail: detail.slice(0, DETAIL_MAX) };
}
