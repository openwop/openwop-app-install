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
import { ROLE_TEMPLATES, roleThemeForKey, type RoleTemplate, type WorkflowOption } from './roleTemplates.js';
import { createUserAgent } from '../client/agentsClient.js';
import { createRosterEntry } from './rosterClient.js';
import { createBoard, type KanbanColumn } from '../kanban/kanbanClient.js';
import { CADENCE_PRESETS, createJob } from './scheduleClient.js';
import { Notice } from '../ui/Notice.js';
import { StructuredPromptEditor } from './StructuredPromptEditor.js';
import { AgentAvatar } from './AgentAvatar.js';
import { PageHeader } from '../ui/PageHeader.js';

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
  { key: 'manual', label: 'Manual only (Check now)' },
  { key: '2m', label: 'Every 2 minutes' },
  { key: '15m', label: 'Every 15 minutes' },
  { key: 'hourly', label: 'Hourly' },
];

/** Heartbeat key → autonomous cadence in ms (0 = manual only). Persisted on the
 *  roster entry; the background heartbeat daemon honors it. */
const HEARTBEAT_INTERVAL_MS: Record<string, number> = {
  manual: 0,
  '2m': 120_000,
  '15m': 900_000,
  hourly: 3_600_000,
};

const MODEL_CLASS_OPTIONS = [
  { key: 'chat', label: 'Chat — general conversation' },
  { key: 'reasoning', label: 'Reasoning — complex multi-step work' },
  { key: 'coding', label: 'Coding — code generation & review' },
  { key: 'extraction', label: 'Extraction — structured data pulls' },
] as const;
type WizardModelClass = (typeof MODEL_CLASS_OPTIONS)[number]['key'];

function StepHeader({ step, title }: { step: number; title: string }): JSX.Element {
  return (
    <div className="u-mb-1-5">
      <div className="muted u-fs-12">Step {step} of 5</div>
      <h2 className="createwiz-step-title">{title}</h2>
    </div>
  );
}

export function AgentCreateWizard(): JSX.Element {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

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
      const t = ROLE_TEMPLATES.find((r) => r.key === roleParam);
      if (t) {
        pickRole(t);
        setName(EXAMPLE_NAMES[t.key] ?? '');
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
    return `You are ${name || 'an assistant'}, a ${roleTitle || 'helpful coworker'}. You are ${tone}; you are ${decisionStyle}; you ${escalation}.`;
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

  // Explain why "Next" is disabled instead of leaving a dead button.
  const nextHint = (): string | null => {
    if (step !== 1 || canNext()) return null;
    if (role === null && !isCustom) return 'Pick a role to continue.';
    if (!name.trim()) return 'Add a name so teammates can assign work.';
    if (!roleTitle.trim()) return 'Add a role title to continue.';
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
        await createBoard({ name: `${name.trim()}'s board`, rosterId: entry.rosterId, columns });
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
    <section>
      <Link to="/agents" className="u-fs-12 muted">← All agents</Link>
      <PageHeader
        eyebrow="Agents"
        title="Create an agent"
        lede="Pick a role, name your coworker, give it a workflow to run, and choose how autonomously it works."
      />

      {error ? <Notice variant="error">{error}</Notice> : null}

      {step === 1 ? (
        <div>
          <StepHeader step={1} title="Pick a role" />
          <p className="muted u-mt-0 u-fs-14">The name is how teammates assign work — pick a human-like name.</p>
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
                  className="createwiz-role-btn"
                  style={{ border: selected ? '2px solid var(--color-accent)' : '1px solid var(--color-border)', background: selected ? 'var(--clay-wash)' : 'var(--color-surface)' }}
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
              className="createwiz-role-btn"
              style={{ border: isCustom ? '2px solid var(--color-accent)' : '1px solid var(--color-border)', background: isCustom ? 'var(--clay-wash)' : 'var(--color-surface)' }}
            >
              <strong className="u-fs-14 u-iflex u-items-center u-gap-1-5">
                <CustomRoleIcon size={15} style={{ color: 'var(--color-accent)' }} /> Custom role
              </strong>
              <div className="muted u-fs-12">Define your own role and workflows.</div>
            </button>
          </div>
          <div className="u-flex u-gap-2 u-wrap">
            <label className="u-flex-1 u-minw-200">
              <div className="u-fs-13 u-fw-600">Name</div>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder={`e.g. ${exampleName}`} className="u-w-full" />
            </label>
            <label className="u-flex-1 u-minw-200">
              <div className="u-fs-13 u-fw-600">Role title</div>
              <input value={roleTitle} onChange={(e) => setRoleTitle(e.target.value)} placeholder="e.g. Sales Ops Assistant" className="u-w-full" />
            </label>
          </div>
        </div>
      ) : null}

      {step === 2 ? (
        <div>
          <StepHeader step={2} title="Persona & instructions" />
          <div className="u-flex u-gap-2 u-wrap u-mb-1-5">
            <label className="u-flex-1 u-minw-160">
              <div className="u-fs-13">Tone</div>
              <input value={tone} onChange={(e) => setTone(e.target.value)} className="u-w-full" />
            </label>
            <label className="u-flex-1 u-minw-160">
              <div className="u-fs-13">Decision style</div>
              <input value={decisionStyle} onChange={(e) => setDecisionStyle(e.target.value)} className="u-w-full" />
            </label>
            <label className="u-flex-1 u-minw-160">
              <div className="u-fs-13">Escalation behavior</div>
              <input value={escalation} onChange={(e) => setEscalation(e.target.value)} className="u-w-full" />
            </label>
          </div>
          <label className="createwiz-model-label">
            <div className="u-fs-13">Model class</div>
            <select value={modelClass} onChange={(e) => setModelClass(e.target.value as WizardModelClass)} className="u-w-full">
              {MODEL_CLASS_OPTIONS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
          </label>
          <div className="u-fs-13 u-fw-600">Instructions (editable)</div>
          <p className="muted u-fs-12 u-mt-0">
            Auto-generated from the role — edit freely. Use the sections, or switch to raw Markdown.
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
          <StepHeader step={3} title="Assign workflows" />
          <p className="muted u-mt-0 u-fs-14">
            {role ? `Recommended for a ${role.title}:` : 'Choose workflows from the library:'}
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
          <Link to="/builder" className="u-fs-13">Create from template →</Link>
        </div>
      ) : null}

      {step === 4 ? (
        <div>
          <StepHeader step={4} title="Board & work sources" />
          <label className="u-flex u-gap-2 u-items-center u-mb-1-5">
            <input type="checkbox" checked={createBoardEnabled} onChange={(e) => setCreateBoardEnabled(e.target.checked)} />
            <span>Create a task board (lanes: To Do · Working · Waiting on Human · Done)</span>
          </label>
          <label className="u-flex u-gap-2 u-items-center u-mb-1-5">
            <input type="checkbox" checked disabled />
            <span className="muted">Human tasks (always on)</span>
          </label>
          <label className="u-flex u-gap-2 u-items-center u-mb-1-5">
            <input type="checkbox" checked disabled />
            <span className="muted">Workflow-created tasks (always on)</span>
          </label>
          <label className="u-flex u-gap-2 u-items-center">
            <input type="checkbox" checked={enableDiscord} onChange={(e) => setEnableDiscord(e.target.checked)} />
            <span>Simulated Discord tasks</span>
          </label>
        </div>
      ) : null}

      {step === 5 ? (
        <div>
          <StepHeader step={5} title="Schedule & heartbeat" />
          <div className="u-fs-13 u-fw-600">Heartbeat</div>
          <p className="muted u-fs-12 u-mt-0">How often {name || 'the agent'} checks its board for new work.</p>
          <select value={heartbeat} onChange={(e) => setHeartbeat(e.target.value)} className="createwiz-mb-08">
            {HEARTBEAT_OPTIONS.map((h) => <option key={h.key} value={h.key}>{h.label}</option>)}
          </select>

          <div className="u-fs-13 u-fw-600">Starting autonomy</div>
          <p className="muted u-fs-12 u-mt-0">
            Supervised agents propose work for your sign-off; autonomous agents start runs immediately. You can change this later.
          </p>
          <div className="action-bar createwiz-mb-08">
            {([['review', 'Supervised — propose for review'], ['guided', 'Guided — asks on high-priority work'], ['auto', 'Autonomous — run immediately']] as const).map(([value, label]) => (
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
              <div className="u-fs-13 u-fw-600">Starter schedule (optional)</div>
              <div className="u-flex u-gap-1-5 u-wrap u-mt-1">
                <select value={scheduleWorkflowId} onChange={(e) => setScheduleWorkflowId(e.target.value)}>
                  <option value="">No starter schedule</option>
                  {[...selectedWorkflows].map((id) => {
                    const wf = (isCustom ? ROLE_TEMPLATES.flatMap((r) => r.workflows) : recommendedWorkflows).find((w) => w.workflowId === id);
                    return <option key={id} value={id}>{wf?.name ?? id}</option>;
                  })}
                </select>
                <select value={scheduleCadence} onChange={(e) => setScheduleCadence(e.target.value)}>
                  {CADENCE_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                </select>
              </div>
            </div>
          ) : null}
          {(() => {
            const wfOptions = isCustom ? ROLE_TEMPLATES.flatMap((r) => r.workflows) : recommendedWorkflows;
            const wfNames = [...selectedWorkflows].map((id) => wfOptions.find((w) => w.workflowId === id)?.name ?? id);
            const prompt = composedPrompt();
            const promptPreview = prompt.length > 160 ? `${prompt.slice(0, 160)}…` : prompt;
            const sources = ['Human tasks', 'Workflow-created tasks', ...(enableDiscord ? ['Simulated Discord'] : [])];
            return (
              <div className="createwiz-review-card">
                <strong>Review &amp; create</strong>
                <div className="createwiz-review-identity">
                  <AgentAvatar persona={name || 'New agent'} roleTheme={roleThemeForKey(role?.key ?? 'custom')} size={40} />
                  <div>
                    <div className="createwiz-review-name">{name || 'Unnamed'}</div>
                    <div className="muted u-fs-13">{roleTitle || 'No role title'}</div>
                  </div>
                </div>
                <dl className="createwiz-review-dl">
                  <dt className="muted">Workflows</dt>
                  <dd className="u-m-0">{wfNames.length ? wfNames.join(', ') : 'None selected'}</dd>
                  <dt className="muted">Board</dt>
                  <dd className="u-m-0">{createBoardEnabled ? 'Task board · To Do / Working / Waiting / Done' : 'No board'}</dd>
                  <dt className="muted">Sources</dt>
                  <dd className="u-m-0">{sources.join(', ')}</dd>
                  <dt className="muted">Heartbeat</dt>
                  <dd className="u-m-0">{HEARTBEAT_OPTIONS.find((h) => h.key === heartbeat)?.label}</dd>
                </dl>
                <div className="createwiz-review-preview">
                  <div className="muted u-fs-12">Instructions preview</div>
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
            <button type="button" className="primary" onClick={() => setStep((s) => s + 1)} disabled={!canNext()}>Next</button>
          ) : (
            <button type="button" className="primary" onClick={() => void onFinish()} disabled={creating}>{creating ? 'Creating…' : 'Create agent'}</button>
          )}
        </div>
      </div>
    </section>
  );
}
