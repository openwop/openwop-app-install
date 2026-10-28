/**
 * ADR 0945 D5 — the ONE publish-edge gate for creative that leaves the tenant.
 * Called by `adsAdapter.publishAd` and the campaign-ops CMS destination
 * adapter (ADR 0922 D2); the social adapter (ADR 0953) calls it when it ships.
 *
 * It refuses, in order:
 *  - `fidelity_unverified` for AI bytes that are not a library asset (nothing
 *    to check them against — store them in the Media Library first);
 *  - `product_depiction_ungrounded` for AI imagery bound to a product with no
 *    grounding sources;
 *  - `fidelity_unverified` for product-depicting AI with no verdict, a `fail`
 *    verdict, or a verdict store that cannot be read (fail closed);
 *  - `fidelity_needs_review` unless a registered review-approval check says a
 *    person approved THIS asset at THIS verdict (none registered ⇒ refuse);
 *  - `disclosure_unsupported` when the destination needs a platform AI flag no
 *    adapter here can set yet (`disclosureRules.ts`).
 * Content with no AI provenance passes untouched — this gate changes nothing
 * for existing non-AI creative.
 *
 * Lives in `host/` (not `host/creativeFidelity/`, which stays free of feature
 * imports) because it must read media. The verdict is read from the STORE,
 * never from the asset's cached `grounding.fidelity` summary.
 */
import { getAssetByIdForTenant, getAssetByServeTokenForTenant, parseServeToken, type MediaAsset } from '../features/media/mediaService.js';
import { resolveMediaAsset } from './inMemorySurfaces.js';
import { getVerdict } from './creativeFidelity/verdictStore.js';
import { FIDELITY_RULESET_VERSION } from './creativeFidelity/rules.js';
import { disclosureFor, type AiDisclosure, type DisclosureDestination } from './creativeFidelity/disclosureRules.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.creativePublishGate');

export type CreativePublishRefusal = 'product_depiction_ungrounded' | 'fidelity_unverified' | 'fidelity_needs_review' | 'disclosure_unsupported';

export type CreativePublishDecision =
  | { ok: true; disclosure: AiDisclosure; assetId?: string }
  | { ok: false; code: CreativePublishRefusal; message: string; assetId?: string };

/** ADR 0945 D5 — "did a person approve publishing this asset at this verdict?"
 *  Filled by the approvals owner (ADR 0942 / ADR 0947) with a binding on a
 *  content hash of `{assetId, verdictId}`. Unregistered ⇒ nothing is approved. */
export type CreativeReviewApprovalCheck = (input: { tenantId: string; orgId: string; assetId: string; verdictId: string }) => Promise<boolean>;
let reviewApprovalCheck: CreativeReviewApprovalCheck | null = null;
export function registerCreativeReviewApproval(fn: CreativeReviewApprovalCheck | null): void { reviewApprovalCheck = fn; }

/** Destinations whose adapter can set a platform AI flag. None today. */
const PLATFORM_FLAG_CAPABLE: ReadonlySet<DisclosureDestination> = new Set();

export async function assertCreativePublishable(input: {
  tenantId: string;
  /** A media asset id, a serve token or a serve URL — whatever the caller holds. */
  mediaRef: string;
  destination: DisclosureDestination;
  context?: { political?: boolean };
}): Promise<CreativePublishDecision> {
  const { tenantId, destination } = input;
  const political = input.context?.political === true;
  let asset: MediaAsset | null;
  try {
    asset = await getAssetByIdForTenant(tenantId, input.mediaRef);
    const token = asset ? asset.serveToken : parseServeToken(input.mediaRef);
    if (!asset && token) asset = await getAssetByServeTokenForTenant(tenantId, token);
    if (!asset) {
      // Not a library asset. Bytes the AI adapter minted have no record to be
      // checked against; anything else is outside this gate (unchanged).
      const entry = token ? await resolveMediaAsset(token) : null;
      if (entry && (entry.tenantId !== tenantId || entry.aiOrigin)) {
        return refuse('fidelity_unverified', 'This is AI-generated media that is not in the Media Library, so it cannot be checked. Save it to the library first.');
      }
      return { ok: true, disclosure: disclosureFor({ destination, ai: false, edited: false, political }) };
    }
  } catch (err) {
    log.warn('creative_publish_gate_media_unreadable', { error: err instanceof Error ? err.message : String(err) });
    return refuse('fidelity_unverified', 'The media provenance could not be checked, so publishing is held back. Try again shortly.');
  }

  const g = asset.lineage?.grounding;
  const ai = asset.lineage?.generatedBy === 'ai' || !!g;
  const productId = asset.marketing?.productId ?? g?.productId;
  if (ai && productId) {
    if (!g || g.productId !== productId || g.sources.length === 0) {
      return refuse('product_depiction_ungrounded', 'This AI image shows a catalog product but was not made from the product\'s own photos.', asset.assetId);
    }
    const summary = g.fidelity;
    if (!summary) return refuse('fidelity_unverified', 'This AI image shows a product and has not been checked against the product\'s photos.', asset.assetId);
    let verdict;
    try {
      verdict = await getVerdict(tenantId, asset.orgId, summary.verdictId);
    } catch (err) {
      log.warn('creative_publish_gate_verdict_unreadable', { assetId: asset.assetId, error: err instanceof Error ? err.message : String(err) });
      return refuse('fidelity_unverified', 'The fidelity record could not be read, so this image is held back. Try again shortly.', asset.assetId);
    }
    const sourcesKey = (sources: readonly { assetId: string; sha256: string }[]): string =>
      JSON.stringify(sources.map((s) => JSON.stringify([s.assetId, s.sha256])).sort());
    if (!verdict || verdict.assetId !== asset.assetId || !asset.contentHash || verdict.assetSha256 !== asset.contentHash
      || verdict.productId !== productId || verdict.mode !== g.mode || verdict.rulesetVersion !== FIDELITY_RULESET_VERSION
      || sourcesKey(verdict.sources) !== sourcesKey(g.sources) || !['pass', 'needs_review'].includes(verdict.outcome)) {
      return refuse('fidelity_unverified', 'This AI image did not pass its check against the product\'s photos.', asset.assetId);
    }
    if (verdict.outcome === 'needs_review') {
      const approved = reviewApprovalCheck
        ? await reviewApprovalCheck({ tenantId, orgId: asset.orgId, assetId: asset.assetId, verdictId: verdict.verdictId }).catch(() => false)
        : false;
      if (!approved) return refuse('fidelity_needs_review', 'This AI image needs a reviewer to approve it before it can be published.', asset.assetId);
    }
  }

  const disclosure = disclosureFor({ destination, ai, edited: g?.mode === 'edit', political });
  if (disclosure.required && disclosure.mechanism === 'platform-flag' && !PLATFORM_FLAG_CAPABLE.has(destination)) {
    return refuse('disclosure_unsupported', 'This destination requires an AI-content label that cannot be set from here yet, so AI media cannot be published to it.', asset.assetId);
  }
  return { ok: true, disclosure, assetId: asset.assetId };
}

function refuse(code: CreativePublishRefusal, message: string, assetId?: string): CreativePublishDecision {
  return { ok: false, code, message, ...(assetId ? { assetId } : {}) };
}
