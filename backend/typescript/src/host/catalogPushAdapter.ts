/**
 * ADR 0952 D6 (P7) — the ONE egress owner for catalog pushes: Meta Catalog
 * (`items_batch`, over the meta-ads connection's `catalog.manage` scope group)
 * and Google Merchant Center (Merchant API products v1, over the google-merchant
 * connection). Both go through the Connections broker (credential host-side,
 * `apiHosts` pinned), and both are `unsupported` until sandbox-verified
 * (`adsCatalogPushEnabled`). Never throws: every item gets a typed result.
 *
 * Which items to send is the caller's question (the feed's content hashes);
 * this module only sends what it is given and reports per item.
 */

import { brokeredFetch, brokeredPost, type BrokeredEgressDeps } from './brokeredEgress.js';
import { contentHashOf, noticeAfterEffect } from './autonomyPolicy/enforce.js';
import { gateCatalogPublish, type CatalogPublishGate } from './adsAdapter.js';
import {
  adsCatalogPushEnabled, buildMetaItemsBatchBody, buildMerchantProductInput, META_CATALOG_BATCH_MAX, metaApiBase, merchantApiBase,
  type CatalogPushItem,
} from './adsWire.js';

export type CatalogPlatform = 'meta' | 'google';
export interface CatalogTarget {
  /** meta: the catalog id. */
  metaCatalogId?: string;
  /** google: `accounts/{id}/dataSources/{id}` plus the account id and the input's language/label. */
  merchantAccountId?: string;
  merchantDataSource?: string;
  contentLanguage: string;
  feedLabel: string;
}
export type ItemResult = { id: string; op: 'upsert' | 'delete'; outcome: 'ok' } | { id: string; op: 'upsert' | 'delete'; outcome: 'failed'; error: string };
export type CatalogPushResult =
  | { outcome: 'pushed'; results: ItemResult[] }
  | { outcome: 'unsupported'; reason: 'not_sandbox_verified' }
  | { outcome: 'no_connection' }
  | { outcome: 'not_configured'; missing: string }
  /** ADR 0942 / spend governance — the policy refuses this publish. */
  | { outcome: 'refused'; error: Extract<CatalogPublishGate, { verdict: 'refused' }>['error'] }
  /** A person must approve this exact content first (a campaign-spend approval, kind publish). */
  | { outcome: 'requires_approval'; approvalId: string; autonomy?: true };

const PROVIDER: Record<CatalogPlatform, string> = { meta: 'meta-ads', google: 'google-merchant' };

export async function pushCatalogItems(
  deps: BrokeredEgressDeps, platform: CatalogPlatform, target: CatalogTarget,
  upserts: readonly CatalogPushItem[], deletes: readonly string[],
): Promise<CatalogPushResult> {
  if (!adsCatalogPushEnabled(platform)) return { outcome: 'unsupported', reason: 'not_sandbox_verified' };
  // ADR 0942 D5 — a catalog push publishes the client's product listings (they can
  // show publicly, e.g. Google Shopping free listings, and they feed live shopping
  // ads), so it is class `ads.publish` and passes the ads adapter's ONE spend gate
  // on ads.publish's PendingApproval lane (governance policy, the campaign's frozen
  // autonomy policy, approver rules). The content hash binds the approval to
  // exactly what is sent; no call is made before the gate allows it.
  const contentHash = contentHashOf(JSON.stringify({ platform, upserts, deletes }));
  const where = platform === 'google' ? 'Google Merchant Center' : 'Meta Catalog';
  const gate = await gateCatalogPublish(deps, {
    platform, target: platform === 'meta' ? (target.metaCatalogId ?? '') : (target.merchantAccountId ?? ''), contentHash,
    summary: `Publish ${upserts.length} product listing change(s) and ${deletes.length} removal(s) to ${where}. Listings can appear publicly and feed shopping ads; this starts no ad spend.`,
  });
  if (gate.verdict === 'refused') return { outcome: 'refused', error: gate.error };
  if (gate.verdict === 'requires_approval') return { outcome: 'requires_approval', approvalId: gate.approvalId, ...(gate.autonomy ? { autonomy: true as const } : {}) };
  const r = platform === 'meta' ? await pushMeta(deps, target, upserts, deletes) : await pushGoogle(deps, target, upserts, deletes);
  // ADR 0942 D7 — notify-after, once at least one listing actually changed.
  if (r.outcome === 'pushed' && r.results.some((x) => x.outcome === 'ok')) {
    if (gate.notice) await noticeAfterEffect(deps.tenantId, gate.notice, 'ads.publish', `Pushed ${r.results.filter((x) => x.outcome === 'ok').length} catalog change(s) to ${where}.`);
  }
  return r;
}

async function pushMeta(deps: BrokeredEgressDeps, t: CatalogTarget, upserts: readonly CatalogPushItem[], deletes: readonly string[]): Promise<CatalogPushResult> {
  if (!t.metaCatalogId) return { outcome: 'not_configured', missing: 'metaCatalogId' };
  const results: ItemResult[] = [];
  const ops: Array<{ kind: 'upsert'; item: CatalogPushItem } | { kind: 'delete'; id: string }> = [
    ...upserts.map((item) => ({ kind: 'upsert' as const, item })), ...deletes.map((id) => ({ kind: 'delete' as const, id })),
  ];
  for (let i = 0; i < ops.length; i += META_CATALOG_BATCH_MAX) {
    const chunk = ops.slice(i, i + META_CATALOG_BATCH_MAX);
    const ups = chunk.flatMap((o) => (o.kind === 'upsert' ? [o.item] : []));
    const dels = chunk.flatMap((o) => (o.kind === 'delete' ? [o.id] : []));
    const ids = [...ups.map((u) => ({ id: u.id, op: 'upsert' as const })), ...dels.map((id) => ({ id, op: 'delete' as const }))];
    const r = await brokeredPost(deps, { provider: PROVIDER.meta, url: `${metaApiBase()}/${encodeURIComponent(t.metaCatalogId)}/items_batch`, body: JSON.stringify(buildMetaItemsBatchBody(ups, dels)) });
    if (r.outcome === 'no_connection') return { outcome: 'no_connection' };
    if (r.outcome !== 'sent') { for (const x of ids) results.push({ ...x, outcome: 'failed', error: r.outcome }); continue; }
    let json: { handles?: string[]; validation_status?: Array<{ retailer_id?: string; errors?: Array<{ message?: string }> }>; error?: { message?: string } };
    try { json = (await r.res.json()) as typeof json; } catch { json = {}; }
    if (!r.res.ok || json.error) { for (const x of ids) results.push({ ...x, outcome: 'failed', error: json.error?.message ?? `http_${r.res.status}` }); continue; }
    // A batch is accepted asynchronously (handles); per-item validation errors come back
    // in `validation_status` and fail just those items.
    const bad = new Map((json.validation_status ?? []).filter((v) => v.errors?.length).map((v) => [v.retailer_id ?? '', v.errors?.[0]?.message ?? 'invalid']));
    for (const x of ids) results.push(bad.has(x.id) ? { ...x, outcome: 'failed', error: bad.get(x.id) as string } : { ...x, outcome: 'ok' });
  }
  return { outcome: 'pushed', results };
}

async function pushGoogle(deps: BrokeredEgressDeps, t: CatalogTarget, upserts: readonly CatalogPushItem[], deletes: readonly string[]): Promise<CatalogPushResult> {
  if (!t.merchantAccountId || !t.merchantDataSource) return { outcome: 'not_configured', missing: !t.merchantAccountId ? 'merchantAccountId' : 'merchantDataSource' };
  const results: ItemResult[] = [];
  const parent = `${merchantApiBase()}/accounts/${encodeURIComponent(t.merchantAccountId)}/productInputs`;
  const ds = `dataSource=${encodeURIComponent(t.merchantDataSource)}`;
  for (const item of upserts) {
    const body = buildMerchantProductInput(item, t);
    if (!body) { results.push({ id: item.id, op: 'upsert', outcome: 'failed', error: 'bad_price' }); continue; }
    const r = await brokeredPost(deps, { provider: PROVIDER.google, url: `${parent}:insert?${ds}`, body: JSON.stringify(body) });
    if (r.outcome === 'no_connection') return { outcome: 'no_connection' };
    results.push(await googleOutcome(item.id, 'upsert', r));
  }
  for (const id of deletes) {
    const name = encodeURIComponent(`${t.contentLanguage}~${t.feedLabel}~${id}`);
    const r = await brokeredFetch(deps, { provider: PROVIDER.google, url: `${parent}/${name}?${ds}`, method: 'DELETE' });
    if (r.outcome === 'no_connection') return { outcome: 'no_connection' };
    results.push(await googleOutcome(id, 'delete', r));
  }
  return { outcome: 'pushed', results };
}

type SentOrNot = { outcome: 'sent'; res: Response } | { outcome: string };
async function googleOutcome(id: string, op: 'upsert' | 'delete', r: SentOrNot): Promise<ItemResult> {
  if (r.outcome !== 'sent' || !('res' in r)) return { id, op, outcome: 'failed', error: r.outcome };
  if (r.res.ok) return { id, op, outcome: 'ok' };
  let msg: string | undefined;
  try { msg = ((await r.res.json()) as { error?: { message?: string } }).error?.message; } catch { /* no body */ }
  return { id, op, outcome: 'failed', error: msg ?? `http_${r.res.status}` };
}
