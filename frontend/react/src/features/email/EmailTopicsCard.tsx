/**
 * ADR 0905 D7 — the org's subscription topics (the ASM-group port). A topic is an
 * opt-out list: recipients untick it in the preference centre to stop email about it,
 * and a campaign can target one. Topics only NARROW who is mailed; they never widen
 * consent. The parent owns the list (the campaign form and rows read it too).
 */
import { useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { confirm } from '../../ui/confirm.js';
import { toast } from '../../ui/toast.js';
import { PlusIcon, TrashIcon } from '../../ui/icons/index.js';
import { createTopic, deleteTopic, type EmailTopic } from './emailClient.js';

export function EmailTopicsCard({ orgId, topics, max, onChanged }: { orgId: string; topics: EmailTopic[]; max: number; onChanged: () => void }): JSX.Element {
  const { t } = useTranslation('email');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const atCap = topics.length >= max;

  const add = async (): Promise<void> => {
    if (!name.trim() || atCap) return;
    setBusy(true);
    try { await createTopic(orgId, { name: name.trim() }); setName(''); onChanged(); toast.success(t('topicCreated')); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('createFailed')); }
    finally { setBusy(false); }
  };
  const remove = async (topic: EmailTopic): Promise<void> => {
    if (!(await confirm({ title: t('topicDeleteConfirm', { name: topic.name }), body: t('topicDeleteBody'), danger: true, confirmLabel: t('common:delete') }))) return;
    try { await deleteTopic(orgId, topic.topicId); onChanged(); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('deleteFailed')); }
  };

  return (
    <section className="surface-card u-gap-2" aria-labelledby="email-topics-heading">
      <h2 id="email-topics-heading" className="u-fs-16 u-m-0">{t('topicsHeading')}</h2>
      <p className="muted u-fs-13 u-m-0">{t('topicsLede')}</p>
      {topics.length === 0 ? <p className="muted u-fs-13 u-m-0">{t('topicsEmpty')}</p> : (
        <ul className="u-flex u-gap-1 u-wrap u-m-0 u-p-0 u-list-none">
          {topics.map((topic) => (
            <li key={topic.topicId} className="chip u-flex u-items-center u-gap-1">
              <span>{topic.name}</span>
              <Button variant="quiet" size="sm" aria-label={t('topicDeleteAria', { name: topic.name })} onClick={() => void remove(topic)}><TrashIcon size={12} /></Button>
            </li>
          ))}
        </ul>
      )}
      <div className="u-flex u-gap-2 u-items-end u-wrap">
        <label className="u-grid u-gap-1 u-flex-1"><span className="u-label-sm">{t('topicNameLabel')}</span>
          <input value={name} maxLength={80} disabled={atCap} onChange={(e) => setName(e.target.value)} placeholder={t('topicNamePlaceholder')} />
        </label>
        <Button variant="secondary" disabled={busy || atCap || !name.trim()} onClick={() => void add()}><PlusIcon /> {t('topicAdd')}</Button>
      </div>
      {atCap ? <p className="muted u-fs-12 u-m-0">{t('topicsAtCap', { max })}</p> : null}
    </section>
  );
}
