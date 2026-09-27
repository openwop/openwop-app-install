/**
 * ADR 0690 / PRD §8.2 — the KickTodo readiness REPORT.
 *
 * `GET /kicktodo/readiness` answers one operator question: can THIS deployment
 * run the participant loop and the Challenge Factory right now? Not "does a
 * route exist" — PRD §8.2 says that is not enough — but the things a stranger
 * actually hits in order:
 *
 *   feature toggles     resolved where the DEFAULT WORKSPACE lives, not only for
 *                       the caller — the auto-join gate (ADR 0684) resolves the
 *                       stranger's own tenant, so a per-tenant override on the
 *                       operator's tenant reads "on" to the operator and "off"
 *                       to every newcomer;
 *   pinned packs        `feature.kicktodo.*` at the pinned versions, PRESENT;
 *   default workspace   declared, provisioned, and a workspace root
 *                       (`orgId === tenantId`) — the exact shape that shipped
 *                       broken on 2026-09-15 and would have been one curl;
 *   managed provider    a server-held key seeded and decryptable;
 *   web search          configured (the Factory refuses synthetic evidence);
 *   surfaces            blob durable, not per-instance memory;
 *   scheduler           the daemon that fires every reminder is ticking here;
 *   storage             a real round-trip.
 *
 * `status` is the conjunction of the things that BLOCK a participant loop;
 * `blockers` names each one. Web search and the surfaces are reported and fold
 * into `factory.ready`, never into `status` — a host running the loop without
 * the Factory is genuinely healthy (the /readiness precedent). Same envelope on
 * 200 and 503 so a smoke script reads `blockers` off both.
 */
import type { Storage } from '../../storage/storage.js';
import { storageProbeError } from '../../routes/health.js';
import { buildInfo } from '../../host/buildInfo.js';
import { APP_VERSION } from '../../version.js';
import { getManagedProviderStatuses, type ManagedProviderStatus } from '../../providers/managedProvider.js';
import { hostWebSearchKeyStatus } from '../../host/webResearchSurface.js';
import { readDeployPosture, type DeployPosture } from '../../host/deployPosture.js';
import { effectiveImplementation, readInMemoryAllowance, type SurfaceKey } from '../../host/surfaceBackends.js';
import { scheduleDaemonLiveness, type ScheduleDaemonLiveness } from '../../host/scheduleDaemon.js';
import { getEffectiveConfig, resolveOne, buildFeatureConsole } from '../../host/featureToggles/service.js';
import type { FeatureToggleStatus } from '../../host/featureToggles/types.js';
import { declaredDefaultWorkspaceTargets } from '../../host/workspaceJoinLedger.js';
import { getOrg, isWorkspaceOrg } from '../../host/accessControlService.js';

/** The nine KickTodo feature packages (ADR 0414 … 0432). */
export const KICKTODO_FEATURE_IDS: readonly string[] = [
  'kicktodo-core',
  'kicktodo-creator',
  'kicktodo-commerce',
  'kicktodo-accountability',
  'kicktodo-integrations',
  'kicktodo-engagement',
  'kicktodo-community',
  'kicktodo-organizations',
  'kicktodo-metrics',
];

const SURFACES_REPORTED: readonly SurfaceKey[] = ['blob', 'kv', 'memory', 'observability'];

export interface KicktodoReadinessReport {
  status: 'ready' | 'degraded';
  version: string;
  build: ReturnType<typeof buildInfo>;
  posture: DeployPosture;
  /** Every reason `status` is not `ready`, in the order a stranger would hit it. */
  blockers: string[];
  checks: {
    features: {
      id: string;
      registered: boolean;
      /** The GLOBAL status (`null` when the feature is not registered on this build). */
      global: FeatureToggleStatus | null;
      /** Resolved for the caller's tenant. */
      callerTenant: boolean;
      /** Resolved where the default workspace lives — what a stranger's auto-join
       *  sees. `null` when no default workspace is declared. */
      defaultWorkspace: boolean | null;
    }[];
    packs: { feature: string; name: string; version: string; status: string; onDiskVersion?: string }[];
    defaultWorkspaces: {
      featureId: string;
      orgId: string;
      tenantId: string;
      provisioned: boolean;
      /** A workspace root — the org row's tenant EQUALS the declared id. */
      enterable: boolean;
      storedTenantId?: string;
    }[];
    managedProviders: ManagedProviderStatus[];
    webSearch: Awaited<ReturnType<typeof hostWebSearchKeyStatus>>;
    /** Reported, never gating `status`: the Factory's own prerequisites. */
    factory: { ready: boolean; reasons: string[] };
    surfaces: { implementation: Record<string, string>; inMemoryAllowance: 'all' | 'none' | string[] };
    scheduler: ScheduleDaemonLiveness;
    storage: { ok: true; skipped?: true } | { ok: false; error: string };
  };
}

export async function buildKicktodoReadiness(input: { tenantId: string; storage?: Storage }): Promise<KicktodoReadinessReport> {
  const blockers: string[] = [];

  // Default workspaces — declared by a feature, provisioned at boot, enterable.
  const kicktodoTargets = declaredDefaultWorkspaceTargets().filter((t) => KICKTODO_FEATURE_IDS.includes(t.featureId));
  const defaultWorkspaces: KicktodoReadinessReport['checks']['defaultWorkspaces'] = [];
  for (const t of kicktodoTargets) {
    const org = await getOrg(t.orgId);
    const enterable = org ? isWorkspaceOrg(org) && org.tenantId === t.tenantId : false;
    defaultWorkspaces.push({
      featureId: t.featureId, orgId: t.orgId, tenantId: t.tenantId,
      provisioned: org !== null, enterable,
      ...(org ? { storedTenantId: org.tenantId } : {}),
    });
    if (!org) blockers.push(`default workspace ${t.orgId} (declared by ${t.featureId}) is not provisioned`);
    else if (!enterable) blockers.push(`default workspace ${t.orgId} is provisioned but not enterable (stored tenant ${org.tenantId}, declared ${t.tenantId})`);
  }
  const defaultTenant = kicktodoTargets[0]?.tenantId;

  // Features — global, caller, and where the default lives.
  const features: KicktodoReadinessReport['checks']['features'] = [];
  for (const id of KICKTODO_FEATURE_IDS) {
    const config = await getEffectiveConfig(id);
    const callerTenant = (await resolveOne(id, { tenantId: input.tenantId }))?.enabled ?? false;
    const defaultWorkspace = defaultTenant ? ((await resolveOne(id, { tenantId: defaultTenant }))?.enabled ?? false) : null;
    features.push({ id, registered: config !== null, global: config?.status ?? null, callerTenant, defaultWorkspace });
  }
  const core = features.find((f) => f.id === 'kicktodo-core');
  if (!core?.registered) blockers.push('kicktodo-core is not registered on this build');
  else if (defaultTenant && core.defaultWorkspace === false) blockers.push(`kicktodo-core resolves OFF where the default workspace lives (${defaultTenant}) — auto-join is dark for every stranger`);

  // Pinned packs — present at the pinned version.
  const console_ = await buildFeatureConsole();
  const packs: KicktodoReadinessReport['checks']['packs'] = [];
  for (const entry of console_) {
    if (!KICKTODO_FEATURE_IDS.includes(entry.id)) continue;
    for (const p of entry.packs) {
      packs.push({ feature: entry.id, name: p.name, version: p.version, status: p.status, ...(p.onDiskVersion ? { onDiskVersion: p.onDiskVersion } : {}) });
      if (p.status === 'missing' || p.status === 'tombstoned') blockers.push(`pack ${p.name}@${p.version} pinned by ${entry.id} is ${p.status}`);
    }
  }

  // Managed provider — KickBot's brain.
  let managedProviders: ManagedProviderStatus[] = [];
  try {
    managedProviders = await getManagedProviderStatuses();
  } catch (err) {
    blockers.push(`managed provider status unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const p of managedProviders) if (!p.ready) blockers.push(`managed provider ${p.providerId} is not ready${p.detail ? ` — ${p.detail}` : ''}`);

  // Web search — reported; folds into factory.ready only.
  let webSearch: Awaited<ReturnType<typeof hostWebSearchKeyStatus>> = { configured: false, source: null };
  try {
    webSearch = await hostWebSearchKeyStatus();
  } catch { /* reported as unconfigured */ }

  // Surfaces — honest implementation names; memory means per-instance.
  const implementation: Record<string, string> = {};
  for (const key of SURFACES_REPORTED) implementation[key] = effectiveImplementation(key, 'memory');
  const allowance = readInMemoryAllowance(SURFACES_REPORTED);
  const inMemoryAllowance: 'all' | 'none' | string[] = allowance.all ? 'all' : allowance.surfaces.size === 0 ? 'none' : [...allowance.surfaces];

  // Scheduler — the daemon that fires every reminder.
  const scheduler = scheduleDaemonLiveness();
  if (!scheduler.started) blockers.push('schedule daemon has not started on this instance — no reminder, session or coach turn can fire');
  else if (scheduler.ageMs !== null && scheduler.ageMs > scheduler.pollIntervalMs * 4) blockers.push(`schedule daemon last ticked ${Math.round(scheduler.ageMs / 1000)}s ago (poll ${scheduler.pollIntervalMs / 1000}s) — starved`);

  // Storage — a real round-trip.
  let storage: KicktodoReadinessReport['checks']['storage'] = { ok: true, skipped: true };
  if (input.storage) {
    const err = await storageProbeError(input.storage);
    storage = err ? { ok: false, error: err } : { ok: true };
    if (err) blockers.push(`storage probe failed: ${err}`);
  }

  // Factory — reported, never gating.
  const factoryReasons: string[] = [];
  const creator = features.find((f) => f.id === 'kicktodo-creator');
  if (!webSearch.configured) factoryReasons.push('web search is not configured — research falls back to synthetic results the evidence gate refuses');
  if (managedProviders.some((p) => !p.ready)) factoryReasons.push('the managed provider is not ready — plan-generate and the sim personas have no brain');
  if (defaultTenant && creator?.defaultWorkspace === false) factoryReasons.push(`kicktodo-creator resolves OFF where the default workspace lives (${defaultTenant}) — a challenge authored there publishes into the operator's private catalog`);
  if (implementation['blob'] === 'memory') factoryReasons.push('blob surface is in-memory — lesson media does not survive a restart or reach another instance');

  return {
    status: blockers.length === 0 ? 'ready' : 'degraded',
    version: APP_VERSION,
    build: buildInfo(),
    posture: readDeployPosture(),
    blockers,
    checks: {
      features,
      packs,
      defaultWorkspaces,
      managedProviders,
      webSearch,
      factory: { ready: factoryReasons.length === 0, reasons: factoryReasons },
      surfaces: { implementation, inMemoryAllowance },
      scheduler,
      storage,
    },
  };
}
