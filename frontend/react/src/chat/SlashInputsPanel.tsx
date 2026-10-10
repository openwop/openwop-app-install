/**
 * ADR 0768 follow-up B2 — a picked `/workflow`'s declared inputs, inline under
 * the command, plus an honest "usually takes" line.
 *
 * Before this, a chat run carried ONE free-text blob, mapped onto the single
 * required input; a workflow declaring two or more could not start from chat at
 * all (CHAT-MENTION-1 refuses in-thread). The form is the shared `RunInputsForm`
 * (the builder + project Run dialog's own renderer, not a second input UI), and
 * the values reach the run through `stageSlashInputs` on send.
 *
 * Shown only when the workflow declares TWO or more non-credential inputs: one
 * input still rides the trailing text (`/summarize <text>`), and a credential
 * input is bound to this chat's key by the dispatch (ADR 0712), never typed here.
 *
 * The estimate line appears only from HISTORY (the tenant's own median cost and
 * p50 duration). A static floor is a model-priced guess, so it is not shown.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { detectWorkflowSlashMention } from './lib/workflowMentions.js';
import { getWorkflowRunInputs, type RunVariable } from '../workflows/workflowsClient.js';
import { fetchFleetStats, fetchWorkflowEstimate } from '../workflows/fleetInsightsClient.js';
import { RunInputsForm, initialRunInputValues, isCredentialRefVariable } from '../ui/RunInputsForm.js';
import { formatDurationMs, formatUsd } from '../i18n/format.js';

export interface SlashInputsState {
  slug: string;
  variables: RunVariable[];
  values: Record<string, unknown>;
}

interface Usual { durationMs: number | null; cost: { usd: number; samples: number } | null }

export function SlashInputsPanel({ text, onChange }: {
  text: string;
  /** The live panel state, or null when no panel applies. */
  onChange: (state: SlashInputsState | null) => void;
}): JSX.Element | null {
  const { t } = useTranslation('chat');
  const match = detectWorkflowSlashMention(text);
  const entry = match?.entry ?? null;
  const workflowId = entry?.workflowId ?? null;
  const [variables, setVariables] = useState<RunVariable[] | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [usual, setUsual] = useState<Usual | null>(null);

  useEffect(() => {
    setVariables(null);
    setUsual(null);
    if (!workflowId) return;
    let live = true;
    getWorkflowRunInputs(workflowId)
      .then((vars) => {
        if (!live) return;
        const typed = vars.filter((v) => !isCredentialRefVariable(v));
        setVariables(typed);
        setValues(initialRunInputValues(typed));
      })
      // A built-in with no stored definition: no panel, the dispatch's own
      // legacy path applies (the same degrade CHAT-MENTION-1 takes).
      .catch(() => { if (live) setVariables([]); });
    // A failed read OMITS the line (it claims nothing); it is never read as "no history".
    void Promise.allSettled([fetchWorkflowEstimate(workflowId), fetchFleetStats()]).then(([e, f]) => {
      if (!live) return;
      const est = e.status === 'fulfilled' ? e.value : null;
      const stats = f.status === 'fulfilled' ? f.value : null;
      const row = stats?.workflows.find((w) => w.workflowId === workflowId);
      const cost = est?.historical ? { usd: est.historical.medianUsd, samples: est.historical.samples } : null;
      setUsual({ durationMs: row?.p50Ms ?? null, cost });
    });
    return () => { live = false; };
  }, [workflowId]);

  const show = entry !== null && variables !== null && variables.length >= 2;
  const state = useMemo<SlashInputsState | null>(
    () => (show && entry && variables ? { slug: entry.slug, variables, values } : null),
    [show, entry, variables, values],
  );
  useEffect(() => { onChange(state); }, [state, onChange]);

  const usualLine = usual && (usual.durationMs !== null || usual.cost)
    ? [
        usual.durationMs !== null ? t('slashUsualDuration', { duration: formatDurationMs(usual.durationMs) }) : null,
        usual.cost ? t('slashUsualCost', { cost: formatUsd(usual.cost.usd), count: usual.cost.samples }) : null,
      ].filter(Boolean).join(' · ')
    : null;

  if (!entry || (!show && !usualLine)) return null;
  return (
    <section className="slash-inputs" aria-label={t('slashInputsLabel', { slug: entry.slug })}>
      {show && variables ? (
        <RunInputsForm
          variables={variables}
          values={values}
          onChange={(name, value) => setValues((prev) => ({ ...prev, [name]: value }))}
        />
      ) : null}
      {usualLine ? <p className="slash-inputs-usual">{usualLine}</p> : null}
    </section>
  );
}
