/**
 * ADR 0742 — runtime posture (warm / cold) for the Cloud Run service this host
 * runs as. READ-ONLY by construction: the host reads its posture live from the
 * Cloud Run Admin API (the runtime SA holds `roles/run.viewer` on this one
 * service, nothing more) and PRODUCES an audited change request carrying the
 * exact commands. It never applies one. `run.services.update` cannot be scoped
 * to "min-instances and CPU only" — the same permission redeploys the image —
 * so a host that could flip its own posture could also be made to replace
 * itself. The owner chose no runtime write credential (2026-09-22).
 *
 * The posture shown is the one the SERVING revision runs (the revision holding
 * 100 % of traffic), never the service template: after a config update the
 * template names the NEW revision, which lands at 0 % while traffic is pinned by
 * name (ADR 0631). A change is `applied` only once a revision carrying it serves
 * 100 %; a 0 %-traffic revision is reported as NOT live, never as success.
 */

export const WARM = { minInstances: 1, cpuThrottled: false } as const;
export const COLD = { minInstances: 0, cpuThrottled: true } as const;

/** Cloud Run list price (us-central1, Tier 1, instance-based / CPU-always-allocated
 *  billing) per second. An ESTIMATE: excludes the free tier, request fees,
 *  networking and committed-use discounts. Read the bill for the real figure. */
export const PRICE_PER_VCPU_SECOND = 0.000018;
export const PRICE_PER_GIB_SECOND = 0.000002;
const SECONDS_PER_MONTH = 30 * 24 * 3600;

export interface ServingPosture {
  readonly minInstances: number;
  readonly cpuThrottled: boolean;
  /** 'warm' | 'cold' when the serving revision matches one of the two named
   *  postures exactly; 'custom' otherwise (e.g. min 1 but throttled). */
  readonly posture: 'warm' | 'cold' | 'custom';
  readonly cpu: number;
  readonly memoryGiB: number;
}

export interface LivePosture {
  readonly available: true;
  readonly service: string;
  readonly project: string;
  readonly region: string;
  readonly servingRevision: string | null;
  /** The serving revision's own settings — what is actually running. */
  readonly serving: ServingPosture | null;
  /** Set when the newest created revision is NOT the one serving 100 %: a
   *  configuration change exists that is not live. */
  readonly pendingRevision: string | null;
  readonly rollout: 'settled' | 'not-live';
  readonly monthlyCostUsd: { readonly warm: number; readonly cold: number };
  readonly readAt: string;
}

export type PostureRead = LivePosture | { readonly available: false; readonly reason: string };

function parseCpu(v: unknown): number {
  const s = String(v ?? '1');
  if (s.endsWith('m')) return Number(s.slice(0, -1)) / 1000;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function parseMemGiB(v: unknown): number {
  const s = String(v ?? '512Mi');
  const m = /^(\d+(?:\.\d+)?)(Mi|Gi|M|G)?$/.exec(s);
  if (!m) return 0.5;
  const n = Number(m[1]);
  return m[2] === 'Gi' || m[2] === 'G' ? n : n / 1024;
}

/** A Cloud Run Admin API v2 Revision resource → its posture. */
export function revisionPosture(rev: Record<string, any>): ServingPosture {
  const c = (rev.containers?.[0] ?? {}) as Record<string, any>;
  const minInstances = Number(rev.scaling?.minInstanceCount ?? 0);
  // v2: `cpuIdle: true` means CPU is only allocated during requests (throttled).
  const cpuThrottled = c.resources?.cpuIdle !== false;
  const posture = minInstances === WARM.minInstances && cpuThrottled === WARM.cpuThrottled ? 'warm'
    : minInstances === COLD.minInstances && cpuThrottled === COLD.cpuThrottled ? 'cold'
    : 'custom';
  return { minInstances, cpuThrottled, posture, cpu: parseCpu(c.resources?.limits?.cpu), memoryGiB: parseMemGiB(c.resources?.limits?.memory) };
}

/** The revision holding 100 % of traffic, from a v2 Service resource. Null when
 *  traffic is split (then nothing is "the" serving revision). */
export function servingRevisionName(svc: Record<string, any>): string | null {
  const statuses = (svc.trafficStatuses ?? []) as Array<{ revision?: string; percent?: number; type?: string }>;
  const full = statuses.find((t) => (t.percent ?? 0) === 100);
  if (!full) return null;
  if (full.revision) return full.revision;
  // TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST names no revision; the latest READY one serves.
  return typeof svc.latestReadyRevision === 'string' ? tail(svc.latestReadyRevision) : null;
}

function tail(name: string): string {
  return name.split('/').pop() ?? name;
}

export function monthlyCost(cpu: number, memoryGiB: number): { warm: number; cold: number } {
  const warm = (cpu * PRICE_PER_VCPU_SECOND + memoryGiB * PRICE_PER_GIB_SECOND) * SECONDS_PER_MONTH * WARM.minInstances;
  return { warm: Math.round(warm * 100) / 100, cold: 0 };
}

/**
 * Assemble the live posture from the Service resource and the SERVING
 * revision's resource. Pure, so the "a 0 %-traffic revision is not live" rule is
 * testable without Cloud Run.
 */
export function derivePosture(input: {
  service: Record<string, any>;
  servingRevision: Record<string, any> | null;
  serviceName: string;
  project: string;
  region: string;
  now: Date;
}): LivePosture {
  const serving = servingRevisionName(input.service);
  const latestCreated = typeof input.service.latestCreatedRevision === 'string' ? tail(input.service.latestCreatedRevision) : null;
  const pendingRevision = latestCreated && latestCreated !== serving ? latestCreated : null;
  const posture = input.servingRevision ? revisionPosture(input.servingRevision) : null;
  const cost = monthlyCost(posture?.cpu ?? 1, posture?.memoryGiB ?? 0.5);
  return {
    available: true,
    service: input.serviceName,
    project: input.project,
    region: input.region,
    servingRevision: serving,
    serving: posture,
    pendingRevision,
    rollout: pendingRevision || !serving ? 'not-live' : 'settled',
    monthlyCostUsd: cost,
    readAt: input.now.toISOString(),
  };
}

// ── change requests ─────────────────────────────────────────────────────────

export class ChangeRequestInvalidError extends Error {
  readonly code = 'validation_error';
}

/** EXACTLY `{ warm: boolean }`. Any other key, or any other shape, is refused:
 *  this endpoint must never become a way to pass image, env or scaling through. */
export function validateChangeRequest(body: unknown): { warm: boolean } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ChangeRequestInvalidError('body must be { warm: boolean }');
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'warm') {
    throw new ChangeRequestInvalidError(`body must be exactly { warm: boolean } (got keys: ${keys.join(', ') || 'none'})`);
  }
  const warm = (body as { warm: unknown }).warm;
  if (typeof warm !== 'boolean') throw new ChangeRequestInvalidError('warm must be a boolean');
  return { warm };
}

/** The exact commands an operator runs. Built from the two named postures only;
 *  no caller-supplied string reaches them. */
export function changeCommands(warm: boolean, where: { service: string; project: string; region: string }): string[] {
  const p = warm ? WARM : COLD;
  const loc = `--region ${where.region} --project ${where.project}`;
  return [
    `gcloud run services update ${where.service} --min-instances ${p.minInstances} ${p.cpuThrottled ? '--cpu-throttling' : '--no-cpu-throttling'} ${loc} --quiet`,
    `REV=$(gcloud run services describe ${where.service} ${loc} --format='value(status.latestCreatedRevisionName)')`,
    `gcloud run revisions describe "$REV" ${loc} --format='value(status.conditions[0].status)'   # must print True`,
    `gcloud run services update-traffic ${where.service} --to-revisions "$REV=100" ${loc} --quiet`,
  ];
}
