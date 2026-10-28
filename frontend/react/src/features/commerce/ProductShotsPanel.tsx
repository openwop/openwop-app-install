/**
 * ADR 0945 P5 — the Product shots panel: the product's own photos, grouped by
 * shot role, which are the ONLY images product-grounded creative may depict.
 * A photo that no longer resolves to the media library in this workspace is an
 * honest error naming what to fix (the server refuses it as a source too).
 * Loaded lazily from the product editor.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../../ui/Notice.js';
import { config } from '../../client/config.js';
import { getProductMedia, type ProductSourceView } from './commerceClient.js';

const ROLES: ProductSourceView['role'][] = ['hero', 'angle', 'detail', 'packaging', 'label', 'lifestyle'];
const abs = (u: string): string => (u.startsWith('http') ? u : `${config.baseUrl}${u}`);

export default function ProductShotsPanel({ orgId, productId }: { orgId: string; productId: string }): JSX.Element {
  const { t } = useTranslation('commerce');
  const [sources, setSources] = useState<ProductSourceView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    getProductMedia(orgId, productId)
      .then((s) => { if (live) setSources(s); })
      // The fallback copy is resolved at render: `t` must not be an effect
      // dependency (a fresh `t` per render would refetch in a loop).
      .catch((e: unknown) => { if (live) setError(e instanceof Error && e.message ? e.message : ''); });
    return () => { live = false; };
  }, [orgId, productId]);

  return (
    <section className="u-grid u-gap-2" aria-labelledby="product-shots-h">
      <h3 id="product-shots-h" className="u-fs-14">{t('productShotsTitle')}</h3>
      <p className="u-fs-13 u-text-muted">{t('productShotsHelp')}</p>
      {error !== null ? <Notice variant="warning" announce={error || t('productShotsError')}>{error || t('productShotsError')}</Notice> : null}
      {sources && sources.length === 0 ? <Notice variant="info">{t('productShotsEmpty')}</Notice> : null}
      {sources && sources.length > 0 ? (
        <div className="card-grid">
          {ROLES.flatMap((role) => sources.filter((s) => s.role === role).map((s) => (
            <figure key={s.assetId} className="surface-card u-p-2 u-gap-1">
              <div className="media-thumb"><img src={abs(s.serveUrl)} alt="" className="media-thumb-img" /></div>
              <figcaption><span className="chip">{t(`shotRole_${role}`)}</span></figcaption>
            </figure>
          )))}
        </div>
      ) : null}
    </section>
  );
}
