/**
 * ADR 0424 — the DeployAdapter seam (DECIDE-1: Cloud Run, same project).
 * Mock-first: the mock proves the governed loop with zero egress; the Cloud
 * Run adapter drives the Admin API v2 through `guardedEgressFetch` with the
 * host's metadata-server identity (the operator grants `run.admin` — the
 * explicit opt-in). HONEST-OFF: no configured provider ⇒ a typed
 * `capability_not_provided`; `mock` is explicit opt-in (test/dev).
 */
import { OpenwopError } from '../../../types.js';
import { guardedEgressFetch } from '../../../host/webhookEgressGuard.js';

export interface DeployInput {
  /** Cloud Run service id (lowercase-kebab, validated). */
  service: string;
  /** A prebuilt container image ref — v1 takes images, never guesses builds
   *  (ADR 0424 §Gates: source→image is the Cloud Build follow-on). */
  image: string;
  /** SYMBOLIC env keys only (ADR 0343) — values bind in the deploy env. */
  envKeys: string[];
}
export interface DeployResult { deploymentId: string; url: string; revision: string }
export interface DeployStatus { service: string; ready: boolean; revision?: string; url?: string }
export type AdapterResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface DeployAdapter {
  deploy(input: DeployInput): Promise<AdapterResult<DeployResult>>;
  rollback(input: { service: string; toRevision: string }): Promise<AdapterResult<{ revision: string }>>;
  status(service: string): Promise<AdapterResult<DeployStatus>>;
}

// ── mock (deterministic, zero egress) ───────────────────────────────────────

export function makeMockDeployAdapter(): DeployAdapter & { calls: { deploy: number; rollback: number } } {
  const revisions = new Map<string, string[]>();
  const calls = { deploy: 0, rollback: 0 };
  return {
    calls,
    async deploy({ service }) {
      calls.deploy += 1;
      const list = revisions.get(service) ?? [];
      const revision = `${service}-rev-${list.length + 1}`;
      revisions.set(service, [...list, revision]);
      return { ok: true, value: { deploymentId: `dep-${service}-${list.length + 1}`, url: `https://${service}.mock.run.app`, revision } };
    },
    async rollback({ service, toRevision }) {
      calls.rollback += 1;
      const list = revisions.get(service) ?? [];
      if (!list.includes(toRevision)) return { ok: false, error: 'revision_not_found' };
      return { ok: true, value: { revision: toRevision } };
    },
    async status(service) {
      const list = revisions.get(service) ?? [];
      return { ok: true, value: { service, ready: list.length > 0, ...(list.length ? { revision: list[list.length - 1]!, url: `https://${service}.mock.run.app` } : {}) } };
    },
  };
}

// ── Cloud Run (Admin API v2, metadata identity, brokered egress) ────────────

function gcpConfig(): { project: string; region: string } {
  const project = process.env.OPENWOP_APP_DEPLOY_GCP_PROJECT ?? '';
  const region = process.env.OPENWOP_APP_DEPLOY_GCP_REGION ?? 'us-central1';
  if (!project) {
    throw new OpenwopError('capability_not_provided', 'Cloud Run deploys need OPENWOP_APP_DEPLOY_GCP_PROJECT.', 501, { capability: 'app-deploy' });
  }
  return { project, region };
}

/** Metadata-server access token — the host's OWN service identity on Cloud
 *  Run (no stored credentials; the operator grants roles/run.admin). */
async function metadataToken(): Promise<string> {
  const res = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
    headers: { 'Metadata-Flavor': 'Google' },
  });
  if (!res.ok) throw new OpenwopError('capability_not_provided', 'No GCP metadata identity available (not running on Cloud Run?).', 501, {});
  return ((await res.json()) as { access_token: string }).access_token;
}

export function makeCloudRunAdapter(): DeployAdapter {
  const base = (): { url: string; project: string; region: string } => {
    const { project, region } = gcpConfig();
    return { url: `https://run.googleapis.com/v2/projects/${project}/locations/${region}`, project, region };
  };
  const call = async (method: string, path: string, body?: unknown): Promise<AdapterResult<Record<string, unknown>>> => {
    const token = await metadataToken();
    const res = await guardedEgressFetch(`${base().url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) return { ok: false, error: `cloud_run_${res.status}` };
    return { ok: true, value: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  return {
    async deploy({ service, image, envKeys }) {
      // Create-or-patch the service with the given image; env carries SYMBOLIC
      // keys resolved from the service's own runtime env (never values here).
      const spec = {
        template: { containers: [{ image, env: envKeys.map((k) => ({ name: k, valueSource: undefined })) }] },
      };
      const create = await call('POST', `/services?serviceId=${encodeURIComponent(service)}`, spec);
      const op = create.ok ? create : await call('PATCH', `/services/${encodeURIComponent(service)}`, spec);
      if (!op.ok) return op;
      const st = await this.status(service);
      const revision = st.ok && st.value.revision ? st.value.revision : 'pending';
      const url = st.ok && st.value.url ? st.value.url : '';
      return { ok: true, value: { deploymentId: `${service}@${revision}`, url, revision } };
    },
    async rollback({ service, toRevision }) {
      const patch = await call('PATCH', `/services/${encodeURIComponent(service)}`, {
        traffic: [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION', revision: toRevision, percent: 100 }],
      });
      return patch.ok ? { ok: true, value: { revision: toRevision } } : patch;
    },
    async status(service) {
      const got = await call('GET', `/services/${encodeURIComponent(service)}`);
      if (!got.ok) return got;
      const v = got.value as { latestReadyRevision?: string; uri?: string; terminalCondition?: { state?: string } };
      const revision = typeof v.latestReadyRevision === 'string' ? v.latestReadyRevision.split('/').pop() : undefined;
      return { ok: true, value: { service, ready: v.terminalCondition?.state === 'CONDITION_SUCCEEDED', ...(revision ? { revision } : {}), ...(typeof v.uri === 'string' ? { url: v.uri } : {}) } };
    },
  };
}

// ── resolver (honest-off) ───────────────────────────────────────────────────

let mockSingleton: (DeployAdapter & { calls: { deploy: number; rollback: number } }) | null = null;

export function resolveDeployAdapter(): DeployAdapter {
  const provider = process.env.OPENWOP_APP_DEPLOY_PROVIDER ?? '';
  if (provider === 'cloud-run') return makeCloudRunAdapter();
  if (provider === 'mock' || process.env.NODE_ENV === 'test' || process.env.VITEST) {
    if (!mockSingleton) mockSingleton = makeMockDeployAdapter();
    return mockSingleton;
  }
  throw new OpenwopError(
    'capability_not_provided',
    'No app-deploy provider is configured (OPENWOP_APP_DEPLOY_PROVIDER). Cloud Run deploys require operator configuration + a run.admin grant.',
    501,
    { capability: 'app-deploy' },
  );
}
