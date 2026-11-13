/**
 * CC-OPS-1 — register one of the client org's CMS pages as an asset, so change
 * requests can include it. The page list and every editable field path come from
 * the server (`GET …/clients/:orgId/asset-candidates`, the same field paths the
 * CMS adapter reads and `addAsset` validates), so the UI never guesses a path.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { CheckboxField, SelectField, TextField } from '../../ui/Field.js';
import { Modal } from '../../ui/Modal.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { addPageAsset, listPageCandidates, CampaignOpsError, type PageCandidate } from './campaignOpsClient.js';

export function AddPageDialog({ orgId, onClose, onAdded }: {
  orgId: string; onClose: () => void; onAdded: () => void;
}): JSX.Element {
  const { t } = useTranslation('campaign-ops');
  const [pages, setPages] = useState<PageCandidate[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [pageId, setPageId] = useState('');
  const [label, setLabel] = useState('');
  const [fields, setFields] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setFailed(false); setPages(null);
    listPageCandidates(orgId)
      .then((p) => { if (live) setPages(p.filter((c) => !c.registered)); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [orgId, attempt]);

  const selected = pages?.find((p) => p.pageId === pageId);
  const choose = (id: string): void => {
    const p = pages?.find((c) => c.pageId === id);
    setPageId(id);
    setLabel(p?.title ?? '');
    setFields(new Set(p && p.fields.some((f) => f.path === 'title') ? ['title'] : []));
    setError(null);
  };
  const submit = async (): Promise<void> => {
    if (!selected || fields.size === 0 || !label.trim()) return;
    setBusy(true); setError(null);
    try {
      await addPageAsset(orgId, { pageId: selected.pageId, label: label.trim(), editableFields: [...fields] });
      onAdded();
      onClose();
    } catch (e) {
      setError(e instanceof CampaignOpsError && e.message ? e.message : t('actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  return <Modal label={t('addPageTitle')} onClose={onClose} showClose>
    <div className="u-grid u-gap-4">
      <p>{t('addPageHelp')}</p>
      {failed ? <StateCard announce title={t('loadFailedTitle')} body={t('addPageLoadFailed')}
        action={<Button onClick={() => setAttempt((n) => n + 1)}>{t('retry')}</Button>} />
      : !pages ? <StateCard loading title={t('loading')} />
      : pages.length === 0 ? <StateCard title={t('addPageNone')} body={t('addPageNoneHelp')} />
      : <>
        <SelectField label={t('addPagePage')} value={pageId} onChange={(e) => choose(e.target.value)}>
          <option value="">{t('addPageChoose')}</option>
          {pages.map((p) => <option key={p.pageId} value={p.pageId}>{p.title}</option>)}
        </SelectField>
        {selected ? <>
          <TextField label={t('addPageLabel')} value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} />
          <fieldset className="u-fieldset-bare u-grid u-gap-1">
            <legend className="field-label">{t('addPageFields')}</legend>
            <p className="u-text-muted u-fs-13 u-m-0">{t('addPageFieldsHelp')}</p>
            <ul className="u-list-plain u-grid u-gap-1 u-m-0">
              {selected.fields.map((f) => (
                <li key={f.path}>
                  <CheckboxField
                    label={f.path === 'title' ? t('addPageFieldTitle') : f.preview || f.path}
                    help={f.path === 'title' ? f.preview : f.path}
                    checked={fields.has(f.path)}
                    onChange={(e) => {
                      const on = e.target.checked;
                      setFields((cur) => { const n = new Set(cur); if (on) n.add(f.path); else n.delete(f.path); return n; });
                    }}
                  />
                </li>
              ))}
            </ul>
          </fieldset>
        </> : null}
        {error ? <Notice variant="error" announce={error}>{error}</Notice> : null}
        <div className="action-bar">
          <Button variant="primary" disabled={!selected || fields.size === 0 || !label.trim() || busy} onClick={() => void submit()}>{t('addPageSubmit')}</Button>
          <Button onClick={onClose}>{t('common:cancel')}</Button>
        </div>
      </>}
    </div>
  </Modal>;
}
