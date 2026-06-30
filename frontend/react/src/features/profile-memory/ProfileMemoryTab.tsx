/**
 * Personal Memory tab (ADR 0041) — the human counterpart of the agent Memory
 * tab. A person trains their OWN profile with personal memories (facts,
 * preferences, context) toward a digital twin of themselves, via the shared
 * `MemoryBrowser`. Self-service; durable; private to the signed-in user.
 */

import { useCallback, useEffect, useId, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { MemoryBrowser } from '../../memory/MemoryBrowser.js';
import { toast } from '../../ui/toast.js';
import { listMemories, addMemory, deleteMemory } from './profileMemoryClient.js';
import { getExtractionGrant, setExtractionGrant, type ExtractionGrant } from './memoryExtractionClient.js';

export function ProfileMemoryTab(): JSX.Element {
  const { t } = useTranslation('profile-memory');
  const list = useCallback(() => listMemories(), []);
  const add = useCallback((content: string) => addMemory(content), []);
  const remove = useCallback((id: string) => deleteMemory(id), []);

  return (
    <div className="u-flex u-flex-col u-gap-3">
      <p className="muted u-fs-13 u-m-0">
        <Trans i18nKey="memoryIntro" ns="profile-memory" components={{ 0: <strong /> }} />
      </p>
      <ConsentToggle />
      <MemoryBrowser
        list={list}
        add={add}
        remove={remove}
        addPlaceholder={t('memoryAddPlaceholder')}
        emptyBody={t('memoryEmptyBody')}
      />
    </div>
  );
}

/**
 * ADR 0120 — opt-in consent for auto-learning durable facts from chats. Hidden
 * entirely when the feature is unavailable (grant fetch returns null on 404).
 * Off by default; learned facts appear as notes in the list below (deletable).
 */
function ConsentToggle(): JSX.Element | null {
  const { t } = useTranslation('profile-memory');
  const [grant, setGrant] = useState<ExtractionGrant | null>(null);
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const hid = useId();

  useEffect(() => {
    void getExtractionGrant().then((g) => { if (g) { setGrant(g); setAvailable(true); } }).catch(() => { /* feature unavailable — stay hidden */ });
  }, []);

  if (!available) return null;

  const onToggle = (next: boolean): void => {
    setBusy(true);
    void setExtractionGrant(next)
      .then((g) => setGrant(g))
      .catch(() => toast.error(t('consentError', { defaultValue: 'Could not update the memory-learning setting.' })))
      .finally(() => setBusy(false));
  };

  return (
    <section className="surface-card u-pad-2 u-flex u-flex-col u-gap-1" aria-labelledby={hid}>
      <label className="u-flex u-items-center u-gap-2 u-fs-13 u-fw-600">
        <input type="checkbox" checked={grant?.granted === true} disabled={busy} onChange={(e) => onToggle(e.target.checked)} />
        <span id={hid}>{t('consentLabel', { defaultValue: 'Automatically learn durable facts from my chats' })}</span>
      </label>
      <p className="muted u-fs-12 u-m-0">{t('consentHint', { defaultValue: 'When on, your assistant may save lasting facts it learns during chats as memories below — which you can review and delete anytime. Off by default.' })}</p>
    </section>
  );
}
