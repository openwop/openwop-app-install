import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { SelectField } from '../../ui/Field.js';
import { Button } from '../../ui/Button.js';
import { Notice } from '../../ui/Notice.js';
import { listCollections, type KbCollection } from '../kb/kbClient.js';

type Collections = { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; rows: KbCollection[] };

/** Collection choices come only from this brief's client. Failed/missing reads
 * never silently clear its saved binding; removal is an explicit form edit. */
export function BriefKnowledgeField({ orgId, value, onChange }: { orgId: string; value: string; onChange: (id: string) => void }): JSX.Element {
  const { t } = useTranslation('campaign-brief');
  const [collections, setCollections] = useState<Collections>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setCollections({ kind: 'loading' });
    void listCollections(orgId).then((rows) => { if (live) setCollections({ kind: 'ready', rows }); })
      .catch(() => { if (live) setCollections({ kind: 'failed' }); });
    return () => { live = false; };
  }, [orgId, attempt]);
  const rows = collections.kind === 'ready' ? collections.rows : [];
  const unavailable = value !== '' && !rows.some((row) => row.collectionId === value);
  return (
    <div className="u-mb-3">
      <SelectField label={t('fieldKnowledgeCollection')} help={t('knowledgeCollectionHelp')} value={value}
        disabled={collections.kind !== 'ready'} onChange={(event) => onChange(event.target.value)}>
        <option value="">{t('knowledgeCollectionNone')}</option>
        {unavailable ? <option value={value} disabled>{t(collections.kind === 'ready' ? 'knowledgeCollectionUnavailable' : 'knowledgeCollectionUnverified')}</option> : null}
        {rows.map((row) => <option key={row.collectionId} value={row.collectionId}>{row.name}</option>)}
      </SelectField>
      {collections.kind === 'loading' ? <p className="muted u-fs-13" role="status">{t('knowledgeCollectionsLoading')}</p> : null}
      {collections.kind === 'failed' ? (
        <Notice variant="warning" announce={t('knowledgeCollectionsFailed')}>
          {t('knowledgeCollectionsFailed')}{' '}
          <Button variant="link" onClick={() => setAttempt((current) => current + 1)}>{t('knowledgeCollectionsRetry')}</Button>
        </Notice>
      ) : null}
      {collections.kind === 'ready' && unavailable ? <p className="muted u-fs-13">{t('knowledgeCollectionMissing')}</p> : null}
      {collections.kind === 'ready' && rows.length === 0 ? <p className="muted u-fs-13">{t('knowledgeCollectionsEmpty')}</p> : null}
      <div className="u-flex u-gap-2 u-items-center u-wrap">
        <Link to={`/kb?org=${encodeURIComponent(orgId)}${value ? `&collection=${encodeURIComponent(value)}` : ''}`}>{t('knowledgeCollectionsManage')}</Link>
        {value ? <Button variant="link" onClick={() => onChange('')}>{t('knowledgeCollectionClear')}</Button> : null}
      </div>
    </div>
  );
}
