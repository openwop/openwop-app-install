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
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { toast } from '../../ui/toast.js';
import { SparklesIcon } from '../../ui/icons/index.js';
import { listOrgs, listSuggestions, refreshSuggestions, dismissSuggestion, acceptSuggestion, type Org, type WorkflowSuggestion } from './workGraphClient.js';

export function WorkGraphPage(): JSX.Element {
  const { t } = useTranslation('ambient-work-graph');
  const navigate = useNavigate();
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [orgId, setOrgId] = useState('');
  const [suggestions, setSuggestions] = useState<WorkflowSuggestion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void listOrgs().then((o) => { setOrgs(o); setOrgId((cur) => cur || (o[0]?.orgId ?? '')); })
      .catch((e) => setError(e instanceof Error ? e.message : t('loadOrgsFailed', { defaultValue: 'Failed to load organizations.' })));
  }, [t]);

  const load = useCallback((org: string) => {
    void listSuggestions(org).then(setSuggestions)
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

  if (suggestions === null) return <StateCard loading title={t('loading', { defaultValue: 'Loading…' })} />;

  return (
    <div className="u-flex u-flex-col u-gap-3">
      <PageHeader eyebrow={t('eyebrow', { defaultValue: 'Automation' })} title={t('title', { defaultValue: 'Work patterns' })} lede={t('lede', { defaultValue: 'Recurring work across your recent runs — turn a repeated pattern into a reusable workflow. Tool-shape only; nothing is shared across organizations.' })} />
      {error && <Notice variant="error">{error}</Notice>}

      <div className="u-flex u-items-center u-gap-2 u-fs-12">
        <label className="u-flex u-items-center u-gap-2">
          {t('org', { defaultValue: 'Organization' })}
          <select value={orgId} onChange={(e) => setOrgId(e.target.value)} aria-label={t('org', { defaultValue: 'Organization' })}>
            {(orgs ?? []).map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
          </select>
        </label>
        <button type="button" className="secondary u-fs-11" disabled={busy || !orgId} onClick={refresh}>{t('refresh', { defaultValue: 'Scan now' })}</button>
      </div>

      {suggestions !== null && suggestions.length === 0 && (
        <StateCard icon={<SparklesIcon size={28} />} title={t('emptyTitle', { defaultValue: 'No patterns yet' })} body={t('emptyBody', { defaultValue: 'Once you repeat a multi-step task a few times, it’ll show up here as a workflow suggestion.' })} />
      )}

      <ul className="u-list-none u-p-0 u-flex u-flex-col u-gap-2">
        {(suggestions ?? []).map((s) => (
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
                <button type="button" className="u-fs-11" disabled={busy} onClick={() => void accept(s)}>{t('makeWorkflow', { defaultValue: 'Make a workflow' })}</button>
                <button type="button" className="secondary u-fs-11" disabled={busy} onClick={() => void dismiss(s.suggestionId)} aria-label={t('dismiss', { defaultValue: 'Dismiss' })}>{t('dismiss', { defaultValue: 'Dismiss' })}</button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
