/**
 * ADR 0922 D1 — the campaign asset registry. Every asset belongs to exactly one
 * client; the same destination target cannot be registered under two clients
 * (a per-target claim row, written by CAS before the asset).
 *
 * @see docs/adr/0922-campaign-ops-asset-registry-and-destinations.md
 */
import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { cleanString } from '../../host/boundedStrings.js';
import { OpenwopError } from '../../types.js';
import { adapterFor } from './adapters/registry.js';
import { getClient } from './clientService.js';
import { DESTINATION_KINDS, type AssetLocator, type CampaignAsset, type DestinationKind } from './types.js';

const assets = new DurableCollection<CampaignAsset>(
  'campaign-ops:asset',
  (a) => `${a.tenantId}::${a.orgId}::${a.assetId}`,
  undefined,
  (a) => a.tenantId,
);

/** One row per destination target per tenant: the target's owning asset. */
interface AssetClaim { tenantId: string; claimKey: string; orgId: string; assetId: string }
const claims = new DurableCollection<AssetClaim>('campaign-ops:asset-claim', (c) => `${c.tenantId}::${c.claimKey}`, undefined, (c) => c.tenantId);

const MAX_EDITABLE_FIELDS = 50;
const nowIso = (): string => new Date().toISOString();
const claimKeyOf = (destination: DestinationKind, locator: AssetLocator): string => `${destination}|${locator.pageId}`;

/** The uniform not-found every wrong-client or missing read collapses to. */
function notFound(assetId?: string): OpenwopError {
  return new OpenwopError('not_found', 'Asset not found.', 404, assetId ? { assetId } : {});
}

function parseLocator(destination: DestinationKind, raw: unknown): AssetLocator {
  const pageId = raw && typeof raw === 'object' ? (raw as { pageId?: unknown }).pageId : undefined;
  if (destination === 'openwop.cms.page' && typeof pageId === 'string' && pageId.length > 0 && pageId.length <= 200) return { pageId };
  throw new OpenwopError('validation_error', 'A CMS page asset needs `locator.pageId`.', 400, { field: 'locator' });
}

/** Load an asset of THIS client. A row of another client is the same 404 as none. */
export async function getAsset(tenantId: string, orgId: string, assetId: string): Promise<CampaignAsset | null> {
  const a = await assets.get(`${tenantId}::${orgId}::${assetId}`);
  return a && a.tenantId === tenantId && a.orgId === orgId ? a : null;
}

export async function listAssets(tenantId: string, orgId: string, campaignId?: string): Promise<CampaignAsset[]> {
  return (await assets.listForTenantIndexed(tenantId))
    .filter((a) => a.tenantId === tenantId && a.orgId === orgId && (!campaignId || a.campaignId === campaignId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function addAsset(input: {
  tenantId: string;
  orgId: string;
  destination: unknown;
  locator: unknown;
  label: unknown;
  editableFields: unknown;
  campaignId?: string;
  createdBy: string;
  synthetic?: boolean;
}): Promise<CampaignAsset> {
  const client = await getClient(input.tenantId, input.orgId);
  if (!client) throw new OpenwopError('not_found', 'Client not found.', 404, { orgId: input.orgId });
  if (client.status !== 'active') throw new OpenwopError('validation_error', 'This client is not active.', 409, { reason: 'client_inactive' });
  if (typeof input.destination !== 'string' || !(DESTINATION_KINDS as readonly string[]).includes(input.destination)) {
    throw new OpenwopError('validation_error', `Unsupported destination. Supported: ${DESTINATION_KINDS.join(', ')}.`, 400, { field: 'destination' });
  }
  const destination = input.destination as DestinationKind;
  const adapter = adapterFor(destination);
  if (!adapter) throw new OpenwopError('validation_error', 'This destination is not available.', 409, { reason: 'destination_unavailable' });
  const locator = parseLocator(destination, input.locator);
  const label = cleanString(input.label, 120, '').trim();
  if (!label) throw new OpenwopError('validation_error', 'An asset needs a label.', 400, { field: 'label' });

  // The adapter reads IN THIS CLIENT ORG; another client's page reads as null.
  const snap = await adapter.read({ orgId: input.orgId, locator }, { tenantId: input.tenantId });
  if (!snap) throw new OpenwopError('not_found', 'That page was not found in this client.', 404, { reason: 'wrong_client_or_missing' });

  if (!Array.isArray(input.editableFields) || input.editableFields.length === 0 || input.editableFields.length > MAX_EDITABLE_FIELDS) {
    throw new OpenwopError('validation_error', `Pick 1–${MAX_EDITABLE_FIELDS} editable fields.`, 400, { field: 'editableFields' });
  }
  const editableFields = [...new Set(input.editableFields.map(String))];
  const unknown = editableFields.filter((f) => !(f in snap.fields));
  if (unknown.length > 0) {
    throw new OpenwopError('validation_error', 'Some editable fields do not exist on this page.', 400, { field: 'editableFields', unknown });
  }

  const now = nowIso();
  const asset: CampaignAsset = {
    tenantId: input.tenantId,
    orgId: input.orgId,
    assetId: `ast:${randomUUID()}`,
    ...(input.campaignId ? { campaignId: cleanString(input.campaignId, 200, '') } : {}),
    destination,
    locator,
    label,
    editableFields,
    lastKnown: { version: snap.version, contentHash: snap.contentHash, readAt: now },
    ...(input.synthetic ? { synthetic: true as const } : {}),
    createdAt: now,
    createdBy: input.createdBy,
    updatedAt: now,
  };
  const claim: AssetClaim = { tenantId: input.tenantId, claimKey: claimKeyOf(destination, locator), orgId: input.orgId, assetId: asset.assetId };
  if (!(await claims.compareAndSwap(null, claim))) {
    throw new OpenwopError('conflict', 'This page is already registered as an asset.', 409, { reason: 'asset_already_registered' });
  }
  await assets.put(asset);
  return asset;
}

/** Re-read `lastKnown` through the adapter. The only writer of `lastKnown`. */
export async function refreshAsset(tenantId: string, orgId: string, assetId: string): Promise<CampaignAsset> {
  const cur = await getAsset(tenantId, orgId, assetId);
  if (!cur) throw notFound(assetId);
  const adapter = adapterFor(cur.destination);
  const snap = adapter ? await adapter.read(cur, { tenantId }) : null;
  if (!snap) throw new OpenwopError('not_found', 'The page behind this asset is gone.', 404, { reason: 'asset_gone', assetId });
  const now = nowIso();
  const next: CampaignAsset = { ...cur, lastKnown: { version: snap.version, contentHash: snap.contentHash, readAt: now }, updatedAt: now };
  if (!(await assets.compareAndSwap(cur, next))) throw new OpenwopError('conflict', 'The asset changed; try again.', 409, { reason: 'asset_changed' });
  return next;
}

export async function removeAsset(tenantId: string, orgId: string, assetId: string): Promise<boolean> {
  const cur = await getAsset(tenantId, orgId, assetId);
  if (!cur) return false;
  await assets.delete(`${tenantId}::${orgId}::${assetId}`);
  await claims.delete(`${tenantId}::${claimKeyOf(cur.destination, cur.locator)}`);
  return true;
}

/** ADR 0464 — re-attribute `createdBy` for an erased subject (rows are kept). */
export async function eraseAssetCreators(tenantId: string, forms: ReadonlySet<string>, tombstone: string): Promise<number> {
  let n = 0;
  for (const a of await assets.listForTenantIndexed(tenantId)) {
    if (a.tenantId !== tenantId || !forms.has(a.createdBy)) continue;
    if (await assets.compareAndSwap(a, { ...a, createdBy: tombstone })) n++;
  }
  return n;
}

/** Remove every asset (and its claim) of one client. */
export async function purgeAssetsForOrg(tenantId: string, orgId: string): Promise<number> {
  let n = 0;
  for (const a of await listAssets(tenantId, orgId)) if (await removeAsset(tenantId, orgId, a.assetId)) n++;
  return n;
}
