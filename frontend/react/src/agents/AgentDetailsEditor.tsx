/**
 * AgentDetailsEditor — the "Edit agent" dialog opened from the agent workspace
 * header. Edits the core identity + operating fields that aren't already owned
 * by a dedicated tab: name (persona), title (label), role description, heartbeat
 * cadence, and heartbeat autonomy. Saves them in ONE roster PATCH
 * (`updateRosterEntry`). The system prompt, governance profile, workflows, and
 * schedules keep their own dedicated tabs — this dialog deliberately does not
 * duplicate them.
 *
 * Modal chrome (scrim + Esc + focus-trap-and-restore) comes from the shared
 * <Modal>; form wiring (label↔control, aria) from the <Field> primitives.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../ui/Modal.js';
import { TextField, TextareaField, SelectField } from '../ui/Field.js';
import { updateRosterEntry, type RosterEntry } from './rosterClient.js';

/** Heartbeat cadence presets (ms). 0 ⇒ manual-only (no autonomous heartbeat). */
const HEARTBEAT_PRESETS: ReadonlyArray<{ ms: number; labelKey: string }> = [
  { ms: 0, labelKey: 'editHbManual' },
  { ms: 15 * 60_000, labelKey: 'editHb15m' },
  { ms: 30 * 60_000, labelKey: 'editHb30m' },
  { ms: 60 * 60_000, labelKey: 'editHb1h' },
  { ms: 2 * 60 * 60_000, labelKey: 'editHb2h' },
  { ms: 4 * 60 * 60_000, labelKey: 'editHb4h' },
  { ms: 24 * 60 * 60_000, labelKey: 'editHb24h' },
];

/** Roster heartbeat-autonomy levels, in escalating-trust order. The roster
 *  value → human label mirrors the dashboard meter (review = Supervised). */
const AUTONOMY_OPTIONS: ReadonlyArray<{ value: 'review' | 'guided' | 'auto'; labelKey: string }> = [
  { value: 'review', labelKey: 'autonomySupervised' },
  { value: 'guided', labelKey: 'autonomyGuided' },
  { value: 'auto', labelKey: 'autonomyAutonomous' },
];

export function AgentDetailsEditor({
  entry,
  onSaved,
  onClose,
}: {
  entry: RosterEntry;
  /** Called after a successful save (parent refreshes + shows a notice). */
  onSaved: () => void;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation('agents');
  const [persona, setPersona] = useState(entry.persona);
  const [label, setLabel] = useState(entry.label ?? '');
  const [description, setDescription] = useState(entry.description ?? '');
  const [heartbeatMs, setHeartbeatMs] = useState<number>(entry.heartbeatIntervalMs ?? 0);
  const [autonomy, setAutonomy] = useState<'review' | 'guided' | 'auto'>(entry.autonomyLevel ?? 'auto');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameEmpty = persona.trim().length === 0;

  // The current cadence may be a custom value the wizard set that isn't one of
  // the presets — surface it as its own option so saving doesn't silently snap
  // it to the nearest preset.
  const presetMatches = HEARTBEAT_PRESETS.some((p) => p.ms === heartbeatMs);

  const onSave = async (): Promise<void> => {
    if (nameEmpty) { setError(t('editNameRequired')); return; }
    setSaving(true);
    setError(null);
    try {
      const trimmedLabel = label.trim();
      await updateRosterEntry(entry.rosterId, {
        persona: persona.trim(),
        // Empty title falls back to the generic "agent" label, so only send a
        // non-empty title — a cleared field is left unchanged rather than
        // persisted as an empty string.
        ...(trimmedLabel ? { label: trimmedLabel } : {}),
        description: description.trim(),
        heartbeatIntervalMs: heartbeatMs,
        autonomyLevel: autonomy,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  return (
    <Modal
      onClose={onClose}
      label={t('editDetailsTitle', { persona: entry.persona })}
      className="surface-card hire-modal"
      error={error}
    >
      <h2 className="u-m-0 u-fs-16">{t('editDetailsTitle', { persona: entry.persona })}</h2>
      <p className="muted u-fs-13 u-mt-1">{t('editDetailsLede')}</p>

      <div className="u-flex u-flex-col u-gap-3 u-mt-3">
        <TextField
          label={t('editName')}
          required
          value={persona}
          maxLength={80}
          onChange={(e) => setPersona(e.target.value)}
          error={nameEmpty ? t('editNameRequired') : undefined}
          autoComplete="off"
        />
        <TextField
          label={t('editTitle')}
          help={t('editTitleHelp')}
          value={label}
          maxLength={120}
          placeholder={t('editTitlePlaceholder')}
          onChange={(e) => setLabel(e.target.value)}
          autoComplete="off"
        />
        <TextareaField
          label={t('editDescription')}
          help={t('editDescriptionHelp')}
          value={description}
          rows={3}
          maxLength={600}
          placeholder={t('editDescriptionPlaceholder', { persona: entry.persona })}
          onChange={(e) => setDescription(e.target.value)}
        />
        <SelectField
          label={t('editHeartbeat')}
          help={t('editHeartbeatHelp')}
          value={String(heartbeatMs)}
          onChange={(e) => setHeartbeatMs(Number(e.target.value))}
        >
          {!presetMatches ? <option value={String(heartbeatMs)}>{t('editHbCustom')}</option> : null}
          {HEARTBEAT_PRESETS.map((p) => (
            <option key={p.ms} value={String(p.ms)}>{t(p.labelKey)}</option>
          ))}
        </SelectField>
        <SelectField
          label={t('editAutonomy')}
          help={t('editAutonomyHelp')}
          value={autonomy}
          onChange={(e) => setAutonomy(e.target.value as 'review' | 'guided' | 'auto')}
        >
          {AUTONOMY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{t(o.labelKey)}</option>
          ))}
        </SelectField>
      </div>

      <div className="u-flex u-gap-2 u-mt-4 u-justify-end">
        <button type="button" className="secondary" onClick={onClose} disabled={saving}>{t('newCancel')}</button>
        <button type="button" className="primary" onClick={() => void onSave()} disabled={saving || nameEmpty}>
          {saving ? t('editSaving') : t('editSave')}
        </button>
      </div>
    </Modal>
  );
}
