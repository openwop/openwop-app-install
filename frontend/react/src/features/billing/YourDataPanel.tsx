/**
 * ADR 0820 §7 — Billing's "Your data": the features this workspace can export
 * through the portability door, each with a download. Admin/owner only (Billing
 * renders it for a billing manager; the read refuses anyone else). Lazy chunk;
 * strings in the lazy `billing` namespace.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { toast } from '../../ui/toast.js';
import { downloadFeatureExport, listExportableFeatures, type ExportableFeature } from './dataExportClient.js';

export function YourDataPanel(): JSX.Element {
  const { t } = useTranslation('billing');
  const [list, setList] = useState<ExportableFeature[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void listExportableFeatures()
      .then((l) => { if (live) setList(l); })
      .catch(() => { if (live) { setList([]); setFailed(true); } });
    return () => { live = false; };
  }, []);
  return (
    <section className="surface-card u-p-4 u-grid u-gap-3" aria-labelledby="your-data-title">
      <div className="u-grid u-gap-1">
        <h2 id="your-data-title" className="u-m-0">{t('dataExportTitle')}</h2>
        <p className="u-m-0 muted u-text-sm">{t('dataExportLede')}</p>
      </div>
      {list === null ? <Skeleton /> : failed ? (
        <p className="u-m-0 muted">{t('dataExportListFailed')}</p>
      ) : list.length === 0 ? (
        <p className="u-m-0 muted">{t('dataExportNone')}</p>
      ) : (
        <ul className="u-grid u-gap-2 u-m-0 u-p-0 u-list-none">
          {list.map((f) => (
            <li key={f.featureId} className="u-flex u-flex-wrap u-gap-2 u-items-center">
              <span>{f.label}</span>
              {f.access === 'plan-lapsed' ? <span className="chip chip--muted">{t('dataExportPaused')}</span> : null}
              <Button
                variant="secondary" size="sm" disabled={busy !== null}
                aria-label={t('dataExportActionAria', { feature: f.label })}
                onClick={() => {
                  setBusy(f.featureId);
                  void downloadFeatureExport(f.featureId)
                    .catch(() => { toast.error(t('dataExportFailed')); })
                    .finally(() => setBusy(null));
                }}
              >{busy === f.featureId ? t('dataExportBusy') : t('dataExportAction')}</Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
