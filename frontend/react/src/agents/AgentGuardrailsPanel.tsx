/**
 * Agent guardrails panel (ADR 0101) — the slimmed successor to the old Profile
 * tab. Folded into the Instructions tab as a "Guardrails" section (and reused in
 * the admin Roster modal). Surfaces ONLY the `agentProfile` fields that are
 * enforced or actively being wired up:
 *
 *   - `permissions` {read, write, never}  — `never` is hard-enforced today;
 *     read/write enforce per-tool once Phase 4 lands (RFC 0064 / toolHooks).
 *   - `hitl` + `escalation`               — hitl forces approval; escalation
 *     notifies contacts when a proposal is queued (Phase 2).
 *   - `requiredConnections`               — gates autonomy (ADR 0033).
 *   - `autonomy.withinPolicyActions`      — the auto-mode allowlist (shown only
 *     when the agent runs at `auto`).
 *   - `metrics`                            — surfaced on Overview (Phase 3).
 *
 * Autonomy itself is NOT edited here — `roster.autonomyLevel` is the single
 * source of truth (the Edit-details modal owns it, the heartbeat reads it). This
 * panel only shows the current level and the `auto` allowlist. The removed
 * fields (channels / adminControls / riskCompliance) are dropped; the loaded
 * `configParameters` is carried through on save so its functional `.compaction`
 * key (per-agent tool-output compaction) is never silently wiped.
 *
 * NON-NORMATIVE host-local product config under `/v1/host/openwop-app/*`.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getAgentProfile,
  putAgentProfile,
  type AgentProfile,
  type AgentProfileInput,
  type AgentRosterLevel,
  type AgentSpecLevel,
} from './rosterClient.js';
import { Notice } from '../ui/Notice.js';
import { StateCard } from '../ui/StateCard.js';
import { Field } from '../ui/Field.js';
import { ShieldIcon, ZapIcon, LifeBuoyIcon, PlugIcon, ActivityIcon } from '../ui/icons/index.js';

/** roster level → spec level (ADR 0101 — the backend re-derives this from
 *  `roster.autonomyLevel` on save; we send a consistent value for the type). */
function specLevelForLevel(level: AgentRosterLevel, existing?: AgentSpecLevel): AgentSpecLevel {
  if (level === 'guided') return 'execute-with-approval';
  if (level === 'auto') return 'autonomous-within-policy';
  return existing === 'draft-only' ? 'draft-only' : 'recommend';
}

const LEVEL_LABEL: Record<AgentRosterLevel, string> = {
  review: 'autonomySupervised',
  guided: 'autonomyGuided',
  auto: 'autonomyAutonomous',
};
const LEVEL_CHIP: Record<AgentRosterLevel, string> = {
  review: 'chip--warning',
  guided: 'chip--accent',
  auto: 'chip--success',
};

function parseList(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[\n,]/)) {
    const v = part.trim();
    if (v && !seen.has(v)) { seen.add(v); out.push(v); }
  }
  return out;
}
const listText = (arr: string[] | undefined): string => (arr ?? []).join('\n');

interface FormState {
  permRead: string;
  permWrite: string;
  permNever: string;
  hitl: string;
  escContacts: string;
  escTriggers: string;
  requiredConnections: string;
  metrics: string;
  withinPolicyActions: string;
}

function toForm(p: AgentProfile | null): FormState {
  return {
    permRead: listText(p?.permissions?.read),
    permWrite: listText(p?.permissions?.write),
    permNever: listText(p?.permissions?.never),
    hitl: listText(p?.hitl),
    escContacts: listText(p?.escalation?.contacts),
    escTriggers: listText(p?.escalation?.triggers),
    requiredConnections: listText(p?.requiredConnections),
    metrics: listText(p?.metrics),
    withinPolicyActions: listText(p?.autonomy.withinPolicyActions),
  };
}

function SectionHead({ icon, title, hint }: { icon: React.ReactNode; title: string; hint?: string }): JSX.Element {
  return (
    <div className="agentprofile-section-head">
      <span className="agentprofile-section-icon muted" aria-hidden="true">{icon}</span>
      <div>
        <div className="u-fw-600">{title}</div>
        {hint ? <div className="muted u-fs-12">{hint}</div> : null}
      </div>
    </div>
  );
}

export function AgentGuardrailsPanel({
  rosterId,
  roleKey,
  persona,
  autonomyLevel = 'auto',
  startEditing = false,
}: {
  rosterId: string;
  roleKey?: string | undefined;
  persona: string;
  /** The roster member's autonomy level — the single source of truth (ADR 0101). */
  autonomyLevel?: AgentRosterLevel | undefined;
  startEditing?: boolean;
}): JSX.Element {
  const { t } = useTranslation('agents');
  const [profile, setProfile] = useState<AgentProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(startEditing);
  const [form, setForm] = useState<FormState>(() => toForm(null));

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void getAgentProfile(rosterId)
      .then((p) => { if (!cancelled) { setProfile(p); setForm(toForm(p)); } })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [rosterId]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void =>
    setForm((f) => ({ ...f, [key]: value }));

  const isAuto = autonomyLevel === 'auto';

  const onSave = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const permRead = parseList(form.permRead);
      const permWrite = parseList(form.permWrite);
      const permNever = parseList(form.permNever);
      const hasPermissions = permRead.length || permWrite.length || permNever.length;
      const escContacts = parseList(form.escContacts);
      const escTriggers = parseList(form.escTriggers);
      const hasEscalation = escContacts.length || escTriggers.length;
      const withinPolicyActions = parseList(form.withinPolicyActions);

      const input: AgentProfileInput = {
        // roleKey is required by the profile + drives role theming. The guardrails
        // editor no longer surfaces it (the old Role section is gone), so fall back
        // to a non-empty default for an agent that has none — an empty string would
        // 400 the PUT.
        roleKey: profile?.roleKey ?? roleKey ?? 'custom',
        // PUT is a full replace — carry through fields this editor no longer owns
        // so a guardrails save doesn't wipe them. `capabilities`/`knowledge`/`twin`
        // are preserved server-side (agentProfileService); `configParameters` (its
        // functional `.compaction` key) and `department` we carry from the FE.
        ...(profile?.department !== undefined ? { department: profile.department } : {}),
        ...(profile?.configParameters !== undefined ? { configParameters: profile.configParameters } : {}),
        ...(hasPermissions ? { permissions: { read: permRead, write: permWrite, never: permNever } } : {}),
        ...(parseList(form.hitl).length ? { hitl: parseList(form.hitl) } : {}),
        ...(hasEscalation ? { escalation: { contacts: escContacts, triggers: escTriggers } } : {}),
        ...(parseList(form.requiredConnections).length ? { requiredConnections: parseList(form.requiredConnections) } : {}),
        ...(parseList(form.metrics).length ? { metrics: parseList(form.metrics) } : {}),
        // Autonomy is owned by `roster.autonomyLevel`; the backend re-derives
        // `specLevel`/`level` from it. We only carry the auto allowlist (and only
        // when the agent is actually at `auto`).
        autonomy: {
          specLevel: specLevelForLevel(autonomyLevel, profile?.autonomy.specLevel),
          ...(isAuto && withinPolicyActions.length ? { withinPolicyActions } : {}),
        },
      };
      const saved = await putAgentProfile(rosterId, input);
      setProfile(saved);
      setForm(toForm(saved));
      setEditing(false);
      setNotice(t('profileSaved'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const onCancel = (): void => {
    setForm(toForm(profile));
    setEditing(false);
    setError(null);
  };

  if (loading) return <StateCard title={t('profileLoading')} loading />;

  if (!profile && !editing) {
    return (
      <div className="agentprofile-root">
        {error ? <Notice variant="error">{error}</Notice> : null}
        <StateCard
          icon={<ShieldIcon size={20} />}
          title={t('guardrailsNoneTitle')}
          body={t('guardrailsNoneBody', { persona })}
          action={
            <button type="button" className="primary" onClick={() => { setForm(toForm(null)); setEditing(true); }}>
              {t('guardrailsAdd')}
            </button>
          }
        />
      </div>
    );
  }

  const levelChip = (
    <span className={`chip ${LEVEL_CHIP[autonomyLevel]}`} title={t('guardrailsAutonomyTitle')}>
      {t(LEVEL_LABEL[autonomyLevel])}
    </span>
  );

  return (
    <div className="agentprofile-root">
      {error ? <Notice variant="error">{error}</Notice> : null}
      {notice ? <Notice variant="success">{notice}</Notice> : null}

      <div className="action-bar u-justify-between u-items-center u-mb-3">
        <p className="muted u-fs-13 u-m-0">{t('guardrailsLede', { persona })}</p>
        {editing ? (
          <div className="action-bar">
            <button type="button" className="secondary" onClick={onCancel} disabled={saving}>{t('newCancel')}</button>
            <button type="button" className="primary" onClick={() => void onSave()} disabled={saving}>
              {saving ? t('profileSaving') : t('profileSaveProfile')}
            </button>
          </div>
        ) : (
          <button type="button" className="secondary" onClick={() => setEditing(true)}>{t('profileEditProfile')}</button>
        )}
      </div>

      <div className="u-grid u-gap-4">
        {/* Autonomy — read-only here; owned by roster.autonomyLevel (Edit modal). */}
        <div className="surface-card agentprofile-card">
          <SectionHead icon={<ZapIcon size={16} />} title={t('profileSectionAutonomy')} hint={t('guardrailsAutonomyHint')} />
          <div className="agentprofile-derived">
            <span className="muted u-fs-12">{t('guardrailsAutonomyLevel')}</span>
            {levelChip}
          </div>
          {isAuto ? (
            editing ? (
              <Field label={t('profileWithinPolicy')} help={t('profileWithinPolicyHelp')}>
                {(w) => (
                  <textarea {...w} rows={3} value={form.withinPolicyActions} onChange={(e) => set('withinPolicyActions', e.target.value)} placeholder={'sendReminder\ncreateDraft'} />
                )}
              </Field>
            ) : (
              <ReadRow label={t('profileWithinPolicy')}><ChipList values={profile?.autonomy.withinPolicyActions} tone="chip--success" /></ReadRow>
            )
          ) : null}
        </div>

        {/* Permissions — `never` enforced today; read/write per-tool in Phase 4. */}
        <div className="surface-card agentprofile-card">
          <SectionHead icon={<ShieldIcon size={16} />} title={t('profileSectionPermissions')} hint={t('profilePermissionsHintEdit')} />
          {editing ? (
            <>
              <ListField label={t('profilePermNever')} value={form.permNever} onChange={(v) => set('permNever', v)} placeholder={'email.send'} />
              <ListField label={t('profilePermWrite')} value={form.permWrite} onChange={(v) => set('permWrite', v)} placeholder={'tasks\ndrafts'} />
              <ListField label={t('profilePermRead')} value={form.permRead} onChange={(v) => set('permRead', v)} placeholder={'crm\ndocs'} />
            </>
          ) : (
            <>
              <ReadRow label={t('profilePermNever')}><ChipList values={profile?.permissions?.never} tone="chip--danger" /></ReadRow>
              <ReadRow label={t('profilePermWrite')}><ChipList values={profile?.permissions?.write} tone="chip--accent" /></ReadRow>
              <ReadRow label={t('profilePermRead')}><ChipList values={profile?.permissions?.read} /></ReadRow>
            </>
          )}
        </div>

        {/* Approvals & escalation. */}
        <div className="surface-card agentprofile-card">
          <SectionHead icon={<LifeBuoyIcon size={16} />} title={t('profileSectionHitl')} />
          {editing ? (
            <>
              <ListField label={t('profileAlwaysApprovalEdit')} value={form.hitl} onChange={(v) => set('hitl', v)} placeholder={'email.send\npayment.instruction'} />
              <ListField label={t('profileEscContacts')} value={form.escContacts} onChange={(v) => set('escContacts', v)} placeholder={'manager@example.com'} />
              <ListField label={t('profileEscTriggers')} value={form.escTriggers} onChange={(v) => set('escTriggers', v)} placeholder={'deal-value-over-threshold'} />
            </>
          ) : (
            <>
              <ReadRow label={t('profileAlwaysApproval')}><ChipList values={profile?.hitl} tone="chip--warning" /></ReadRow>
              <ReadRow label={t('profileEscContacts')}><ChipList values={profile?.escalation?.contacts} /></ReadRow>
              <ReadRow label={t('profileEscTriggers')}><ChipList values={profile?.escalation?.triggers} /></ReadRow>
            </>
          )}
        </div>

        {/* Required connections. */}
        <div className="surface-card agentprofile-card">
          <SectionHead icon={<PlugIcon size={16} />} title={t('profileSectionConnections')} hint={t('profileConnectionsHintEdit')} />
          {editing ? (
            <ListField label={t('profileProviders')} value={form.requiredConnections} onChange={(v) => set('requiredConnections', v)} placeholder={'google\nslack'} />
          ) : (
            <ReadRow label={t('profileProviders')}><ChipList values={profile?.requiredConnections} tone="chip--accent" /></ReadRow>
          )}
        </div>

        {/* Metrics. */}
        <div className="surface-card agentprofile-card">
          <SectionHead icon={<ActivityIcon size={16} />} title={t('profileSectionMetrics')} />
          {editing ? (
            <ListField label={t('profileMetrics')} value={form.metrics} onChange={(v) => set('metrics', v)} placeholder={'tickets_resolved\nresponse_latency'} />
          ) : (
            <ReadRow label={t('profileMetrics')}><ChipList values={profile?.metrics} /></ReadRow>
          )}
        </div>
      </div>
    </div>
  );
}

function ChipList({ values, tone = 'chip--muted' }: { values: string[] | undefined; tone?: string }): JSX.Element {
  const { t } = useTranslation('agents');
  if (!values || values.length === 0) return <span className="muted u-fs-13">{t('none')}</span>;
  return (
    <div className="u-flex u-gap-2 u-wrap">
      {values.map((v) => <span key={v} className={`chip ${tone}`}>{v}</span>)}
    </div>
  );
}

function ReadRow({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="agentprofile-row">
      <div className="agentprofile-row-label muted u-fs-12">{label}</div>
      <div className="agentprofile-row-value">{children}</div>
    </div>
  );
}

function ListField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }): JSX.Element {
  const { t } = useTranslation('agents');
  return (
    <Field label={label} help={t('profileListHelp')}>
      {(w) => <textarea {...w} rows={2} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />}
    </Field>
  );
}
