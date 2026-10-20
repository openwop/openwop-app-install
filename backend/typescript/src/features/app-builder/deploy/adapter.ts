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
import { GcpMetadataError, gcpMetadata } from '../../../host/gcpAdc.js';

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

/**
 * ADR 0835 D1 — the exit guards. The adapter acts with the HOST's identity
 * (`run.admin` on the operator's project), so it must refuse anything the
 * namespace did not produce: without this, a deploy named `openwop-app-backend`
 * fell through `POST` (exists) into `PATCH` and replaced the host. Checked in
 * every verb, before any token is minted.
 */
const NAMESPACED_SERVICE_RE = /^owa-[0-9a-f]{12}-[a-z][a-z0-9-]{1,30}[a-z0-9]$/;

export function assertNamespacedService(service: string): void {
  if (!NAMESPACED_SERVICE_RE.test(service)) {
    throw new OpenwopError('forbidden', 'The deploy adapter only acts on services the host namespaced (owa-…).', 403, { capability: 'app-deploy' });
  }
}

/** The operator's image policy: comma-separated registry prefixes, each ending
 *  in `/` (so `gcr.io/acme/` cannot be satisfied by `gcr.io/acme-evil/`).
 *  Unset ⇒ the provider is not configured (honest 501), never "any image". */
export function assertImageAllowed(image: string): void {
  const prefixes = (process.env.OPENWOP_APP_DEPLOY_IMAGE_PREFIXES ?? '').split(',').map((p) => p.trim()).filter((p) => p.endsWith('/'));
  if (!prefixes.length) {
    throw new OpenwopError('capability_not_provided', 'Cloud Run deploys need OPENWOP_APP_DEPLOY_IMAGE_PREFIXES (the registries apps may be deployed from).', 501, { capability: 'app-deploy' });
  }
  if (/\s/.test(image) || !prefixes.some((p) => image.startsWith(p) && image.length > p.length)) {
    throw new OpenwopError('forbidden', 'The image is not in a registry this host deploys from.', 403, { capability: 'app-deploy', field: 'image' });
  }
}

/** The identity the deployed container runs as. Never the project's default
 *  compute account: that one can mint project credentials from the metadata
 *  server, so any allowed image would run as the project. */
function runtimeServiceAccount(): string {
  const sa = (process.env.OPENWOP_APP_DEPLOY_RUNTIME_SA ?? '').trim();
  if (!sa) {
    throw new OpenwopError('capability_not_provided', 'Cloud Run deploys need OPENWOP_APP_DEPLOY_RUNTIME_SA (a service account with no project roles).', 501, { capability: 'app-deploy' });
  }
  return sa;
}

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
  try {
    return await gcpMetadata().accessToken();
  } catch (err) {
    if (err instanceof GcpMetadataError) throw new OpenwopError('capability_not_provided', 'No GCP metadata identity available (not running on Cloud Run?).', 501, {});
    throw err;
  }
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
      assertNamespacedService(service);
      assertImageAllowed(image);
      const serviceAccount = runtimeServiceAccount();
      // Create-or-patch the service with the given image; env carries SYMBOLIC
      // keys resolved from the service's own runtime env (never values here).
      // PATCH can only reach a name the namespace produced (guard above).
      const spec = {
        template: { serviceAccount, containers: [{ image, env: envKeys.map((k) => ({ name: k, valueSource: undefined })) }] },
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
      assertNamespacedService(service);
      const patch = await call('PATCH', `/services/${encodeURIComponent(service)}`, {
        traffic: [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION', revision: toRevision, percent: 100 }],
      });
      return patch.ok ? { ok: true, value: { revision: toRevision } } : patch;
    },
    async status(service) {
      assertNamespacedService(service);
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
