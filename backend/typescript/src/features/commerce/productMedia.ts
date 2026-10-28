/**
 * ADR 0945 D1 — resolve a catalog product's own imagery to org-checked media.
 *
 * `Product.imageAssetTokens` are media serve tokens that commerce never
 * validated (`cleanTokens` accepts any non-empty string). Grounded creative may
 * depict a product ONLY from these sources, so every token must resolve to a
 * media library asset in the PRODUCT's org; one that does not — unknown, deleted,
 * or another org's — refuses the whole product with `product_media_unresolved`
 * rather than silently dropping it (a partial source set is a different
 * product). The storefront is unchanged: it still serves the raw tokens.
 *
 * Commerce → media is a READ (media never imports commerce); media is
 * always-on (ADR 0027), so there is no source-feature gate to ask (ADR 0820 G11).
 */
import { createHash } from 'node:crypto';
import { OpenwopError } from '../../types.js';
import { featureAccessRefusal } from '../../host/workflowFeatureGate.js';
import { resolveMediaAsset } from '../../host/inMemorySurfaces.js';
import { getAssetByServeToken, parseServeToken, type ShotRole } from '../media/mediaService.js';
import { getProduct } from './commerceService.js';

/** One allowed depiction source of a product (ADR 0945 D1). */
export interface ProductSource {
  assetId: string;
  serveToken: string;
  /** SHA-256 of the stored bytes — the identity a fidelity check and the
   *  grounding stamp pin, so the audit survives the asset's deletion. */
  sha256: string;
  role: ShotRole;
}

export async function resolveProductMedia(input: { tenantId: string; orgId: string; productId: string }): Promise<ProductSource[]> {
  const product = await getProduct(input.tenantId, input.orgId, input.productId);
  if (!product) throw new OpenwopError('not_found', 'Product not found.', 404, { productId: input.productId });
  const out: ProductSource[] = [];
  for (const [index, raw] of product.imageAssetTokens.entries()) {
    const token = parseServeToken(raw);
    // The product's org, not the caller's — the two are equal here (getProduct
    // org-checked), and that equality is the D1 rule.
    const asset = token ? await getAssetByServeToken(input.tenantId, product.orgId, token) : null;
    if (!asset || !token) {
      // One refusal for unknown, deleted and foreign: no existence leak.
      throw new OpenwopError('product_media_unresolved', `Product image ${index + 1} is not a media asset in this product's workspace — re-attach it from the Media Library.`, 422, { productId: product.productId, index });
    }
    let sha256 = asset.contentHash;
    if (!sha256) {
      // Rows uploaded before ADR 0352 P2 carry no hash: hash the bytes.
      const entry = await resolveMediaAsset(asset.serveToken);
      if (!entry || entry.tenantId !== input.tenantId) {
        throw new OpenwopError('product_media_unresolved', `Product image ${index + 1} has no stored bytes.`, 422, { productId: product.productId, index });
      }
      sha256 = createHash('sha256').update(Buffer.from(entry.contentBase64, 'base64')).digest('hex');
    }
    const role: ShotRole = asset.marketing?.shotRole ?? (index === 0 ? 'hero' : 'angle');
    out.push({ assetId: asset.assetId, serveToken: asset.serveToken, sha256, role });
  }
  return out;
}

/** ADR 0945 P2 — the catalog's answer to media's product-hint check: are these
 *  bytes one of this product's photos (in the product's own org)? */
export async function isProductSource(tenantId: string, orgId: string, productId: string, sourceSha256: string): Promise<boolean> {
  // ADR 0820 §7 / G11 — reading the catalog asks the catalog's feature first.
  if (await featureAccessRefusal('commerce', tenantId)) return false;
  const sources = await resolveProductMedia({ tenantId, orgId, productId }).catch(() => [] as ProductSource[]);
  return sources.some((s) => s.sha256 === sourceSha256);
}
