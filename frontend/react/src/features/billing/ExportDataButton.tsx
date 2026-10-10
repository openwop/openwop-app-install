/**
 * ADR 0820 §7 — "Export your data" on the locked-feature page. Rendered (lazily)
 * by `featureToggles/LockedState`, which only renders for a PLAN lock (toggle on,
 * not entitled). Shown only to a billing manager (admin/owner — the door's own
 * `host:billing:manage` authz) and only when the door lists this feature as
 * exportable for the workspace; otherwise renders nothing.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { toast } from '../../ui/toast.js';
import { useScopeWriteAccess } from '../../lib/writeAccess.js';
import { BILLING_MANAGE_SCOPE } from './billingClient.js';
import { downloadFeatureExport, listExportableFeatures } from './dataExportClient.js';

export function ExportDataButton({ featureId }: { featureId: string }): JSX.Element | null {
  const { t } = useTranslation('billing');
  const canManage = useScopeWriteAccess(BILLING_MANAGE_SCOPE);
  const [exportable, setExportable] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!canManage) { setExportable(false); return; }
    let live = true;
    void listExportableFeatures()
      .then((list) => { if (live) setExportable(list.some((f) => f.featureId === featureId && f.access === 'plan-lapsed')); })
      .catch(() => { if (live) setExportable(false); });
    return () => { live = false; };
  }, [canManage, featureId]);
  if (!canManage || !exportable) return null;
  return (
    <div className="u-flex u-flex-wrap u-gap-2 u-items-center">
      <span className="u-text-sm muted">{t('dataExportLockedHint')}</span>
      <Button
        variant="secondary" size="sm" disabled={busy}
        onClick={() => {
          setBusy(true);
          void downloadFeatureExport(featureId)
            .catch(() => { toast.error(t('dataExportFailed')); })
            .finally(() => setBusy(false));
        }}
      >{busy ? t('dataExportBusy') : t('dataExportAction')}</Button>
    </div>
  );
}
