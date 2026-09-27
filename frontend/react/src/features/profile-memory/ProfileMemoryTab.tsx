/**
 * Personal Memory tab (ADR 0041) — the human counterpart of the agent Memory
 * tab. A person trains their OWN profile with personal memories (facts,
 * preferences, context) toward a digital twin of themselves, via the shared
 * `MemoryBrowser`. Self-service; durable; private to the signed-in user.
 */

import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useId, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { MemoryBrowser } from '../../memory/MemoryBrowser.js';
import { Notice } from '../../ui/Notice.js';
import { toast } from '../../ui/toast.js';
import { listMemoriesWithRecall, addMemory, deleteMemory } from './profileMemoryClient.js';
import { getExtractionGrant, setExtractionGrant, type ExtractionGrant } from './memoryExtractionClient.js';

export function ProfileMemoryTab(): JSX.Element {
  const { t } = useTranslation('profile-memory');
  /** MEM-UX-1 — rows the assistant recalls that this list does not show.
   *  `undefined` when unknown, so the browser discloses nothing rather than
   *  asserting a zero it did not read. */
  const [recallOnly, setRecallOnly] = useState<number | undefined>(undefined);
  /**
   * ONE request for both halves (review finding F5). A second effect used to
   * re-fetch this exact URL purely for `recallOnlyCount`, which the list response
   * already carries — doubling the request count on this tab, re-running a full
   * memory scan server-side, and allowing the disclosed count to describe a
   * DIFFERENT read than the list on screen.
   *
   * Recording the count here rather than in its own effect also keeps it correct
   * across `MemoryBrowser`'s own `refresh()` after an add or delete, which the
   * mount-once effect never did: the count is now whatever the response that
   * produced the visible list said.
   */
  const list = useCallback(async () => {
    const { notes, recallOnlyCount } = await listMemoriesWithRecall();
    setRecallOnly(recallOnlyCount);
    return notes;
  }, []);
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
        {...(recallOnly !== undefined ? { recallOnlyCount: recallOnly } : {})}
      />
      {/*
        MEM-UX-4 (ADR 0587 §4) — the erasure SCOPE, disclosed.
        `eraseSubjectMemory` resolves the `user:` scope only: a DSAR erases a
        person, never a roster agent's `agent:` recall. That exclusion may well be
        CORRECT (an agent's operational recall is the workspace's, and the ADR 0042
        lesson is that the obvious widening is the dangerous move) — but nothing
        anywhere said so. No erasure receipt, no /consent copy and no Memory-tab
        copy named it, and silence about an exclusion reads as coverage.
        Grading it on the honesty axis: the exclusion stays, the silence goes.
      */}
      <p className="muted u-fs-12 u-m-0">{t('erasureScopeNote')}</p>
    </div>
  );
}

/**
 * ADR 0120 — opt-in consent for auto-learning durable facts from chats. Off by
 * default; learned facts appear as notes in the list below (deletable).
 *
 * Hidden ONLY when the feature is genuinely unavailable — the client returns
 * `null` for exactly one reason, a 404 from an unregistered route
 * (`memoryExtractionClient.getExtractionGrant`), and throws on everything else.
 * That distinction used to be thrown away: a single empty `.catch()` commented
 * "feature unavailable — stay hidden" swallowed 403 ("Sign in to manage memory
 * extraction"), 500 and network failures into the same silent hide.
 *
 * Why that mattered more than an ordinary failed read: this is the control a
 * user comes here to switch OFF. Absent, it reads as "auto-learning isn't
 * running" — while it may well be running and extracting. A privacy control
 * must never be silently missing, and on failure it must not render an
 * UNCHECKED box either, since that asserts an "off" state we did not read.
 */
function ConsentToggle(): JSX.Element | null {
  const { t } = useTranslation('profile-memory');
  const [grant, setGrant] = useState<ExtractionGrant | null>(null);
  const [available, setAvailable] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hid = useId();

  const load = useCallback((): void => {
    setLoadError(null);
    void getExtractionGrant()
      .then((g) => { if (g) { setGrant(g); setAvailable(true); } })
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loadError) {
    return (
      <section className="surface-card u-pad-2 u-flex u-flex-col u-gap-1">
        <strong className="u-fs-13">{t('consentLabel', { defaultValue: 'Automatically learn durable facts from my chats' })}</strong>
        <Notice variant="error">{t('consentLoadFailed', { defaultValue: 'Could not read whether memory-learning is on. It may be ON — this is not confirmation that it is off.' })}</Notice>
        <div>
          <Button variant="quiet" size="sm" onClick={load}>
            {t('consentRetry', { defaultValue: 'Try again' })}
          </Button>
        </div>
      </section>
    );
  }

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
