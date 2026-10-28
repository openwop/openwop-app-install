/**
 * ADR 0942 P5 — the review-policy editor for a campaign (its override) or a client
 * (its default). One panel for both scopes; the campaign detail page and the
 * campaign-ops client bar lazy-load it.
 *
 * The SERVER owns everything that decides: the class vocabulary, each class's
 * effective rule (`effective`), and whether a save tightens or loosens (D9). This
 * panel never predicts authority. It sends the save and shows the server's answer,
 * so a refused loosen names the steps it would have loosened.
 *
 * Hidden entirely when the `campaign-orchestration.autonomy` toggle is off.
 */
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../ui/Button.js';
import { Notice } from '../../../ui/Notice.js';
import { InlineState } from '../../../ui/InlineState.js';
import { SelectField } from '../../../ui/Field.js';
import { toast } from '../../../ui/toast.js';
import { useUnsavedChangesWarning } from '../../../ui/useUnsavedChangesWarning.js';
import { formatNumber } from '../../../i18n/format.js';
import { BanIcon, BellIcon, ShieldIcon, ZapIcon } from '../../../ui/icons/index.js';
import {
  AutonomyDisabledError, LoosenRefusedError, PolicyConflictError, clearCampaignAutonomy, getAutonomy, saveAutonomy,
  type ActionRule, type AutonomyScope, type Condition, type Decision, type EffectiveRule, type Outcome, type PolicyView, type PresetId,
} from './autonomyClient.js';

type TFn = ReturnType<typeof useTranslation>['t'];

const OUTCOMES: readonly Outcome[] = ['auto', 'notify-after', 'approve', 'blocked'];
const SEVERITY: Record<Outcome, number> = { auto: 0, 'notify-after': 1, approve: 2, blocked: 3 };
const ROLE_CHOICES = ['owner', 'admin', 'editor'] as const;
/** Classes whose outcome can never be looser than approve (D2). The server enforces it too. */
const APPROVE_FLOOR = new Set(['email.resume-sending']);

/** Row groups for reading, not for deciding (the server's `actionClasses` is the vocabulary). */
const GROUPS: Array<{ key: string; classes: string[] }> = [
  { key: 'autGroupCreative', classes: ['creative.generate', 'plan.approve', 'creative.review'] },
  { key: 'autGroupPublish', classes: ['content.publish', 'ads.publish', 'ads.launch', 'ads.budget', 'experiment.promote', 'report.publish'] },
  { key: 'autGroupMessaging', classes: ['email.campaign-send', 'email.resume-sending', 'sms.send', 'social.post'] },
  { key: 'autGroupLeads', classes: ['lead.contact', 'lead.grade-adjust', 'journey.publish'] },
  { key: 'autGroupAgency', classes: ['asset.accept-vendor', 'vendor.engage', 'playbook.rollout', 'campaign.change-set.apply'] },
];

/** Anything the server lists that GROUPS does not name still renders, under "Other". */
const GROUPED = new Set(GROUPS.flatMap((g) => g.classes));

const OUTCOME_CHIP: Record<Outcome, { cls: string; Icon: (p: { size?: number }) => JSX.Element }> = {
  auto: { cls: 'chip--success', Icon: ZapIcon },
  'notify-after': { cls: 'chip--accent', Icon: BellIcon },
  approve: { cls: 'chip--warning', Icon: ShieldIcon },
  blocked: { cls: 'chip--danger', Icon: BanIcon },
};

const rowKey = (r: { actionClass: string; stage?: string | undefined }): string => (r.stage ? `${r.actionClass}:${r.stage}` : r.actionClass);
const classKey = (actionClass: string): string => `autClass_${actionClass.replace(/[.-]/g, '_')}`;
const classLabel = (actionClass: string, t: TFn): string => t(classKey(actionClass), { defaultValue: actionClass });
const presetOf = (view: PolicyView): PresetId | null => {
  const m = /^preset:(.+)$/.exec(view.policy.policyId);
  return m ? (`${m[1]}@${view.policy.version}` as PresetId) : null;
};

function OutcomeChip({ outcome, t }: { outcome: Outcome; t: TFn }): JSX.Element {
  const { cls, Icon } = OUTCOME_CHIP[outcome];
  return <span className={`chip ${cls}`}><Icon size={12} /> {t(`autOutcome_${outcome.replace('-', '_')}`)}</span>;
}

function conditionText(c: Condition, t: TFn): string {
  const fact = t(`autFact_${c.fact}`);
  if (typeof c.value === 'boolean') return c.value ? t('autCondTrue', { fact }) : t('autCondFalse', { fact });
  const value = formatNumber(c.value);
  const op = c.op === '>=' ? 'ge' : c.op === '>' ? 'gt' : c.op === '<=' ? 'le' : c.op === '<' ? 'lt' : 'eq';
  return t(`autCond_${op}`, { fact, value });
}

function approversOf(d: Decision, t: TFn): string {
  if (d.outcome !== 'approve') return '—';
  const roles = (d.approver.roleRefs ?? []).map((r) => t(`autRole_${r}`, { defaultValue: r }));
  const who = roles.join(', ') || t('autApproversNamed');
  return d.approver.requiredApprovals > 1 ? t('autApproversQuorum', { who, n: formatNumber(d.approver.requiredApprovals) }) : who;
}

/** A decision with the chosen outcome, keeping the row's approver/notify shape where it has one. */
function decisionFor(outcome: Outcome, prev: Decision, roles: string[], blockedReason: string): Decision {
  if (outcome === 'auto') return { outcome };
  if (outcome === 'blocked') return { outcome, reason: blockedReason };
  if (outcome === 'notify-after') return { outcome, notify: prev.outcome === 'notify-after' ? { ...prev.notify, roleRefs: roles } : { roleRefs: roles, channels: ['inbox'], digest: 'immediate' } };
  return { outcome, approver: prev.outcome === 'approve' ? { ...prev.approver, roleRefs: roles } : { roleRefs: roles, requiredApprovals: 1, delegation: 'allowed' } };
}

export interface AutonomyPolicyPanelProps {
  scope: AutonomyScope;
  /** Render without the outer surface card (inside a modal). */
  bare?: boolean;
}

type Load = { kind: 'loading' } | { kind: 'disabled' } | { kind: 'failed' } | { kind: 'ready'; view: PolicyView };

export default function AutonomyPolicyPanel({ scope, bare = false }: AutonomyPolicyPanelProps): JSX.Element | null {
  const identity = scope.kind === 'campaign' ? `campaign:${scope.campaignId}` : `client:${scope.orgId}`;
  return <AutonomyPolicyEditor key={identity} scope={scope} bare={bare} />;
}

function AutonomyPolicyEditor({ scope, bare = false }: AutonomyPolicyPanelProps): JSX.Element | null {
  const { t } = useTranslation('campaign-orchestration');
  const headingId = useId();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, ActionRule>>({});
  const [roles, setRoles] = useState<string[]>(['owner', 'admin']);
  const [rolesTouched, setRolesTouched] = useState(false);
  /** A level picked but not yet applied: arrowing through the radios must not save each one. */
  const [pendingPreset, setPendingPreset] = useState<PresetId | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; loosened?: string[] } | null>(null);
  const scopeKey = scope.kind === 'campaign' ? `c:${scope.campaignId}` : `o:${scope.orgId}`;

  const refresh = useCallback(async () => {
    try {
      const view = await getAutonomy(scope);
      setLoad({ kind: 'ready', view });
    } catch (e) {
      setLoad(e instanceof AutonomyDisabledError ? { kind: 'disabled' } : { kind: 'failed' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scopeKey is the scope's identity
  }, [scopeKey]);
  useEffect(() => { void refresh(); }, [refresh]);

  const dirty = (editing && (Object.keys(draft).length > 0 || rolesTouched)) || pendingPreset !== null;
  useUnsavedChangesWarning(dirty);

  const view = load.kind === 'ready' ? load.view : null;
  const rows = useMemo(() => {
    if (!view) return [] as EffectiveRule[];
    return view.effective.map((r) => ({ ...r, rule: draft[rowKey(r)] ?? r.rule }));
  }, [view, draft]);

  // Toggle off: the campaign page shows nothing; inside the client modal, say so.
  if (load.kind === 'disabled') return bare ? <p className="muted u-m-0">{t('autDisabled')}</p> : null;

  const startEditing = (): void => {
    if (!view) return;
    const firstApprove = view.effective.map((r) => r.rule.default).find((d): d is Extract<Decision, { outcome: 'approve' }> => d.outcome === 'approve');
    setRoles(firstApprove?.approver.roleRefs?.length ? [...firstApprove.approver.roleRefs] : ['owner', 'admin']);
    setDraft({}); setRolesTouched(false); setError(null); setEditing(true);
  };

  const onSaved = async (next: PolicyView, message: string): Promise<void> => {
    setLoad({ kind: 'ready', view: next });
    setEditing(false); setDraft({}); setRolesTouched(false); setPendingPreset(null); setError(null);
    toast.success(message);
  };

  const handleError = (e: unknown): void => {
    if (e instanceof LoosenRefusedError) setError({ message: t('autLoosenRefused'), loosened: e.loosened });
    else if (e instanceof PolicyConflictError) { setError({ message: t('autConflict') }); void refresh(); }
    else setError({ message: e instanceof Error ? e.message : t('autSaveFailed') });
  };

  const choosePreset = async (preset: PresetId): Promise<void> => {
    if (!view || busy) return;
    setBusy(true); setError(null);
    try { await onSaved(await saveAutonomy(scope, { preset }, view.etag), t('autSaved')); } catch (e) { handleError(e); } finally { setBusy(false); }
  };

  const saveCustom = async (): Promise<void> => {
    if (!view || busy) return;
    setBusy(true); setError(null);
    // The FULL effective rule set, one rule per (class, stage), with the edits applied.
    // The approver roles are rewritten on every approval and notice ONLY when the
    // person changed them; otherwise each row keeps its own (an untouched row must
    // not silently change who approves it).
    const withRoles = (d: Decision): Decision => (!rolesTouched ? d : d.outcome === 'approve' ? { ...d, approver: { ...d.approver, roleRefs: roles } } : d.outcome === 'notify-after' ? { ...d, notify: { ...d.notify, roleRefs: roles } } : d);
    const rules: ActionRule[] = rows.map((r) => {
      const rule = draft[rowKey(r)] ?? r.rule;
      return {
        actionClass: r.actionClass, ...(r.stage ? { stage: r.stage } : {}),
        default: withRoles(rule.default),
        ...(rule.escalations?.length ? { escalations: rule.escalations.map((e) => ({ when: e.when, then: withRoles(e.then) })) } : {}),
      };
    });
    const basePreset = presetOf(view) ?? view.policy.basePreset;
    try {
      await onSaved(await saveAutonomy(scope, { name: t('autCustomName'), ...(basePreset ? { basePreset } : {}), rules }, view.etag), t('autSaved'));
    } catch (e) { handleError(e); } finally { setBusy(false); }
  };

  const revertToClientDefault = async (): Promise<void> => {
    if (!view || scope.kind !== 'campaign' || busy) return;
    setBusy(true); setError(null);
    try { await onSaved(await clearCampaignAutonomy(scope.campaignId, view.etag), t('autReverted')); } catch (e) { handleError(e); } finally { setBusy(false); }
  };

  const setOutcome = (r: EffectiveRule, outcome: Outcome): void => {
    const rule = draft[rowKey(r)] ?? r.rule;
    const def = decisionFor(outcome, rule.default, roles, t('autBlockedReason'));
    // D2 — an escalation may only be at least as strict as its rule's default.
    const escalations = (rule.escalations ?? []).filter((e) => SEVERITY[e.then.outcome] >= SEVERITY[outcome]);
    setDraft((d) => ({ ...d, [rowKey(r)]: { ...rule, default: def, ...(escalations.length ? { escalations } : { escalations: [] }) } }));
  };

  const setThreshold = (r: EffectiveRule, escIdx: number, condIdx: number, value: number): void => {
    const rule = draft[rowKey(r)] ?? r.rule;
    const escalations = (rule.escalations ?? []).map((e, i) => (i !== escIdx ? e : { ...e, when: e.when.map((c, j) => (j === condIdx ? { ...c, value } : c)) }));
    setDraft((d) => ({ ...d, [rowKey(r)]: { ...rule, escalations } }));
  };

  const sourceLabel = view ? t(`autSource_${view.source}`) : '';
  const currentPreset = view ? presetOf(view) : null;

  const body = (
    <>
      <div className="u-flex u-flex-wrap u-items-center u-gap-2 u-mb-2">
        <ShieldIcon size={16} />
        <h3 id={headingId} className="u-m-0">{t('autTitle')}</h3>
        {view ? <span className="chip chip--muted">{sourceLabel}</span> : null}
      </div>
      <p className="muted u-mt-0">{scope.kind === 'campaign' ? t('autLedeCampaign') : t('autLedeClient')}</p>

      {load.kind === 'loading' ? <InlineState kind="loading" message={t('autLoading')} /> : null}
      {load.kind === 'failed' ? (
        <InlineState kind="failed" announce={t('autLoadFailed')} announcePolite message={t('autLoadFailed')}
          action={<Button variant="secondary" size="sm" onClick={() => void refresh()}>{t('autRetry')}</Button>} />
      ) : null}

      {view ? (
        <>
          {view.dangling ? <Notice variant="warning">{t('autDangling')}</Notice> : null}
          {scope.kind === 'campaign' && view.source !== 'campaign' && view.clientDefault ? (
            <p className="u-fs-13 u-mt-0">{t('autFollowsClient', { name: view.clientDefault.name })}</p>
          ) : null}

          <fieldset className="u-border-0 u-p-0 u-m-0 u-mb-3" disabled={busy || editing} aria-describedby={`${headingId}-level-help`}>
            <legend className="u-fw-600 u-mb-2">{t('autLevelLegend')}</legend>
            <div className="u-grid u-gap-2">
              {view.presets.map((p) => {
                const id = `${headingId}-${p.id}`;
                const key = p.id.split('@')[0]!.replace(/-/g, '_');
                return (
                  <label key={p.id} htmlFor={id} className="surface-card u-flex u-items-start u-gap-2 u-mb-0">
                    <input id={id} type="radio" name={`${headingId}-level`} checked={(pendingPreset ?? currentPreset) === p.id} onChange={() => { setError(null); setPendingPreset(p.id === currentPreset ? null : p.id); }} />
                    <span className="u-fw-600">{t(`autPreset_${key}`, { defaultValue: p.name })}</span>
                    <span className="u-fs-13 muted u-min-w-0">{t(`autPresetHelp_${key}`)}</span>
                  </label>
                );
              })}
              {currentPreset === null ? (
                <label className="surface-card u-flex u-items-start u-gap-2 u-mb-0">
                  <input type="radio" name={`${headingId}-level`} checked={pendingPreset === null} onChange={() => setPendingPreset(null)} />
                  <span className="u-fw-600">{t('autCustom')}</span>
                  <span className="u-fs-13 muted u-min-w-0">{view.policy.name}</span>
                </label>
              ) : null}
            </div>
            <p id={`${headingId}-level-help`} className="u-fs-12 muted">{t('autLevelHelp')}</p>
            {pendingPreset ? (
              <div className="u-flex u-flex-wrap u-gap-2">
                <Button variant="primary" size="sm" disabled={busy} onClick={() => void choosePreset(pendingPreset)}>{t('autApplyLevel')}</Button>
                <Button variant="quiet" size="sm" disabled={busy} onClick={() => setPendingPreset(null)}>{t('autCancel')}</Button>
              </div>
            ) : null}
          </fieldset>

          {error ? (
            <Notice variant="error" announce={error.message}>
              {error.message}
              {error.loosened?.length ? <> {t('autLoosenedSteps', { steps: error.loosened.map((c) => classLabel(c.split(':')[0]!, t)).join(', ') })}</> : null}
            </Notice>
          ) : null}

          {editing ? (
            <fieldset className="u-border-0 u-p-0 u-m-0 u-mb-3" disabled={busy}>
              <legend className="u-fw-600 u-mb-2">{t('autApproversLegend')}</legend>
              <div className="u-flex u-flex-wrap u-gap-3">
                {ROLE_CHOICES.map((role) => (
                  <label key={role} className="u-flex u-items-center u-gap-1">
                    <input
                      type="checkbox"
                      checked={roles.includes(role)}
                      onChange={(e) => {
                        const next = e.target.checked ? [...roles, role] : roles.filter((r) => r !== role);
                        if (next.length > 0) { setRoles(next); setRolesTouched(true); }
                      }}
                    />
                    {t(`autRole_${role}`)}
                  </label>
                ))}
              </div>
              <p className="u-fs-12 muted u-mb-0">{t('autApproversHelp')}</p>
            </fieldset>
          ) : null}

          <div className="table-scroll table--stack u-mb-3">
            <table className="data-table" aria-labelledby={headingId}>
              <thead>
                <tr>
                  <th scope="col">{t('autColStep')}</th>
                  <th scope="col">{t('autColOutcome')}</th>
                  <th scope="col">{t('autColApprovers')}</th>
                  <th scope="col">{t('autColAsks')}</th>
                </tr>
              </thead>
              {[...GROUPS, { key: 'autGroupOther', classes: rows.map((r) => r.actionClass).filter((c) => !GROUPED.has(c)) }].map((g) => {
                const groupRows = rows.filter((r) => g.classes.includes(r.actionClass));
                if (groupRows.length === 0) return null;
                return (
                  <tbody key={g.key}>
                    <tr><th scope="rowgroup" colSpan={4} className="u-fs-12 muted">{t(g.key)}</th></tr>
                    {groupRows.map((r) => {
                      const label = `${classLabel(r.actionClass, t)}${r.stage ? ` · ${t(`autStage_${r.stage}`)}` : ''}`;
                      const d = r.rule.default;
                      const esc = r.rule.escalations ?? [];
                      return (
                        <tr key={rowKey(r)}>
                          <th scope="row" className="u-fw-600">
                            <span className="data-stack-label">{t('autColStep')}</span>{label}
                          </th>
                          <td>
                            <span className="data-stack-label">{t('autColOutcome')}</span>
                            {editing ? (
                              <SelectField disabled={busy} label={<span className="sr-only">{t('autOutcomeFor', { step: label })}</span>} className="u-mb-0" value={d.outcome} onChange={(e) => setOutcome(r, e.target.value as Outcome)}>
                                {OUTCOMES.filter((o) => !APPROVE_FLOOR.has(r.actionClass) || SEVERITY[o] >= SEVERITY.approve).map((o) => (
                                  <option key={o} value={o}>{t(`autOutcome_${o.replace('-', '_')}`)}</option>
                                ))}
                              </SelectField>
                            ) : <OutcomeChip outcome={d.outcome} t={t} />}
                          </td>
                          <td><span className="data-stack-label">{t('autColApprovers')}</span>{approversOf(d, t)}</td>
                          <td>
                            <span className="data-stack-label">{t('autColAsks')}</span>
                            {esc.length === 0 ? <span className="muted">—</span> : (
                              <ul className="u-list-none u-p-0 u-m-0 u-grid u-gap-1">
                                {esc.map((e, i) => (
                                  <li key={i} className="u-fs-13">
                                    {editing && e.when.length === 1 && typeof e.when[0]!.value === 'number' ? (
                                      <label className="u-flex u-flex-wrap u-items-center u-gap-1">
                                        {t(`autFact_${e.when[0]!.fact}`)} {e.when[0]!.op}
                                        <input
                                          type="number"
                                          disabled={busy}
                                          className="input"
                                          aria-label={t('autThresholdFor', { step: label, fact: t(`autFact_${e.when[0]!.fact}`) })}
                                          value={String(e.when[0]!.value)}
                                          onChange={(ev) => { if (ev.target.value.trim() === '') return; const v = Number(ev.target.value); if (Number.isFinite(v)) setThreshold(r, i, 0, v); }}
                                        />
                                        → <OutcomeChip outcome={e.then.outcome} t={t} />
                                      </label>
                                    ) : (
                                      <>{e.when.map((c) => conditionText(c, t)).join(t('autAnd'))} → <OutcomeChip outcome={e.then.outcome} t={t} /></>
                                    )}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                );
              })}
            </table>
          </div>
          <p className="u-fs-12 muted u-mt-0">{t('autUnknownFacts')}</p>

          <div className="action-bar u-flex u-flex-wrap u-gap-2 u-mb-3">
            {editing ? (
              <>
                <Button variant="primary" size="sm" disabled={busy || !dirty} onClick={() => void saveCustom()}>{t('autSave')}</Button>
                <Button variant="quiet" size="sm" disabled={busy} onClick={() => { setEditing(false); setDraft({}); setRolesTouched(false); setError(null); }}>{t('autCancel')}</Button>
              </>
            ) : (
              <Button variant="secondary" size="sm" disabled={busy || pendingPreset !== null} onClick={startEditing}>{t('autCustomize')}</Button>
            )}
            {scope.kind === 'campaign' && view.source === 'campaign' && !editing ? (
              <Button variant="quiet" size="sm" disabled={busy} onClick={() => void revertToClientDefault()}>{t('autUseClientDefault')}</Button>
            ) : null}
          </div>

          <details>
            <summary className="u-fw-600">{t('autAlwaysTitle')}</summary>
            <ul className="u-fs-13">
              <li>{t('autAlwaysWorkspace')}</li>
              <li>{t('autAlwaysClient')}</li>
              <li>{t('autAlwaysAgents')}</li>
              <li>{t('autAlwaysForks')}</li>
              <li>{t('autAlwaysPaused')}</li>
              <li>{t('autAlwaysAgentRules')}</li>
              <li>{t('autAlwaysSelf')}</li>
            </ul>
          </details>
        </>
      ) : null}
    </>
  );

  return bare ? <div>{body}</div> : <section className="surface-card u-mb-4" aria-labelledby={headingId}>{body}</section>;
}
