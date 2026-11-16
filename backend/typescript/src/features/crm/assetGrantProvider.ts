/**
 * ADR 1122 P1b — the e-sign surface's public-asset provider.
 *
 * A signer opens their request anonymously through a signing token
 * (`GET /sign/:token`), which renders the target. A document target is its pinned
 * version's markdown, and pictures sit in it as asset URLs. A grantor
 * (`esign:<signRequestId>`) therefore makes public:
 *  - the asset tokens in the rendered target, while the request is not voided or
 *    declined. A completed request stays viewable, so it keeps them;
 *  - the certificate once completed (`certificateArtifactId`), which is also emailed
 *    to the signers.
 * Void and decline are hooked revocations (`casSignRequest`). Sign requests do not
 * expire.
 *
 * The backfill pages the sign-request rows by key, one bounded page per step.
 */
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import { registerPublicAssetRefProvider } from '../../host/assetGrants.js';
import { assetTokensInText } from '../../host/assetServePath.js';
import { getSignRequestById } from './entities/signRequests.js';
import { renderTarget } from './signTargets.js';

const ROWS_PREFIX = 'hostext:crm:sign-request:';
const ROWS_PER_STEP = 200;

export function registerEsignAssetGrantProvider(): void {
  registerPublicAssetRefProvider({
    surface: 'esign',
    async tokensFor(tenantId, signRequestId) {
      const req = await getSignRequestById(signRequestId);
      if (!req || req.tenantId !== tenantId) return [];
      if (req.status === 'voided' || req.status === 'declined') return [];
      const out = new Set<string>();
      if (req.target.kind === 'document') {
        const rendered = await renderTarget(req.tenantId, req.orgId, req.target);
        for (const t of assetTokensInText(rendered.markdown)) out.add(t);
      }
      if (req.status === 'completed' && req.certificateArtifactId) out.add(req.certificateArtifactId);
      return [...out];
    },
    async backfillStep(cursor) {
      const storage = hostExtStorage();
      const rows = storage.kvListPage
        ? await storage.kvListPage(ROWS_PREFIX, { ...(cursor ? { after: cursor } : {}), limit: ROWS_PER_STEP })
        : (await storage.kvList(ROWS_PREFIX)).filter((r) => !cursor || r.key > cursor).slice(0, ROWS_PER_STEP);
      const items: Array<{ tenantId: string; id: string }> = [];
      for (const { value } of rows) {
        let row: { tenantId?: unknown; signRequestId?: unknown };
        try { row = JSON.parse(value) as typeof row; } catch { continue; }
        if (typeof row.tenantId === 'string' && typeof row.signRequestId === 'string') items.push({ tenantId: row.tenantId, id: row.signRequestId });
      }
      const last = rows[rows.length - 1]?.key;
      return { items, ...(rows.length >= ROWS_PER_STEP && last ? { next: last } : {}) };
    },
  });
}
