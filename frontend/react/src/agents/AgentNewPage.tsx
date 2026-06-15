/**
 * Create-agent form — `/agents/new` (phase E2).
 *
 * Posts to `POST /v1/host/openwop-app/agents` (phase E1 endpoint) and
 * navigates to the new agent's detail view on success.
 *
 * Form fields mirror the BE validator in `routes/userAgents.ts`:
 *   - persona       (required, ≤64 chars)
 *   - label         (optional, ≤80 chars)
 *   - description   (optional, ≤280 chars)
 *   - modelClass    (required, enum)
 *   - systemPrompt  (required, ≤16k chars; textarea, monospace)
 *   - toolAllowlist (optional, 0-32 entries; comma-separated input)
 *   - memoryShape   (three toggles)
 *   - confidenceThreshold (optional, 0.0-1.0)
 *
 * `?fork=<agentId>` query param prefills the form from an existing
 * agent (phase E4 fork flow). Inline validation matches the BE
 * rules so the user gets immediate feedback rather than a server
 * round-trip.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  createUserAgent,
  getAgent,
  type CreateUserAgentInput,
} from '../client/agentsClient.js';
import { PageHeader } from '../ui/PageHeader.js';

const MODEL_CLASSES = ['chat', 'reasoning', 'coding', 'extraction'] as const;
type ModelClass = (typeof MODEL_CLASSES)[number];

interface FormState {
  persona: string;
  label: string;
  description: string;
  modelClass: ModelClass;
  systemPrompt: string;
  toolAllowlistRaw: string; // user-typed; parsed on submit
  scratchpad: boolean;
  conversation: boolean;
  longTerm: boolean;
  confidenceThresholdRaw: string; // user-typed; parsed on submit
}

const INITIAL: FormState = {
  persona: '',
  label: '',
  description: '',
  modelClass: 'chat',
  systemPrompt: '',
  toolAllowlistRaw: '',
  scratchpad: false,
  conversation: false,
  longTerm: false,
  confidenceThresholdRaw: '',
};

export function AgentNewPage(): JSX.Element {
  const [form, setForm] = useState<FormState>(INITIAL);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const forkSource = searchParams.get('fork');

  // Fork: prefill the form from an existing agent. The
  // `systemPrompt` field is NOT projected over the inventory surface
  // (RFC 0072 §A SR-1), so a fork of a pack-installed agent starts
  // with an empty system prompt — the user has to write their own.
  // A fork of a user-authored agent COULD prefill systemPrompt if we
  // exposed a separate `GET /v1/host/openwop-app/agents/:id?include=systemPrompt`
  // surface; for now the limitation is consistent across both sources.
  useEffect(() => {
    if (!forkSource) return;
    let cancelled = false;
    void (async () => {
      try {
        const agent = await getAgent(forkSource);
        if (cancelled || !agent) return;
        setForm((prev) => ({
          ...prev,
          persona: `${agent.persona} (fork)`,
          label: agent.label && agent.label !== agent.persona
            ? `${agent.label} (fork)`
            : prev.label,
          description: agent.description ?? prev.description,
          modelClass: (MODEL_CLASSES.includes(agent.modelClass as ModelClass)
            ? agent.modelClass
            : 'chat') as ModelClass,
          toolAllowlistRaw: agent.toolAllowlist.join(', '),
          scratchpad: agent.memoryShape?.scratchpad === true,
          conversation: agent.memoryShape?.conversation === true,
          longTerm: agent.memoryShape?.longTerm === true,
          confidenceThresholdRaw:
            agent.confidenceThreshold !== undefined
              ? String(agent.confidenceThreshold)
              : '',
        }));
      } catch {
        // Silent — the user can still fill out the form by hand.
      }
    })();
    return () => { cancelled = true; };
  }, [forkSource]);

  const validation = useMemo(() => validate(form), [form]);

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!validation.ok) {
      setError(validation.reason);
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      const input: CreateUserAgentInput = validation.input;
      const created = await createUserAgent(input);
      navigate(`/agents/templates/${encodeURIComponent(created.agentId)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setIsSubmitting(false);
    }
  }

  return (
    <section>
      <div className="u-mb-3">
        <Link to="/agents" className="u-fs-12 u-ink-3">
          ← All agents
        </Link>
      </div>
      <PageHeader
        eyebrow="Agents"
        title={forkSource ? 'Fork agent' : 'Author new agent'}
        lede={
          forkSource
            ? `Customize a copy of an existing agent. System prompts aren't projected over the read API — you'll write a new one.`
            : `Define a persona, give it a system prompt, and pick a model class. The agent shows up in the @-mention picker for every chat in this tenant.`
        }
      />

      <form onSubmit={onSubmit} className="u-flex u-flex-col u-gap-3">
        <Field label="Persona" hint="Short name. Becomes the @-mention slug + the chat panel label.">
          <input
            type="text"
            value={form.persona}
            onChange={(e) => setForm({ ...form, persona: e.target.value })}
            maxLength={64}
            required
            placeholder="e.g. Code Reviewer"
            className="agentnew-input"
          />
        </Field>

        <Field label="Label" hint="Longer display name. Defaults to the persona when blank.">
          <input
            type="text"
            value={form.label}
            onChange={(e) => setForm({ ...form, label: e.target.value })}
            maxLength={80}
            placeholder="e.g. Diff-aware code review agent"
            className="agentnew-input"
          />
        </Field>

        <Field label="Description" hint="One-line summary shown in the agents list.">
          <textarea
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            maxLength={280}
            rows={2}
            placeholder="What this agent is for and when to use it."
            className="agentnew-input agentnew-textarea"
          />
        </Field>

        <Field label="Model class" hint="Which capability tier this agent expects (chat = general, reasoning = thinking budget, coding = code-aware, extraction = structured-output).">
          <select
            value={form.modelClass}
            onChange={(e) => setForm({ ...form, modelClass: e.target.value as ModelClass })}
            className="agentnew-input"
          >
            {MODEL_CLASSES.map((mc) => (
              <option key={mc} value={mc}>{mc}</option>
            ))}
          </select>
        </Field>

        <Field
          label="System prompt"
          hint="The agent's personality + behavior contract. Prepended as the system message on every turn routed through this agent."
        >
          <textarea
            value={form.systemPrompt}
            onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
            maxLength={16000}
            rows={12}
            required
            placeholder="You are a senior reviewer. Cite file:line for every finding. Bias toward..."
            className="agentnew-input agentnew-prompt"
          />
        </Field>

        <Field label="Tool allowlist" hint="Comma-separated capability ids. Empty = pure-completion agent with no function-call surface.">
          <input
            type="text"
            value={form.toolAllowlistRaw}
            onChange={(e) => setForm({ ...form, toolAllowlistRaw: e.target.value })}
            placeholder="openwop:core.files.read, openwop:core.openwop.http.fetch"
            className="agentnew-input agentnew-mono"
          />
        </Field>

        <Field label="Memory shape" hint="Which memory tiers this agent uses. Inert today on the reference app — surfaced for forward-compat.">
          <div className="u-flex u-gap-4 u-mt-1">
            <Checkbox
              checked={form.scratchpad}
              onChange={(v) => setForm({ ...form, scratchpad: v })}
              label="Scratchpad"
            />
            <Checkbox
              checked={form.conversation}
              onChange={(v) => setForm({ ...form, conversation: v })}
              label="Conversation"
            />
            <Checkbox
              checked={form.longTerm}
              onChange={(v) => setForm({ ...form, longTerm: v })}
              label="Long-term"
            />
          </div>
        </Field>

        <Field
          label="Confidence threshold"
          hint="0.0-1.0. The agent declares decisions below this score as low-confidence. Leave blank to skip."
        >
          <input
            type="number"
            value={form.confidenceThresholdRaw}
            onChange={(e) => setForm({ ...form, confidenceThresholdRaw: e.target.value })}
            min={0}
            max={1}
            step={0.05}
            placeholder="0.7"
            className="agentnew-input agentnew-w120"
          />
        </Field>

        {error && (
          <div
            role="alert"
            className="agentnew-error"
          >
            {error}
          </div>
        )}

        <div className="u-flex u-gap-2 u-mt-2">
          <button
            type="submit"
            className="primary"
            disabled={!validation.ok || isSubmitting}
          >
            {isSubmitting ? 'Saving…' : forkSource ? 'Save fork' : 'Create agent'}
          </button>
          <Link
            to="/agents"
            className="agentnew-cancel"
          >
            Cancel
          </Link>
        </div>
      </form>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <label className="u-flex u-flex-col u-gap-1">
      <span className="u-fs-12 u-fw-500">{label}</span>
      {hint && (
        <span className="muted agentnew-hint">{hint}</span>
      )}
      {children}
    </label>
  );
}

function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}): JSX.Element {
  return (
    <label className="u-flex u-items-center u-gap-1-5 u-fs-13">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

type ValidationResult =
  | { ok: true; input: CreateUserAgentInput }
  | { ok: false; reason: string };

function validate(form: FormState): ValidationResult {
  if (form.persona.trim().length === 0) {
    return { ok: false, reason: 'Persona is required.' };
  }
  if (form.systemPrompt.trim().length === 0) {
    return { ok: false, reason: 'System prompt is required.' };
  }
  const toolAllowlist = form.toolAllowlistRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (toolAllowlist.length > 32) {
    return { ok: false, reason: 'Tool allowlist supports at most 32 entries.' };
  }
  let confidenceThreshold: number | undefined;
  if (form.confidenceThresholdRaw.trim().length > 0) {
    const n = Number(form.confidenceThresholdRaw);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      return { ok: false, reason: 'Confidence threshold must be a number between 0 and 1.' };
    }
    confidenceThreshold = n;
  }
  const input: CreateUserAgentInput = {
    persona: form.persona.trim(),
    modelClass: form.modelClass,
    systemPrompt: form.systemPrompt,
    toolAllowlist,
    memoryShape: {
      scratchpad: form.scratchpad,
      conversation: form.conversation,
      longTerm: form.longTerm,
    },
    ...(form.label.trim().length > 0 ? { label: form.label.trim() } : {}),
    ...(form.description.trim().length > 0 ? { description: form.description.trim() } : {}),
    ...(confidenceThreshold !== undefined ? { confidenceThreshold } : {}),
  };
  return { ok: true, input };
}
