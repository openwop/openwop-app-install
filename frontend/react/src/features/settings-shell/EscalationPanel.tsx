/**
 * Agent Escalation panel (ADR 0396 P4) — the per-user RFC 0030
 * reasoning-directive STRENGTH override ('off'/'advisory'/'mandatory'; null =
 * follow the host posture). Honest scope: only strength has a backing
 * mechanism; no confidence-threshold control is faked (OQ-4).
 */
import { Button } from '../../ui/Button.js';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice, StateCard } from '../../ui/index.js';
import { toast } from '../../ui/toast.js';
import { getPrefs, putPrefs, type ReasoningDirective } from '../../client/settingsClient.js';

type Choice = ReasoningDirective | 'host';
const CHOICES: Choice[] = ['host', 'off', 'advisory', 'mandatory'];

export function EscalationPanel(): JSX.Element {
  const { t } = useTranslation('settings-shell');
  const [choice, setChoice] = useState<Choice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getPrefs()
      .then((p) => setChoice(p.reasoningDirective ?? 'host'))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const onSelect = async (next: Choice): Promise<void> => {
    // GRADE-UX 2026-07-17 — optimistic update with ROLLBACK: on a save failure
    // the control must show the persisted value, not the wish.
    const prev = choice;
    setChoice(next);
    setBusy(true); setError(null);
    try {
      await putPrefs({ reasoningDirective: next === 'host' ? null : next });
      toast.success(t('escalationSaved'));
    } catch (e) {
      setChoice(prev);
      setError(e instanceof Error ? e.message : t('escalationSaveFailed'));
    } finally { setBusy(false); }
  };

  if (error && choice === null) return <StateCard announce title={t('loadFailed')} body={error} />;
  if (choice === null) return <StateCard loading title={t('loading')} />;

  return (
    <div className="u-grid u-gap-3">
      <p>{t('escalationHint')}</p>
      {error ? <Notice variant="error">{error}</Notice> : null}
      {/* GRADE-UX 2026-07-17 — aria-pressed segmented (the design-system
          pattern A11yPrefsFields uses; `.segmented` styles [aria-pressed]) —
          the role=radio variant had an invisible selected state + no roving
          focus. */}
      <fieldset className="u-grid u-gap-1 u-border-0 u-p-0">
        <legend className="u-label-sm">{t('escalationLabel')}</legend>
        <div className="segmented">
          {CHOICES.map((c) => (
            <Button variant="primary" key={c} aria-pressed={choice === c} disabled={busy} onClick={() => void onSelect(c)}>
              {t(`escalation_${c}`)}
            </Button>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
