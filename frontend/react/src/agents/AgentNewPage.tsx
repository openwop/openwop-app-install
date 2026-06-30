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
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  createUserAgent,
  getAgent,
  type CreateUserAgentInput,
} from '../client/agentsClient.js';
import { PageHeader } from '../ui/PageHeader.js';
import { TextField, TextareaField, SelectField, CheckboxField } from '../ui/Field.js';
import { ArrowLeftIcon } from '../ui/icons/index.js';

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
  const { t } = useTranslation('agents');
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
          persona: t('newForkSuffixedName', { name: agent.persona }),
          label: agent.label && agent.label !== agent.persona
            ? t('newForkSuffixedName', { name: agent.label })
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
  }, [forkSource, t]);

  const validation = useMemo(() => validate(form, t), [form, t]);

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
          <ArrowLeftIcon size={12} /> {t('newBack')}
        </Link>
      </div>
      <PageHeader
        eyebrow={t('newEyebrow')}
        title={forkSource ? t('newForkTitle') : t('newAuthorTitle')}
        lede={
          forkSource
            ? t('newForkLede')
            : t('newAuthorLede')
        }
      />

      <form onSubmit={onSubmit} className="u-flex u-flex-col u-gap-3">
        <TextField
          label={t('newPersona')}
          help={t('newPersonaHint')}
          value={form.persona}
          onChange={(e) => setForm({ ...form, persona: e.target.value })}
          maxLength={64}
          required
          placeholder={t('newPersonaPlaceholder')}
        />

        <TextField
          label={t('newLabel')}
          help={t('newLabelHint')}
          value={form.label}
          onChange={(e) => setForm({ ...form, label: e.target.value })}
          maxLength={80}
          placeholder={t('newLabelPlaceholder')}
        />

        <TextareaField
          label={t('newDescription')}
          help={t('newDescriptionHint')}
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          maxLength={280}
          rows={2}
          placeholder={t('newDescriptionPlaceholder')}
        />

        <SelectField
          label={t('newModelClass')}
          help={t('newModelClassHint')}
          value={form.modelClass}
          onChange={(e) => setForm({ ...form, modelClass: e.target.value as ModelClass })}
        >
          {MODEL_CLASSES.map((mc) => (
            <option key={mc} value={mc}>{mc}</option>
          ))}
        </SelectField>

        <TextareaField
          className="agentnew-prompt-field"
          label={t('newSystemPrompt')}
          help={t('newSystemPromptHint')}
          value={form.systemPrompt}
          onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
          maxLength={16000}
          rows={12}
          required
          placeholder={t('newSystemPromptPlaceholder')}
        />

        <TextField
          className="agentnew-mono-field"
          label={t('newToolAllowlist')}
          help={t('newToolAllowlistHint')}
          value={form.toolAllowlistRaw}
          onChange={(e) => setForm({ ...form, toolAllowlistRaw: e.target.value })}
          placeholder="openwop:core.files.read, openwop:core.openwop.http.fetch"
        />

        <div className="field" role="group" aria-labelledby="agentnew-memshape-label">
          <span className="field-label" id="agentnew-memshape-label">{t('newMemoryShape')}</span>
          <div className="u-flex u-gap-4 u-mt-1">
            <CheckboxField
              checked={form.scratchpad}
              onChange={(e) => setForm({ ...form, scratchpad: e.target.checked })}
              label={t('newMemoryScratchpad')}
            />
            <CheckboxField
              checked={form.conversation}
              onChange={(e) => setForm({ ...form, conversation: e.target.checked })}
              label={t('newMemoryConversation')}
            />
            <CheckboxField
              checked={form.longTerm}
              onChange={(e) => setForm({ ...form, longTerm: e.target.checked })}
              label={t('newMemoryLongTerm')}
            />
          </div>
          <div className="field-help">{t('newMemoryShapeHint')}</div>
        </div>

        <TextField
          className="agentnew-w120-field"
          type="number"
          label={t('newConfidenceThreshold')}
          help={t('newConfidenceThresholdHint')}
          value={form.confidenceThresholdRaw}
          onChange={(e) => setForm({ ...form, confidenceThresholdRaw: e.target.value })}
          min={0}
          max={1}
          step={0.05}
          placeholder="0.7"
        />

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
            {isSubmitting ? t('newSaving') : forkSource ? t('newSaveFork') : t('newCreateAgent')}
          </button>
          <Link
            to="/agents"
            className="agentnew-cancel"
          >
            {t('newCancel')}
          </Link>
        </div>
      </form>
    </section>
  );
}

type ValidationResult =
  | { ok: true; input: CreateUserAgentInput }
  | { ok: false; reason: string };

function validate(form: FormState, t: TFunction): ValidationResult {
  if (form.persona.trim().length === 0) {
    return { ok: false, reason: t('newErrorPersonaRequired') };
  }
  if (form.systemPrompt.trim().length === 0) {
    return { ok: false, reason: t('newErrorPromptRequired') };
  }
  const toolAllowlist = form.toolAllowlistRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (toolAllowlist.length > 32) {
    return { ok: false, reason: t('newErrorTooManyTools') };
  }
  let confidenceThreshold: number | undefined;
  if (form.confidenceThresholdRaw.trim().length > 0) {
    const n = Number(form.confidenceThresholdRaw);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      return { ok: false, reason: t('newErrorConfidenceRange') };
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
