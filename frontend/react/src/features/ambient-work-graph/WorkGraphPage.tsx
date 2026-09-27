/**
 * ADR 0137 Phase 4 — the Ambient Work Graph suggestions page (admin).
 *
 * Org picker → recurring work-pattern suggestions ("you've done this N times — make it a
 * workflow?"). Each card shows the tool-sequence pattern + recurrence count + an evidence
 * line (example runs, sample goal). Accept hands a draftSeed to the EXISTING chat-driven
 * workflow-author (navigates to /builder with the seed in router state — no second author).
 * Dismiss hides it (persisted; never resurrected by a re-sweep). Refresh runs a sweep.
 *
 * @see docs/adr/0137-ambient-work-graph.md
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { toast } from '../../ui/toast.js';
import { SparklesIcon } from '../../ui/icons/index.js';
import { listOrgs, listSuggestions, refreshSuggestions, dismissSuggestion, acceptSuggestion, type Org, type WorkflowSuggestion } from './workGraphClient.js';

// §4.5 collection kit — the status facet covers the statuses a suggestion can
// surface with (dismissed ones are removed from the list, never shown). Labels
// reuse the existing status copy so they can't drift from the row chips.
const STATUS_FACETS = [
  { value: 'suggested', labelKey: 'statusSuggested' },
  { value: 'accepted', labelKey: 'statusAccepted' },
] as const;

export function WorkGraphPage(): JSX.Element {
  const { t } = useTranslation('ambient-work-graph');
  const navigate = useNavigate();
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [orgId, setOrgId] = useState('');
  const [suggestions, setSuggestions] = useState<WorkflowSuggestion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // §4.5 collection kit — status facet feeding a separate memo over the
  // unfiltered suggestions.
  const [statusFilter, setStatusFilter] = useState<'' | 'suggested' | 'accepted'>('');
  const visibleSuggestions = useMemo(
    () => (suggestions ?? []).filter((s) => !statusFilter || s.status === statusFilter),
    [suggestions, statusFilter],
  );

  useEffect(() => {
    void listOrgs().then((o) => { setOrgs(o); setOrgId((cur) => cur || (o[0]?.orgId ?? '')); })
      .catch((e) => setError(e instanceof Error ? e.message : t('loadOrgsFailed', { defaultValue: 'Failed to load organizations.' })));
  }, [t]);

  const load = useCallback((org: string) => {
    void listSuggestions(org).then((rows) => { setSuggestions(rows); setError(null); })
      .catch((e) => setError(e instanceof Error ? e.message : t('loadFailed', { defaultValue: 'Failed to load suggestions.' })));
  }, [t]);
  useEffect(() => { if (orgId) load(orgId); }, [orgId, load]);

  const refresh = async (): Promise<void> => {
    setBusy(true);
    try { setSuggestions(await refreshSuggestions(orgId)); toast.success(t('refreshed', { defaultValue: 'Scanned your recent runs' })); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('refreshFailed', { defaultValue: 'Failed to scan runs.' })); } finally { setBusy(false); }
  };
  const dismiss = async (id: string): Promise<void> => {
    setBusy(true);
    try { await dismissSuggestion(orgId, id); setSuggestions((cur) => (cur ?? []).filter((s) => s.suggestionId !== id)); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('dismissFailed', { defaultValue: 'Failed to dismiss the suggestion.' })); } finally { setBusy(false); }
  };
  const accept = async (s: WorkflowSuggestion): Promise<void> => {
    setBusy(true);
    try {
      const draftSeed = await acceptSuggestion(orgId, s.suggestionId);
      toast.success(t('accepted', { defaultValue: 'Opening the workflow author…' }));
      navigate('/builder', { state: { workGraphSeed: draftSeed } });
    } catch (e) { toast.error(e instanceof Error ? e.message : t('acceptFailed', { defaultValue: 'Failed to open the workflow author.' })); }
    finally { setBusy(false); }
  };

  if (orgs && orgs.length === 0) {
    return <StateCard icon={<SparklesIcon size={28} />} title={t('noOrgsTitle', { defaultValue: 'No organizations' })} body={t('noOrgsBody', { defaultValue: 'Create an organization to see work-pattern suggestions.' })} />;
  }

  // AWG-R2-1 — a failed FIRST read used to leave this early-return showing the
  // loading card forever (the error was set but never reachable below it):
  // failure-as-LOADING. Two prior passes graded this page "clean" by checking
  // the error was SET — neither checked it could RENDER.
  if (suggestions === null) {
    if (error) {
      return (
        <StateCard
          icon={<SparklesIcon size={28} />}
          title={t('loadFailedTitle', { defaultValue: 'Couldn’t load work patterns' })}
          body={error}
          announce
          action={<Button variant="secondary" onClick={() => { setError(null); if (orgId) load(orgId); }}>{t('retry', { defaultValue: 'Retry' })}</Button>}
        />
      );
    }
    return <StateCard loading title={t('loading', { defaultValue: 'Loading…' })} />;
  }

  return (
    <div data-walkthrough="work-patterns.page" className="u-flex u-flex-col u-gap-3">
      <PageHeader eyebrow={t('eyebrow', { defaultValue: 'Automation' })} title={t('title', { defaultValue: 'Work patterns' })} lede={t('lede', { defaultValue: 'Recurring work across your recent runs — turn a repeated pattern into a reusable workflow. Tool-shape only; nothing is shared across organizations.' })} />
      {error && <Notice variant="error">{error}</Notice>}

      <div className="u-flex u-items-center u-gap-2 u-fs-12">
        <label className="u-flex u-items-center u-gap-2">
          {t('org', { defaultValue: 'Organization' })}
          <select value={orgId} onChange={(e) => setOrgId(e.target.value)} aria-label={t('org', { defaultValue: 'Organization' })}>
            {(orgs ?? []).map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
          </select>
        </label>
        <Button variant="secondary" className="u-fs-11" disabled={busy || !orgId} onClick={refresh}>{t('refresh', { defaultValue: 'Scan now' })}</Button>
      </div>

      {suggestions.length > 3 ? (
        <div className="filterbar" role="group" aria-label={t('filterGroup', { defaultValue: 'Filters' })}>
          <select
            className="ui-input filterbar-select"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as '' | 'suggested' | 'accepted')}
            aria-label={t('filterStatusLabel', { defaultValue: 'Filter by status' })}
          >
            <option value="">{t('allStatuses', { defaultValue: 'All statuses' })}</option>
            {STATUS_FACETS.map((s) => <option key={s.value} value={s.value}>{t(s.labelKey, { defaultValue: s.value })}</option>)}
          </select>
        </div>
      ) : null}

      {suggestions.length === 0 ? (
        <StateCard icon={<SparklesIcon size={28} />} title={t('emptyTitle', { defaultValue: 'No patterns yet' })} body={t('emptyBody', { defaultValue: 'Once you repeat a multi-step task a few times, it’ll show up here as a workflow suggestion.' })} />
      ) : visibleSuggestions.length === 0 ? (
        <StateCard icon={<SparklesIcon size={28} />} title={t('noMatchTitle', { defaultValue: 'No matches' })} body={t('noMatchBody', { defaultValue: 'Nothing matches the current filter.' })} action={<Button variant="secondary" onClick={() => setStatusFilter('')}>{t('clearFilters', { defaultValue: 'Clear filters' })}</Button>} />
      ) : (
      <ul className="u-list-none u-p-0 u-flex u-flex-col u-gap-2">
        {visibleSuggestions.map((s) => (
          <li key={s.suggestionId} className="surface-card u-pad-2 u-flex u-flex-col u-gap-1">
            <div className="u-flex u-items-center u-justify-between u-gap-2">
              <span className="u-fs-12 u-fw-600">{s.sampleGoal ?? t('aPattern', { defaultValue: 'A repeated pattern' })}</span>
              <span className="chip chip--accent u-fs-11">{t('seenCount', { count: s.count, defaultValue: `seen ${s.count}×` })}</span>
            </div>
            <div className="u-flex u-flex-wrap u-items-center u-gap-1 u-fs-11">
              {s.toolSequence.map((tool, i) => (
                <span key={`${tool}-${i}`} className="u-flex u-items-center u-gap-1">
                  {i > 0 && (
                    <>
                      <span className="muted" aria-hidden="true">→</span>
                      <span className="sr-only">{t('then', { defaultValue: 'then' })}</span>
                    </>
                  )}
                  <span className="chip chip--muted">{tool}</span>
                </span>
              ))}
            </div>
            <p className="muted u-fs-11">{t('evidence', { count: s.exampleRunIds.length, defaultValue: `${s.exampleRunIds.length} matching runs` })}</p>
            {s.status === 'accepted' ? (
              <span className="chip chip--accent u-fs-11 u-self-start">{t('statusAccepted', { defaultValue: 'accepted' })}</span>
            ) : (
              <div className="u-flex u-gap-2">
                <Button variant="primary" className="u-fs-11" disabled={busy} onClick={() => void accept(s)}>{t('makeWorkflow', { defaultValue: 'Make a workflow' })}</Button>
                <Button variant="secondary" className="u-fs-11" disabled={busy} onClick={() => void dismiss(s.suggestionId)} aria-label={t('dismiss', { defaultValue: 'Dismiss' })}>{t('dismiss', { defaultValue: 'Dismiss' })}</Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      )}
    </div>
  );
}
