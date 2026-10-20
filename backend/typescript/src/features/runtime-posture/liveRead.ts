/**
 * ADR 0742 — read the live posture from the Cloud Run Admin API (v2), as this
 * instance's runtime service account (`roles/run.viewer` on this one service).
 * Off Cloud Run (`K_SERVICE` unset: local dev, tests) it reports unavailable
 * rather than inventing a posture: the page must never show state the host did
 * not read back from Cloud Run.
 */
import { derivePosture, type PostureRead } from './service.js';
import { createGcpMetadataClient, gcpMetadata } from '../../host/gcpAdc.js';

const DEADLINE_MS = 3_000;

type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export async function readLivePosture(opts: { env?: NodeJS.ProcessEnv; fetchImpl?: FetchLike; now?: () => Date } = {}): Promise<PostureRead> {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const service = env.K_SERVICE;
  if (!service) return { available: false, reason: 'not running on Cloud Run (K_SERVICE is unset)' };
  try {
    const md = opts.fetchImpl ? createGcpMetadataClient({ fetchImpl }) : gcpMetadata();
    const project = await md.metadataText('project/project-id', AbortSignal.timeout(DEADLINE_MS));
    const region = (await md.metadataText('instance/region', AbortSignal.timeout(DEADLINE_MS))).split('/').pop() ?? '';
    const auth = { Authorization: `Bearer ${await md.accessToken(AbortSignal.timeout(DEADLINE_MS))}` };
    const base = `https://run.googleapis.com/v2/projects/${project}/locations/${region}/services/${service}`;
    const svcRes = await fetchImpl(base, { headers: auth, signal: AbortSignal.timeout(DEADLINE_MS) });
    if (!svcRes.ok) throw new Error(`Cloud Run Admin API answered ${svcRes.status} for the service (does the runtime SA hold roles/run.viewer on it?)`);
    const svc = (await svcRes.json()) as Record<string, any>;
    const statuses = (svc.trafficStatuses ?? []) as Array<{ revision?: string; percent?: number }>;
    const full = statuses.find((t) => (t.percent ?? 0) === 100);
    const servingName = full?.revision ?? (typeof svc.latestReadyRevision === 'string' ? svc.latestReadyRevision.split('/').pop() : undefined);
    let servingRevision: Record<string, any> | null = null;
    if (servingName) {
      const revRes = await fetchImpl(`${base}/revisions/${servingName}`, { headers: auth, signal: AbortSignal.timeout(DEADLINE_MS) });
      if (revRes.ok) servingRevision = (await revRes.json()) as Record<string, any>;
    }
    return derivePosture({ service: svc, servingRevision, serviceName: service, project, region, now: (opts.now ?? (() => new Date()))() });
  } catch (err) {
    return { available: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
