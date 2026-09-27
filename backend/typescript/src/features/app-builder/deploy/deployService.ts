/**
 * ADR 0424 — governed deploy records. The invariants (from ADR 0349's
 * contract): idempotent (deterministic key over service|exportHash|image — a
 * re-run/fork resolves the existing deployment, never re-deploys), CAS
 * single-flight, env SYMBOLIC-keys-only (a value-shaped entry is a typed 422 —
 * no credential ever rides the deploy input), every record auditable to its
 * export lineage hash, tenant-keyed + teardown-registered.
 */
import { createHash } from 'node:crypto';
import { OpenwopError } from '../../../types.js';
import { DurableCollection } from '../../../host/hostExtPersistence.js';
import type { DeployAdapter } from './adapter.js';

export interface DeploymentRecord {
  deployKey: string;
  tenantId: string;
  orgId: string;
  service: string;
  image: string;
  exportHash: string;
  envKeys: string[];
  status: 'deploying' | 'deployed' | 'failed' | 'rolled-back';
  deploymentId?: string;
  url?: string;
  revision?: string;
  error?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export const deployments = new DurableCollection<DeploymentRecord>(
  'app-deploy:deployment',
  (d) => `${d.tenantId}:${d.deployKey}`,
  undefined,
  (d) => d.tenantId,
);

/** A `deploying` row older than this is a crashed worker — re-claimable. Long
 *  enough that a live Cloud Run deploy (minutes) is never stolen. */
const STALE_DEPLOYING_MS = 15 * 60_000;

const SERVICE_RE = /^[a-z][a-z0-9-]{2,48}$/;
/** A symbolic env KEY — never a value ("K=V", whitespace, or secret-shaped
 *  strings are rejected; the 0343/0349 invariant). */
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

export function parseEnvKeys(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new OpenwopError('validation_error', 'Field `envKeys` must be an array of symbolic keys.', 422, { field: 'envKeys' });
  return raw.map((v, i) => {
    if (typeof v !== 'string' || !ENV_KEY_RE.test(v)) {
      throw new OpenwopError('validation_error', `envKeys[${i}] must be a SYMBOLIC key (A-Z0-9_) — values never ride the deploy input.`, 422, { field: 'envKeys' });
    }
    return v;
  });
}

export interface StartDeployInput {
  tenantId: string;
  orgId: string;
  service: string;
  image: string;
  exportHash: string;
  envKeys: unknown;
  createdBy: string;
}

export async function startDeploy(adapter: DeployAdapter, input: StartDeployInput): Promise<DeploymentRecord> {
  if (!SERVICE_RE.test(input.service)) throw new OpenwopError('validation_error', 'Field `service` must be lowercase-kebab (3-49 chars).', 422, { field: 'service' });
  if (!input.image.trim()) throw new OpenwopError('validation_error', 'Field `image` is required (v1 deploys prebuilt images — ADR 0424 §Gates).', 422, { field: 'image' });
  if (!/^[0-9a-f]{64}$/.test(input.exportHash)) throw new OpenwopError('validation_error', 'Field `exportHash` must be the sha256 export lineage hash.', 422, { field: 'exportHash' });
  const envKeys = parseEnvKeys(input.envKeys);

  const deployKey = createHash('sha256').update(`${input.service}|${input.exportHash}|${input.image}`).digest('hex').slice(0, 24);
  const key = `${input.tenantId}:${deployKey}`;
  const existing = await deployments.get(key);
  if (existing && existing.tenantId === input.tenantId) {
    // A record stuck `deploying` past the stale window is a CRASHED worker
    // (architect gate 2026-07-18): re-claim it via CAS instead of returning a
    // permanent in-flight tombstone — the creative-video/computer-use stale-
    // state discipline. A FRESH in-flight record is returned untouched (no
    // stealing a live deploy). Settled records always resolve idempotently.
    const stale = existing.status === 'deploying' && Date.now() - Date.parse(existing.updatedAt) > STALE_DEPLOYING_MS;
    if (!stale) return existing; // idempotent — replay never re-deploys
    const reclaimed: DeploymentRecord = { ...existing, status: 'deploying', updatedAt: new Date().toISOString() };
    const won = await deployments.compareAndSwap(existing, reclaimed);
    if (!won) {
      const raced = await deployments.get(key);
      if (raced) return raced;
    } else {
      const out = await adapter.deploy({ service: existing.service, image: existing.image, envKeys: existing.envKeys });
      const settled: DeploymentRecord = out.ok
        ? { ...reclaimed, status: 'deployed', deploymentId: out.value.deploymentId, url: out.value.url, revision: out.value.revision, updatedAt: new Date().toISOString() }
        : { ...reclaimed, status: 'failed', error: out.error, updatedAt: new Date().toISOString() };
      await deployments.put(settled);
      return settled;
    }
  }

  const now = new Date().toISOString();
  const fresh: DeploymentRecord = {
    deployKey, tenantId: input.tenantId, orgId: input.orgId,
    service: input.service, image: input.image, exportHash: input.exportHash, envKeys,
    status: 'deploying', createdBy: input.createdBy, createdAt: now, updatedAt: now,
  };
  const won = await deployments.compareAndSwap(null, fresh);
  if (!won) {
    const raced = await deployments.get(key);
    if (raced) return raced; // single-flight — the concurrent caller owns it
  }

  const out = await adapter.deploy({ service: input.service, image: input.image, envKeys });
  const settled: DeploymentRecord = out.ok
    ? { ...fresh, status: 'deployed', deploymentId: out.value.deploymentId, url: out.value.url, revision: out.value.revision, updatedAt: new Date().toISOString() }
    : { ...fresh, status: 'failed', error: out.error, updatedAt: new Date().toISOString() };
  await deployments.put(settled);
  return settled;
}

export async function rollbackDeploy(adapter: DeployAdapter, tenantId: string, deployKey: string, toRevision: string): Promise<DeploymentRecord> {
  const rec = await deployments.get(`${tenantId}:${deployKey}`);
  if (!rec || rec.tenantId !== tenantId) throw new OpenwopError('not_found', 'Deployment not found.', 404, { deployKey });
  const out = await adapter.rollback({ service: rec.service, toRevision });
  if (!out.ok) throw new OpenwopError('invalid_request', `Rollback failed: ${out.error}`, 502, { deployKey, toRevision });
  const settled: DeploymentRecord = { ...rec, status: 'rolled-back', revision: out.value.revision, updatedAt: new Date().toISOString() };
  await deployments.put(settled);
  return settled;
}

export async function getDeployment(tenantId: string, deployKey: string): Promise<DeploymentRecord | null> {
  const rec = await deployments.get(`${tenantId}:${deployKey}`);
  return rec && rec.tenantId === tenantId ? rec : null;
}
