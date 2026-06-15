/**
 * Agent profile panel (ADR 0031 §1d) — view/edit the rich `agentProfile`
 * host-extension for a standing agent: config parameters, advisory permissions
 * (read/write/never), human-in-the-loop actions, escalation, channels, admin
 * controls, risk/compliance, required connections, success metrics, and the
 * four-level autonomy model. The spec-level autonomy is editable; the enforced
 * roster `level` is derived server-side (ADR 0031 mapping) and shown read-only.
 *
 * Shared everywhere the profile is surfaced — the agent workspace Profile tab
 * (the owner's view) and the admin Roster page (a modal). Both call the same
 * `getAgentProfile` / `putAgentProfile` client (rosterClient.ts); the backend
 * gates both reads and writes by roster ownership, so a foreign/unknown agent
 * fails closed (404 → the "no profile" empty state).
 *
 * NON-NORMATIVE: host-local product config under `/v1/host/openwop-app/*`, never the
 * RFC 0003 manifest wire shape.
 */

import { useEffect, useMemo, useState } from 'react';
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
import { Field, TextField, SelectField } from '../ui/Field.js';
import {
  ShieldIcon, ScaleIcon, ZapIcon, LifeBuoyIcon, SettingsIcon, PlugIcon,
  ActivityIcon, MessageSquareIcon, AlertIcon, UserIcon,
} from '../ui/icons/index.js';

const SPEC_LEVELS: ReadonlyArray<{ value: AgentSpecLevel; label: string; help: string }> = [
  { value: 'draft-only', label: 'Draft only', help: 'Every pick queues an approval; no write/send tools.' },
  { value: 'recommend', label: 'Recommend', help: 'Every pick queues an approval; may stage writes but cannot commit.' },
  { value: 'execute-with-approval', label: 'Execute with approval', help: 'Routine picks run; HIGH-priority picks queue an approval.' },
  { value: 'autonomous-within-policy', label: 'Autonomous within policy', help: 'Runs immediately, but only the allowlisted actions are permitted.' },
];

/** ADR 0031 mapping (four-level spec → three-level roster). Mirrors the backend
 *  `levelForSpecLevel` so the editor previews the derived level live. */
function previewLevel(spec: AgentSpecLevel): AgentRosterLevel {
  switch (spec) {
    case 'draft-only':
    case 'recommend':
      return 'review';
    case 'execute-with-approval':
      return 'guided';
    case 'autonomous-within-policy':
      return 'auto';
  }
}

const LEVEL_CHIP: Record<AgentRosterLevel, { chip: string; label: string }> = {
  review: { chip: 'chip--warning', label: 'review — proposes' },
  guided: { chip: 'chip--accent', label: 'guided' },
  auto: { chip: 'chip--success', label: 'auto — runs' },
};

/** Split a textarea/comma list into trimmed, de-duped, non-empty entries. */
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

/** Editable form state — strings for the list/JSON fields (parsed on save). */
interface FormState {
  roleKey: string;
  specLevel: AgentSpecLevel;
  withinPolicyActions: string;
  configParametersJson: string;
  permRead: string;
  permWrite: string;
  permNever: string;
  hitl: string;
  escContacts: string;
  escTriggers: string;
  channelApproval: string;
  channelDelivery: string;
  adminControls: string;
  riskCompliance: string;
  requiredConnections: string;
  metrics: string;
}

function toForm(p: AgentProfile | null, fallbackRoleKey: string): FormState {
  return {
    roleKey: p?.roleKey ?? fallbackRoleKey,
    specLevel: p?.autonomy.specLevel ?? 'draft-only',
    withinPolicyActions: listText(p?.autonomy.withinPolicyActions),
    configParametersJson: p?.configParameters ? JSON.stringify(p.configParameters, null, 2) : '',
    permRead: listText(p?.permissions?.read),
    permWrite: listText(p?.permissions?.write),
    permNever: listText(p?.permissions?.never),
    hitl: listText(p?.hitl),
    escContacts: listText(p?.escalation?.contacts),
    escTriggers: listText(p?.escalation?.triggers),
    channelApproval: p?.channels?.approval ?? '',
    channelDelivery: p?.channels?.delivery ?? '',
    adminControls: listText(p?.adminControls),
    riskCompliance: listText(p?.riskCompliance),
    requiredConnections: listText(p?.requiredConnections),
    metrics: listText(p?.metrics),
  };
}

/** Section header — a Lucide glyph + title, consistent across the panel. */
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

export function AgentProfilePanel({
  rosterId,
  roleKey,
  persona,
  /** When false (default), opens read-only with an "Edit profile" toggle. */
  startEditing = false,
}: {
  rosterId: string;
  /** The roster member's `roleKey`, used as the default when no profile exists. */
  roleKey?: string | undefined;
  persona: string;
  startEditing?: boolean;
}): JSX.Element {
  const [profile, setProfile] = useState<AgentProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(startEditing);
  const [form, setForm] = useState<FormState>(() => toForm(null, roleKey ?? ''));

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void getAgentProfile(rosterId)
      .then((p) => { if (!cancelled) { setProfile(p); setForm(toForm(p, roleKey ?? '')); } })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [rosterId, roleKey]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void =>
    setForm((f) => ({ ...f, [key]: value }));

  const previewedLevel = useMemo(() => previewLevel(form.specLevel), [form.specLevel]);
  const isAuto = previewedLevel === 'auto';

  // JSON validity for configParameters — surfaced inline so a bad blob can't
  // silently fail the save.
  const configError = useMemo<string | null>(() => {
    const raw = form.configParametersJson.trim();
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return 'Config parameters must be a JSON object (e.g. {"threshold": 5000}).';
      }
      return null;
    } catch {
      return 'Config parameters must be valid JSON.';
    }
  }, [form.configParametersJson]);

  const onSave = async (): Promise<void> => {
    if (configError) return;
    if (!form.roleKey.trim()) { setError('A role key is required.'); return; }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const rawConfig = form.configParametersJson.trim();
      const configParameters = rawConfig
        ? (JSON.parse(rawConfig) as Record<string, unknown>)
        : undefined;
      const permRead = parseList(form.permRead);
      const permWrite = parseList(form.permWrite);
      const permNever = parseList(form.permNever);
      const hasPermissions = permRead.length || permWrite.length || permNever.length;
      const escContacts = parseList(form.escContacts);
      const escTriggers = parseList(form.escTriggers);
      const hasEscalation = escContacts.length || escTriggers.length;
      const approval = form.channelApproval.trim();
      const delivery = form.channelDelivery.trim();
      const hasChannels = approval || delivery;
      const withinPolicyActions = parseList(form.withinPolicyActions);

      const input: AgentProfileInput = {
        roleKey: form.roleKey.trim(),
        // PUT is a full replace — carry the (non-editable here) department
        // through so an edit doesn't drop a seeded org placement.
        ...(profile?.department !== undefined ? { department: profile.department } : {}),
        ...(configParameters !== undefined ? { configParameters } : {}),
        ...(hasPermissions ? { permissions: { read: permRead, write: permWrite, never: permNever } } : {}),
        ...(parseList(form.hitl).length ? { hitl: parseList(form.hitl) } : {}),
        ...(hasEscalation ? { escalation: { contacts: escContacts, triggers: escTriggers } } : {}),
        ...(hasChannels
          ? { channels: { ...(approval ? { approval } : {}), ...(delivery ? { delivery } : {}) } }
          : {}),
        ...(parseList(form.adminControls).length ? { adminControls: parseList(form.adminControls) } : {}),
        ...(parseList(form.riskCompliance).length ? { riskCompliance: parseList(form.riskCompliance) } : {}),
        ...(parseList(form.requiredConnections).length ? { requiredConnections: parseList(form.requiredConnections) } : {}),
        ...(parseList(form.metrics).length ? { metrics: parseList(form.metrics) } : {}),
        autonomy: {
          specLevel: form.specLevel,
          ...(isAuto && withinPolicyActions.length ? { withinPolicyActions } : {}),
        },
      };
      const saved = await putAgentProfile(rosterId, input);
      setProfile(saved);
      setForm(toForm(saved, roleKey ?? ''));
      setEditing(false);
      setNotice('Profile saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const onCancel = (): void => {
    setForm(toForm(profile, roleKey ?? ''));
    setEditing(false);
    setError(null);
  };

  if (loading) {
    return <StateCard title="Loading profile…" loading />;
  }

  // No profile yet — offer to create one (the owner can author it from scratch).
  if (!profile && !editing) {
    return (
      <div className="agentprofile-root">
        {error ? <Notice variant="error">{error}</Notice> : null}
        <StateCard
          icon={<ShieldIcon size={20} />}
          title="No profile yet"
          body={`${persona} has no governance profile. Add one to record its config, permissions, escalation, autonomy, and compliance notes.`}
          action={
            <button type="button" className="primary" onClick={() => { setForm(toForm(null, roleKey ?? '')); setEditing(true); }}>
              Add profile
            </button>
          }
        />
      </div>
    );
  }

  return (
    <div className="agentprofile-root">
      {error ? <Notice variant="error">{error}</Notice> : null}
      {notice ? <Notice variant="success">{notice}</Notice> : null}

      <div className="action-bar u-justify-between u-items-center u-mb-3">
        <p className="muted u-fs-13 u-m-0">
          Governance profile for {persona} — host-local config (not the agent's protocol manifest).
        </p>
        {editing ? (
          <div className="action-bar">
            <button type="button" className="secondary" onClick={onCancel} disabled={saving}>Cancel</button>
            <button type="button" className="primary" onClick={() => void onSave()} disabled={saving || !!configError}>
              {saving ? 'Saving…' : 'Save profile'}
            </button>
          </div>
        ) : (
          <button type="button" className="secondary" onClick={() => setEditing(true)}>Edit profile</button>
        )}
      </div>

      {editing ? (
        <Editor
          form={form}
          set={set}
          isAuto={isAuto}
          previewedLevel={previewedLevel}
          configError={configError}
        />
      ) : (
        profile ? <ReadView profile={profile} /> : null
      )}
    </div>
  );
}

/* ───────────────────────────── read view ───────────────────────────── */

function ChipList({ values, tone = 'chip--muted' }: { values: string[] | undefined; tone?: string }): JSX.Element {
  if (!values || values.length === 0) return <span className="muted u-fs-13">none</span>;
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

function ReadView({ profile }: { profile: AgentProfile }): JSX.Element {
  const lvl = LEVEL_CHIP[profile.autonomy.level];
  const specLabel = SPEC_LEVELS.find((s) => s.value === profile.autonomy.specLevel)?.label ?? profile.autonomy.specLevel;
  const cfg = profile.configParameters;
  const cfgEntries = cfg ? Object.entries(cfg) : [];
  return (
    <div className="u-grid u-gap-4">
      <div className="surface-card agentprofile-card">
        <SectionHead icon={<UserIcon size={16} />} title="Role" />
        <ReadRow label="Role key"><span className="u-fs-14"><code>{profile.roleKey}</code></span></ReadRow>
        {profile.department ? (
          <ReadRow label="Department">
            <span className="u-fs-14">{profile.department.name}{profile.department.roleName ? ` · ${profile.department.roleName}` : ''}</span>
          </ReadRow>
        ) : null}
      </div>
      <div className="surface-card agentprofile-card">
        <SectionHead icon={<ZapIcon size={16} />} title="Autonomy" />
        <ReadRow label="Spec level">
          <span className="u-fs-14">{specLabel}</span>
        </ReadRow>
        <ReadRow label="Enforced level (derived)">
          <span className={`chip ${lvl.chip}`} title="Derived from the spec level (ADR 0031 mapping). Not editable directly.">{lvl.label}</span>
        </ReadRow>
        {profile.autonomy.level === 'auto' ? (
          <ReadRow label="Within-policy actions"><ChipList values={profile.autonomy.withinPolicyActions} tone="chip--success" /></ReadRow>
        ) : null}
      </div>

      <div className="surface-card agentprofile-card">
        <SectionHead icon={<ShieldIcon size={16} />} title="Permissions" hint="Advisory access controls (display-only day-1)." />
        <ReadRow label="Read"><ChipList values={profile.permissions?.read} /></ReadRow>
        <ReadRow label="Write"><ChipList values={profile.permissions?.write} tone="chip--accent" /></ReadRow>
        <ReadRow label="Never"><ChipList values={profile.permissions?.never} tone="chip--danger" /></ReadRow>
      </div>

      <div className="surface-card agentprofile-card">
        <SectionHead icon={<LifeBuoyIcon size={16} />} title="Human-in-the-loop & escalation" />
        <ReadRow label="Always require approval"><ChipList values={profile.hitl} tone="chip--warning" /></ReadRow>
        <ReadRow label="Escalation contacts"><ChipList values={profile.escalation?.contacts} /></ReadRow>
        <ReadRow label="Escalation triggers"><ChipList values={profile.escalation?.triggers} /></ReadRow>
      </div>

      <div className="surface-card agentprofile-card">
        <SectionHead icon={<MessageSquareIcon size={16} />} title="Channels" />
        <ReadRow label="Approval channel">{profile.channels?.approval ? <span className="u-fs-14">{profile.channels.approval}</span> : <span className="muted u-fs-13">none</span>}</ReadRow>
        <ReadRow label="Delivery channel">{profile.channels?.delivery ? <span className="u-fs-14">{profile.channels.delivery}</span> : <span className="muted u-fs-13">none</span>}</ReadRow>
      </div>

      <div className="surface-card agentprofile-card">
        <SectionHead icon={<ScaleIcon size={16} />} title="Risk, compliance & admin controls" />
        <ReadRow label="Risk / compliance"><ChipList values={profile.riskCompliance} tone="chip--warning" /></ReadRow>
        <ReadRow label="Admin controls"><ChipList values={profile.adminControls} /></ReadRow>
      </div>

      <div className="surface-card agentprofile-card">
        <SectionHead icon={<PlugIcon size={16} />} title="Required connections" hint="Connections providers that gate activation." />
        <ReadRow label="Providers"><ChipList values={profile.requiredConnections} tone="chip--accent" /></ReadRow>
      </div>

      <div className="surface-card agentprofile-card">
        <SectionHead icon={<ActivityIcon size={16} />} title="Success metrics" />
        <ReadRow label="Metrics"><ChipList values={profile.metrics} /></ReadRow>
      </div>

      <div className="surface-card agentprofile-card">
        <SectionHead icon={<SettingsIcon size={16} />} title="Config parameters" />
        {cfgEntries.length === 0 ? (
          <span className="muted u-fs-13">none</span>
        ) : (
          <dl className="agentprofile-kv">
            {cfgEntries.map(([k, v]) => (
              <div key={k} className="agentprofile-kv-row">
                <dt className="muted u-fs-12">{k}</dt>
                <dd className="u-fs-13 u-m-0"><code>{typeof v === 'string' ? v : JSON.stringify(v)}</code></dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </div>
  );
}

/* ───────────────────────────── editor ───────────────────────────── */

function Editor({
  form,
  set,
  isAuto,
  previewedLevel,
  configError,
}: {
  form: FormState;
  set: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
  isAuto: boolean;
  previewedLevel: AgentRosterLevel;
  configError: string | null;
}): JSX.Element {
  const lvl = LEVEL_CHIP[previewedLevel];
  const specHelp = SPEC_LEVELS.find((s) => s.value === form.specLevel)?.help;
  return (
    <div className="u-grid u-gap-4">
      <div className="surface-card agentprofile-card">
        <SectionHead icon={<UserIcon size={16} />} title="Role" />
        <TextField
          label="Role key"
          required
          help="The role template key, e.g. finance-close. Mirrors the roster role."
          value={form.roleKey}
          onChange={(e) => set('roleKey', e.target.value)}
          placeholder="finance-close"
        />
      </div>
      <div className="surface-card agentprofile-card">
        <SectionHead icon={<ZapIcon size={16} />} title="Autonomy" />
        <SelectField
          label="Spec level"
          help={specHelp}
          value={form.specLevel}
          onChange={(e) => set('specLevel', e.target.value as AgentSpecLevel)}
        >
          {SPEC_LEVELS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </SelectField>
        <div className="agentprofile-derived">
          <span className="muted u-fs-12">Enforced level (derived)</span>
          <span className={`chip ${lvl.chip}`} title="Derived from the spec level — not editable directly (ADR 0031 mapping).">{lvl.label}</span>
        </div>
        {isAuto ? (
          <Field
            label="Within-policy actions"
            help="Allowlisted actions permitted without approval. Anything off-list falls back to review."
          >
            {(w) => (
              <textarea {...w} rows={3} value={form.withinPolicyActions} onChange={(e) => set('withinPolicyActions', e.target.value)} placeholder={'sendReminder\ncreateDraft'} />
            )}
          </Field>
        ) : null}
      </div>

      <div className="surface-card agentprofile-card">
        <SectionHead icon={<ShieldIcon size={16} />} title="Permissions" hint="One entry per line. Advisory day-1 (display only)." />
        <ListField label="Read" value={form.permRead} onChange={(v) => set('permRead', v)} placeholder={'erp\ndocs'} />
        <ListField label="Write" value={form.permWrite} onChange={(v) => set('permWrite', v)} placeholder={'tasks\ndrafts'} />
        <ListField label="Never" value={form.permNever} onChange={(v) => set('permNever', v)} placeholder={'postJournal'} />
      </div>

      <div className="surface-card agentprofile-card">
        <SectionHead icon={<LifeBuoyIcon size={16} />} title="Human-in-the-loop & escalation" />
        <ListField label="Always require approval (HITL)" value={form.hitl} onChange={(v) => set('hitl', v)} placeholder={'journalPosting\npaymentInstruction'} />
        <ListField label="Escalation contacts" value={form.escContacts} onChange={(v) => set('escContacts', v)} placeholder={'controller@example.com'} />
        <ListField label="Escalation triggers" value={form.escTriggers} onChange={(v) => set('escTriggers', v)} placeholder={'missingEvidence'} />
      </div>

      <div className="surface-card agentprofile-card">
        <SectionHead icon={<MessageSquareIcon size={16} />} title="Channels" />
        <TextField label="Approval channel" value={form.channelApproval} onChange={(e) => set('channelApproval', e.target.value)} placeholder="slack:#finance-approvals" />
        <TextField label="Delivery channel" value={form.channelDelivery} onChange={(e) => set('channelDelivery', e.target.value)} placeholder="email" />
      </div>

      <div className="surface-card agentprofile-card">
        <SectionHead icon={<ScaleIcon size={16} />} title="Risk, compliance & admin controls" />
        <ListField label="Risk / compliance" value={form.riskCompliance} onChange={(v) => set('riskCompliance', v)} placeholder={'SoD\ndualReview'} />
        <ListField label="Admin controls" value={form.adminControls} onChange={(v) => set('adminControls', v)} placeholder={'sodPolicy\npostingDisablement'} />
      </div>

      <div className="surface-card agentprofile-card">
        <SectionHead icon={<PlugIcon size={16} />} title="Required connections" hint="Connections provider ids that gate activation." />
        <ListField label="Providers" value={form.requiredConnections} onChange={(v) => set('requiredConnections', v)} placeholder={'erp\ndocStorage'} />
      </div>

      <div className="surface-card agentprofile-card">
        <SectionHead icon={<ActivityIcon size={16} />} title="Success metrics" />
        <ListField label="Metrics" value={form.metrics} onChange={(v) => set('metrics', v)} placeholder={'daysToClose\nreconPrepTime'} />
      </div>

      <div className="surface-card agentprofile-card">
        <SectionHead icon={<SettingsIcon size={16} />} title="Config parameters" hint="Free-form JSON object." />
        <Field
          label="Config parameters (JSON)"
          error={configError ? <span className="u-flex u-items-center u-gap-1"><AlertIcon size={13} /> {configError}</span> : undefined}
          help='e.g. {"materialityThreshold": 5000}'
        >
          {(w) => (
            <textarea
              {...w}
              rows={5}
              className="agentprofile-json"
              value={form.configParametersJson}
              onChange={(e) => set('configParametersJson', e.target.value)}
              placeholder={'{\n  "materialityThreshold": 5000\n}'}
              spellCheck={false}
            />
          )}
        </Field>
      </div>
    </div>
  );
}

/** A newline-list textarea field (one entry per line). */
function ListField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}): JSX.Element {
  return (
    <Field label={label} help="One per line (or comma-separated).">
      {(w) => (
        <textarea {...w} rows={2} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
      )}
    </Field>
  );
}
