/**
 * `/agents/new` — guided create-agent wizard (PRD §10). Replaces the raw form
 * with five steps: Role → Persona & Instructions → Workflows → Board & sources
 * → Schedule & heartbeat. No raw ids in the primary surface.
 *
 * On finish it composes the existing host-extension surfaces:
 *   1. POST /v1/host/openwop-app/agents       — a user-authored agent (editable
 *      instructions; agentRef `user.*` so the Instructions tab can edit it)
 *   2. POST /v1/host/openwop-app/roster       — the named agent bound to that agent
 *   3. POST /v1/host/openwop-app/kanban/boards — its task board (4 demo lanes)
 *   4. POST /v1/host/openwop-app/scheduler/jobs — any chosen starter schedules
 * then routes to the new agent's workspace.
 */

import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ROLE_TEMPLATES, roleThemeForKey, type RoleTemplate, type WorkflowOption } from './roleTemplates.js';
import { createUserAgent } from '../client/agentsClient.js';
import { createRosterEntry } from './rosterClient.js';
import { createBoard, type KanbanColumn } from '../kanban/kanbanClient.js';
import { CADENCE_PRESETS, createJob } from './scheduleClient.js';
import { Notice } from '../ui/Notice.js';
import { StructuredPromptEditor } from './StructuredPromptEditor.js';
import { AgentAvatar } from './AgentAvatar.js';
import { PageHeader } from '../ui/PageHeader.js';
import { ArrowLeftIcon } from '../ui/icons/index.js';
import { FormError } from '../ui/Field.js';
import { useFocusTrap } from '../ui/useFocusTrap.js';

const DEMO_LANES: KanbanColumn[] = [
  { id: 'todo', name: 'To Do' },
  { id: 'working', name: 'Working' },
  { id: 'waiting', name: 'Waiting on Human' },
  { id: 'done', name: 'Done' },
];

// Suggested human names per role — a friendly default so the name field reads as
// a coworker rather than a config value (the user edits it). Keyed by the ADR
// 0032 canonical work-twin roleKeys; Chief of Staff (= Iris) is created via the
// assistant path, not this wizard.
const EXAMPLE_NAMES: Record<string, string> = {
  'sales-execution': 'Sawyer',
  'customer-success': 'Casey',
  'finance-close': 'Fiona',
  'it-service-desk': 'Ira',
  'internal-comms': 'Cameron',
  'recruiting-coordinator': 'Riley',
  'people-ops': 'Parker',
  'contract-procurement': 'Quinn',
  'executive-ops': 'Evan',
};

/** Neutral fallback name when a role has no suggestion (e.g. a custom role). */
const FALLBACK_EXAMPLE_NAME = 'Alex';

const HEARTBEAT_OPTIONS = [
  { key: 'manual', labelKey: 'wizHeartbeatManual' },
  { key: '2m', labelKey: 'wizHeartbeat2m' },
  { key: '15m', labelKey: 'wizHeartbeat15m' },
  { key: 'hourly', labelKey: 'wizHeartbeatHourly' },
] as const;

/** Heartbeat key → autonomous cadence in ms (0 = manual only). Persisted on the
 *  roster entry; the background heartbeat daemon honors it. */
const HEARTBEAT_INTERVAL_MS: Record<string, number> = {
  manual: 0,
  '2m': 120_000,
  '15m': 900_000,
  hourly: 3_600_000,
};

const MODEL_CLASS_OPTIONS = [
  { key: 'chat', labelKey: 'wizModelChat' },
  { key: 'reasoning', labelKey: 'wizModelReasoning' },
  { key: 'coding', labelKey: 'wizModelCoding' },
  { key: 'extraction', labelKey: 'wizModelExtraction' },
] as const;
type WizardModelClass = (typeof MODEL_CLASS_OPTIONS)[number]['key'];

function StepHeader({ step, title }: { step: number; title: string }): JSX.Element {
  const { t } = useTranslation('agents');
  // role="status" + aria-live announces the new "Step N of 5: <title>" to screen
  // readers whenever the step changes (AGT-3). The visible text is unchanged; the
  // title is folded into the same live region so the announcement is meaningful.
  return (
    <div className="u-mb-1-5" role="status" aria-live="polite">
      <div className="muted u-fs-12">{t('wizStepOf', { step })}</div>
      <h2 className="createwiz-step-title">{title}</h2>
    </div>
  );
}

export function AgentCreateWizard(): JSX.Element {
  const { t } = useTranslation('agents');
  const navigate = useNavigate();
  // Trap focus inside the wizard for its whole lifetime (AGT-1) so Tab can't
  // escape to the page behind it; lands on the first control and restores on
  // unmount. The ref is attached to the outermost wizard panel below.
  const trapRef = useFocusTrap<HTMLElement>(true);
  const [step, setStep] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // Per-step inline validation (AGT-2): once the user tries to advance/finish
  // with the current step's required fields empty, mark it "attempted" so the
  // offending fields render an error until they're filled.
  const [step1Attempted, setStep1Attempted] = useState(false);

  // Step 1 — role + identity
  const [role, setRole] = useState<RoleTemplate | null>(null);
  const [isCustom, setIsCustom] = useState(false);
  const [name, setName] = useState('');
  const [roleTitle, setRoleTitle] = useState('');

  // Step 2 — persona + instructions
  const [tone, setTone] = useState('friendly and precise');
  const [decisionStyle, setDecisionStyle] = useState('decisive but careful');
  const [escalation, setEscalation] = useState('asks a human before risky actions');
  const [systemPrompt, setSystemPrompt] = useState('');

  // Step 3 — workflows
  const [selectedWorkflows, setSelectedWorkflows] = useState<Set<string>>(new Set());

  // Step 4 — board + sources
  const [createBoardEnabled, setCreateBoardEnabled] = useState(true);
  const [enableDiscord, setEnableDiscord] = useState(true);

  // Step 5 — schedule + heartbeat + autonomy
  const [heartbeat, setHeartbeat] = useState('manual');
  const [autonomy, setAutonomy] = useState<'auto' | 'guided' | 'review'>('auto');
  const [modelClass, setModelClass] = useState<WizardModelClass>('chat');
  const [scheduleWorkflowId, setScheduleWorkflowId] = useState('');
  const [scheduleCadence, setScheduleCadence] = useState(CADENCE_PRESETS[2]!.key); // weekdays

  const recommendedWorkflows: WorkflowOption[] = role?.workflows ?? [];

  // Prefill from the Hire modal's hand-off (?role=<template>&autonomy=) —
  // redesign PR 4: the modal is a fast path IN FRONT of this wizard, never a
  // second creation flow. Runs once; a user-picked role is never overridden.
  const [searchParams] = useSearchParams();
  // Prefill runs exactly once. The guards below previously also checked
  // role/isCustom/name, but those only ever held their initial values at mount
  // (the effect never re-fired), so the ref guard is the real "run once"
  // mechanism and the reads were redundant. Depending only on searchParams
  // keeps exhaustive-deps satisfied without re-firing the prefill on edits.
  const prefilledRef = useRef(false);
  useEffect(() => {
    if (prefilledRef.current) return;
    prefilledRef.current = true;
    const roleParam = searchParams.get('role');
    const autonomyParam = searchParams.get('autonomy');
    if (autonomyParam === 'review' || autonomyParam === 'guided' || autonomyParam === 'auto') setAutonomy(autonomyParam);
    if (roleParam) {
      const tpl = ROLE_TEMPLATES.find((r) => r.key === roleParam);
      if (tpl) {
        pickRole(tpl);
        setName(EXAMPLE_NAMES[tpl.key] ?? '');
      }
    }
  }, [searchParams]);

  const pickRole = (r: RoleTemplate) => {
    setRole(r);
    setIsCustom(false);
    setRoleTitle(r.title);
    setSelectedWorkflows(new Set(r.workflows.map((w) => w.workflowId)));
    setSystemPrompt(r.personaPrompt);
    setScheduleWorkflowId(r.workflows[0]?.workflowId ?? '');
  };

  const pickCustom = () => {
    setRole(null);
    setIsCustom(true);
    setRoleTitle('');
    setSelectedWorkflows(new Set());
    setSystemPrompt('');
  };

  const composedPrompt = (): string => {
    if (systemPrompt.trim()) return systemPrompt.trim();
    return t('wizComposedPrompt', {
      name: name || t('wizComposedNameFallback'),
      role: roleTitle || t('wizComposedRoleFallback'),
      tone,
      decisionStyle,
      escalation,
    });
  };

  const toggleWorkflow = (id: string) => {
    setSelectedWorkflows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const canNext = (): boolean => {
    if (step === 1) return name.trim().length > 0 && roleTitle.trim().length > 0 && (role !== null || isCustom);
    return true;
  };

  // Advance to the next step, but first run the current step's validation. If it
  // fails, mark the step "attempted" so the inline field errors show and stay
  // put (AGT-2). canNext() already gates the button disabled-state too.
  const goNext = (): void => {
    if (step === 1 && !canNext()) {
      setStep1Attempted(true);
      return;
    }
    setStep((s) => s + 1);
  };

  // Per-field error strings for step 1, shown only after an advance attempt.
  const nameError = step1Attempted && !name.trim() ? t('wizHintAddName') : null;
  const roleTitleError = step1Attempted && !roleTitle.trim() ? t('wizHintAddRoleTitle') : null;

  // Explain why "Next" is disabled instead of leaving a dead button.
  const nextHint = (): string | null => {
    if (step !== 1 || canNext()) return null;
    if (role === null && !isCustom) return t('wizHintPickRole');
    if (!name.trim()) return t('wizHintAddName');
    if (!roleTitle.trim()) return t('wizHintAddRoleTitle');
    return null;
  };

  const exampleName = (role && EXAMPLE_NAMES[role.key]) || FALLBACK_EXAMPLE_NAME;
  const CustomRoleIcon = roleThemeForKey('custom').Icon;

  const onFinish = async () => {
    setCreating(true);
    setError(null);
    try {
      const workflows = [...selectedWorkflows];
      // 1. user-authored agent (editable instructions).
      const agent = await createUserAgent({
        persona: name.trim(),
        label: roleTitle.trim(),
        modelClass,
        systemPrompt: composedPrompt(),
      });
      // 2. roster entry bound to that agent. The heartbeat cadence is persisted
      //    so the background daemon auto-runs "Check now" on that interval.
      const heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS[heartbeat] ?? 0;
      const entry = await createRosterEntry({
        persona: name.trim(),
        agentRef: { agentId: agent.agentId },
        workflows,
        label: roleTitle.trim(),
        ...(heartbeatIntervalMs > 0 ? { heartbeatIntervalMs } : {}),
        ...(autonomy !== 'auto' ? { autonomyLevel: autonomy } : {}),
      });
      // 3. board with the 4 standard lanes; To Do triggers the first workflow.
      if (createBoardEnabled) {
        const columns = DEMO_LANES.map((c) =>
          c.id === 'todo' && workflows[0] ? { ...c, triggerWorkflowId: workflows[0] } : { ...c },
        );
        await createBoard({ name: t('wizBoardName', { name: name.trim() }), rosterId: entry.rosterId, columns });
      }
      // 4. optional starter schedule.
      if (heartbeat !== 'manual' && scheduleWorkflowId) {
        const preset = CADENCE_PRESETS.find((p) => p.key === scheduleCadence) ?? CADENCE_PRESETS[0]!;
        await createJob({
          cronExpr: preset.cronExpr,
          workflowId: scheduleWorkflowId,
          rosterId: entry.rosterId,
          agentId: agent.agentId,
          metadata: { label: preset.label },
        });
      }
      navigate(`/agents/${encodeURIComponent(entry.rosterId)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCreating(false);
    }
  };

  return (
    <section ref={trapRef}>
      <Link to="/agents" className="u-fs-12 muted"><ArrowLeftIcon size={12} /> {t('backToAgents')}</Link>
      <PageHeader
        eyebrow={t('templatesEyebrow')}
        title={t('wizTitle')}
        lede={t('wizLede')}
      />

      {error ? <Notice variant="error">{error}</Notice> : null}

      {step === 1 ? (
        <div>
          <StepHeader step={1} title={t('wizStep1Title')} />
          <p className="muted u-mt-0 u-fs-14">{t('wizStep1Lede')}</p>
          <div className="createwiz-role-grid">
            {ROLE_TEMPLATES.map((r) => {
              const RoleIcon = roleThemeForKey(r.key).Icon;
              const selected = role?.key === r.key;
              return (
                <button
                  key={r.key}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => pickRole(r)}
                  // TODO(UX AGT-4): needs .createwiz-role-btn (base border/bg) +
                  // .createwiz-role-btn.is-selected (accent border + clay-wash) in
                  // global.css — moved off the token-valued inline style.
                  className={selected ? 'createwiz-role-btn is-selected' : 'createwiz-role-btn'}
                >
                  <strong className="u-fs-14 u-iflex u-items-center u-gap-1-5">
                    <RoleIcon size={15} style={{ color: 'var(--color-accent)' }} /> {r.title}
                  </strong>
                  <div className="muted u-fs-12">{r.blurb}</div>
                </button>
              );
            })}
            <button
              type="button"
              aria-pressed={isCustom}
              onClick={pickCustom}
              // TODO(UX AGT-4): see .createwiz-role-btn.is-selected note above.
              className={isCustom ? 'createwiz-role-btn is-selected' : 'createwiz-role-btn'}
            >
              <strong className="u-fs-14 u-iflex u-items-center u-gap-1-5">
                <CustomRoleIcon size={15} style={{ color: 'var(--color-accent)' }} /> {t('wizCustomRole')}
              </strong>
              <div className="muted u-fs-12">{t('wizCustomRoleBlurb')}</div>
            </button>
          </div>
          <div className="u-flex u-gap-2 u-wrap">
            <label className="u-flex-1 u-minw-200">
              <div className="u-fs-13 u-fw-600">{t('wizName')}</div>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('wizNamePlaceholder', { example: exampleName })}
                className="u-w-full"
                required
                aria-required="true"
                {...(nameError ? { 'aria-invalid': true } : {})}
              />
              <FormError>{nameError}</FormError>
            </label>
            <label className="u-flex-1 u-minw-200">
              <div className="u-fs-13 u-fw-600">{t('wizRoleTitle')}</div>
              <input
                value={roleTitle}
                onChange={(e) => setRoleTitle(e.target.value)}
                placeholder={t('wizRoleTitlePlaceholder')}
                className="u-w-full"
                required
                aria-required="true"
                {...(roleTitleError ? { 'aria-invalid': true } : {})}
              />
              <FormError>{roleTitleError}</FormError>
            </label>
          </div>
        </div>
      ) : null}

      {step === 2 ? (
        <div>
          <StepHeader step={2} title={t('wizStep2Title')} />
          <div className="u-flex u-gap-2 u-wrap u-mb-1-5">
            <label className="u-flex-1 u-minw-160">
              <div className="u-fs-13">{t('wizTone')}</div>
              <input value={tone} onChange={(e) => setTone(e.target.value)} className="u-w-full" />
            </label>
            <label className="u-flex-1 u-minw-160">
              <div className="u-fs-13">{t('wizDecisionStyle')}</div>
              <input value={decisionStyle} onChange={(e) => setDecisionStyle(e.target.value)} className="u-w-full" />
            </label>
            <label className="u-flex-1 u-minw-160">
              <div className="u-fs-13">{t('wizEscalation')}</div>
              <input value={escalation} onChange={(e) => setEscalation(e.target.value)} className="u-w-full" />
            </label>
          </div>
          <label className="createwiz-model-label">
            <div className="u-fs-13">{t('wizModelClassLabel')}</div>
            <select value={modelClass} onChange={(e) => setModelClass(e.target.value as WizardModelClass)} className="u-w-full">
              {MODEL_CLASS_OPTIONS.map((m) => <option key={m.key} value={m.key}>{t(m.labelKey)}</option>)}
            </select>
          </label>
          <div className="u-fs-13 u-fw-600">{t('wizInstructionsLabel')}</div>
          <p className="muted u-fs-12 u-mt-0">
            {t('wizInstructionsHint')}
          </p>
          <StructuredPromptEditor
            key={role?.key ?? (isCustom ? 'custom' : 'none')}
            value={systemPrompt}
            onChange={setSystemPrompt}
          />
        </div>
      ) : null}

      {step === 3 ? (
        <div>
          <StepHeader step={3} title={t('wizStep3Title')} />
          <p className="muted u-mt-0 u-fs-14">
            {role ? t('wizStep3Recommended', { role: role.title }) : t('wizStep3Choose')}
          </p>
          <div className="u-flex u-flex-col u-gap-1-5">
            {(isCustom ? ROLE_TEMPLATES.flatMap((r) => r.workflows) : recommendedWorkflows).map((w) => (
              <label key={w.workflowId} htmlFor={`wizard-workflow-${w.workflowId}`} className="createwiz-workflow-row">
                <input id={`wizard-workflow-${w.workflowId}`} type="checkbox" checked={selectedWorkflows.has(w.workflowId)} onChange={() => toggleWorkflow(w.workflowId)} aria-label={w.name} />
                <span>
                  <strong className="u-fs-14">{w.name}</strong>
                  <div className="muted u-fs-12">{w.purpose}</div>
                </span>
              </label>
            ))}
          </div>
          <Link to="/builder" className="u-fs-13">{t('wizCreateFromTemplate')}</Link>
        </div>
      ) : null}

      {step === 4 ? (
        <div>
          <StepHeader step={4} title={t('wizStep4Title')} />
          <label className="u-flex u-gap-2 u-items-center u-mb-1-5">
            <input type="checkbox" checked={createBoardEnabled} onChange={(e) => setCreateBoardEnabled(e.target.checked)} />
            <span>{t('wizCreateBoard')}</span>
          </label>
          <label className="u-flex u-gap-2 u-items-center u-mb-1-5">
            <input type="checkbox" checked disabled />
            <span className="muted">{t('wizHumanTasks')}</span>
          </label>
          <label className="u-flex u-gap-2 u-items-center u-mb-1-5">
            <input type="checkbox" checked disabled />
            <span className="muted">{t('wizWorkflowTasks')}</span>
          </label>
          <label className="u-flex u-gap-2 u-items-center">
            <input type="checkbox" checked={enableDiscord} onChange={(e) => setEnableDiscord(e.target.checked)} />
            <span>{t('wizSimulatedDiscord')}</span>
          </label>
        </div>
      ) : null}

      {step === 5 ? (
        <div>
          <StepHeader step={5} title={t('wizStep5Title')} />
          <div className="u-fs-13 u-fw-600">{t('wizHeartbeatHeading')}</div>
          <p className="muted u-fs-12 u-mt-0">{t('wizHeartbeatHint', { name: name || 'the agent' })}</p>
          <select value={heartbeat} onChange={(e) => setHeartbeat(e.target.value)} className="createwiz-mb-08">
            {HEARTBEAT_OPTIONS.map((h) => <option key={h.key} value={h.key}>{t(h.labelKey)}</option>)}
          </select>

          <div className="u-fs-13 u-fw-600">{t('wizStartingAutonomy')}</div>
          <p className="muted u-fs-12 u-mt-0">
            {t('wizAutonomyHint')}
          </p>
          <div className="action-bar createwiz-mb-08">
            {([['review', t('wizAutonomySupervised')], ['guided', t('wizAutonomyGuided')], ['auto', t('wizAutonomyAutonomous')]] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={autonomy === value ? 'primary btn-sm' : 'secondary btn-sm'}
                aria-pressed={autonomy === value}
                onClick={() => setAutonomy(value)}
              >
                {label}
              </button>
            ))}
          </div>
          {heartbeat !== 'manual' && selectedWorkflows.size > 0 ? (
            <div>
              <div className="u-fs-13 u-fw-600">{t('wizStarterSchedule')}</div>
              <div className="u-flex u-gap-1-5 u-wrap u-mt-1">
                <select value={scheduleWorkflowId} onChange={(e) => setScheduleWorkflowId(e.target.value)}>
                  <option value="">{t('wizNoStarterSchedule')}</option>
                  {[...selectedWorkflows].map((id) => {
                    const wf = (isCustom ? ROLE_TEMPLATES.flatMap((r) => r.workflows) : recommendedWorkflows).find((w) => w.workflowId === id);
                    return <option key={id} value={id}>{wf?.name ?? id}</option>;
                  })}
                </select>
                {/* Cadence only matters once a starter workflow is chosen — and
                    the whole block is hidden when heartbeat is "manual" (AGT-5). */}
                {scheduleWorkflowId ? (
                  <select value={scheduleCadence} onChange={(e) => setScheduleCadence(e.target.value)}>
                    {CADENCE_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                  </select>
                ) : null}
              </div>
            </div>
          ) : null}
          {(() => {
            const wfOptions = isCustom ? ROLE_TEMPLATES.flatMap((r) => r.workflows) : recommendedWorkflows;
            const wfNames = [...selectedWorkflows].map((id) => wfOptions.find((w) => w.workflowId === id)?.name ?? id);
            const prompt = composedPrompt();
            const promptPreview = prompt.length > 160 ? `${prompt.slice(0, 160)}…` : prompt;
            const sources = [t('wizReviewSourceHuman'), t('wizReviewSourceWorkflow'), ...(enableDiscord ? [t('wizReviewSourceDiscord')] : [])];
            const heartbeatOption = HEARTBEAT_OPTIONS.find((h) => h.key === heartbeat);
            return (
              <div className="createwiz-review-card">
                <strong>{t('wizReviewCreate')}</strong>
                <div className="createwiz-review-identity">
                  <AgentAvatar persona={name || t('wizReviewNewAgent')} roleTheme={roleThemeForKey(role?.key ?? 'custom')} size={40} />
                  <div>
                    <div className="createwiz-review-name">{name || t('wizReviewUnnamed')}</div>
                    <div className="muted u-fs-13">{roleTitle || t('wizReviewNoRoleTitle')}</div>
                  </div>
                </div>
                <dl className="createwiz-review-dl">
                  <dt className="muted">{t('wizReviewWorkflows')}</dt>
                  <dd className="u-m-0">{wfNames.length ? wfNames.join(', ') : t('wizReviewNoneSelected')}</dd>
                  <dt className="muted">{t('wizReviewBoard')}</dt>
                  <dd className="u-m-0">{createBoardEnabled ? t('wizReviewBoardYes') : t('wizReviewBoardNo')}</dd>
                  <dt className="muted">{t('wizReviewSources')}</dt>
                  <dd className="u-m-0">{sources.join(', ')}</dd>
                  <dt className="muted">{t('wizReviewHeartbeat')}</dt>
                  <dd className="u-m-0">{heartbeatOption ? t(heartbeatOption.labelKey) : ''}</dd>
                </dl>
                <div className="createwiz-review-preview">
                  <div className="muted u-fs-12">{t('wizReviewInstructionsPreview')}</div>
                  <div className="createwiz-review-preview-text">{promptPreview}</div>
                </div>
              </div>
            );
          })()}
        </div>
      ) : null}

      <div className="createwiz-footer-nav">
        <button type="button" className="secondary" onClick={() => setStep((s) => Math.max(1, s - 1))} disabled={step === 1 || creating}>Back</button>
        <div className="u-flex u-items-center u-gap-2-5">
          {nextHint() ? <span className="muted u-fs-13">{nextHint()}</span> : null}
          {step < 5 ? (
            // Next stays ENABLED so an invalid step-1 click runs goNext(), which
            // flips `step1Attempted` and surfaces the inline field errors (AGT-2).
            // Disabling it under the same predicate that gates the errors would
            // make those errors unreachable. goNext() blocks the advance itself,
            // and nextHint() (above) explains why an invalid step won't advance.
            <button type="button" className="primary" onClick={goNext}>{t('wizNext')}</button>
          ) : (
            <button type="button" className="primary" onClick={() => void onFinish()} disabled={creating}>{creating ? t('wizCreating') : t('wizCreateAgentBtn')}</button>
          )}
        </div>
      </div>
    </section>
  );
}
