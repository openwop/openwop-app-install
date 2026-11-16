/**
 * ADR 1122 P1b — the share-link surface's public-asset provider.
 *
 * A grantor is one link (`share-link:<tokenHash>`). It makes public every asset
 * token its anonymous projection exposes (`publicAssetTokensForLink`), while the
 * link is live. Create, revoke and purge resync it after commit. An expiry, a view
 * cap reached and an edit to the shared resource are caught by the reconcile
 * (≤ 1 h + 60 s): expiry fires no event.
 *
 * The backfill pages the link rows by key, one bounded page per step.
 */
import { registerPublicAssetRefProvider } from '../../host/assetGrants.js';
import { publicAssetTokensForLink, shareLinkPage } from './sharingService.js';

const LINKS_PER_STEP = 200;

export function registerShareLinkAssetGrantProvider(): void {
  registerPublicAssetRefProvider({
    surface: 'share-link',
    tokensFor: (tenantId, tokenHash) => publicAssetTokensForLink(tenantId, tokenHash),
    backfillStep: (cursor) => shareLinkPage(cursor, LINKS_PER_STEP),
  });
}
