/**
 * ADR 0137 Phase 4 + ADR 0930 — the Ambient Work Graph suggestions page.
 *
 * PERSONAL: recurring patterns in the runs the CALLER started ("you've done this N times —
 * make it a workflow?"), visible to nobody else, with a personal pause that stops the
 * processing (not just the display). Each card shows the tool-sequence pattern +
 * recurrence count + an evidence line. Accept hands a draftSeed to the EXISTING
 * chat-driven workflow-author (navigates to /builder with the seed in router state — no
 * second author) and shares the STEP pattern with the workspace as a proposal; the goal
 * text stays the caller's. Dismiss hides it (persisted; never resurrected by a re-sweep).
 * Scan reads the workspace's newest runs up to a cap and says when it stopped short.
 *
 * @see docs/adr/0137-ambient-work-graph.md
 * @see docs/adr/0930-ambient-work-graph-per-owner.md
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { toast } from '../../ui/toast.js';
import { confirm } from '../../ui/confirm.js';
import { SparklesIcon } from '../../ui/icons/index.js';
import { listOrgs, listSuggestions, refreshSuggestions, dismissSuggestion, acceptSuggestion, getWorkGraphSettings, setWorkGraphPaused, WorkGraphError, type Org, type WorkGraphSettings, type WorkflowSuggestion } from './workGraphClient.js';

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
  // ADR 0930 / AWG2UX-2 — the patterns and the pause are the caller's, per workspace, so
  // which org authorizes the read changes nothing the person can see: there is no picker,
  // the first org is used.
  const orgId = orgs?.[0]?.orgId ?? '';
  const [suggestions, setSuggestions] = useState<WorkflowSuggestion[] | null>(null);
  const [settings, setSettings] = useState<WorkGraphSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [pending, setPending] = useState<string | null>(null); // the row (or 'pause') in flight
  // ADR 0930 A9 — set after a Scan that stopped before the workspace's oldest run.
  const [truncatedAt, setTruncatedAt] = useState<number | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const paused = settings?.paused === true;
  // §4.5 collection kit — status facet feeding a separate memo over the
  // unfiltered suggestions.
  const [statusFilter, setStatusFilter] = useState<'' | 'suggested' | 'accepted'>('');
  const visibleSuggestions = useMemo(
    () => (suggestions ?? []).filter((s) => !statusFilter || s.status === statusFilter),
    [suggestions, statusFilter],
  );

  useEffect(() => {
    void listOrgs().then(setOrgs)
      .catch((e) => setError(e instanceof Error ? e.message : t('loadOrgsFailed', { defaultValue: 'Failed to load organizations.' })));
  }, [t]);

  // AWG2UX-4 — the patterns and the pause load TOGETHER: a paused person must never see
  // "No patterns yet" first, and a failed settings read is a failed load, not a guess.
  const load = useCallback((org: string) => {
    void Promise.all([listSuggestions(org), getWorkGraphSettings(org)])
      .then(([rows, s]) => { setSuggestions(rows); setSettings(s); setError(null); })
      .catch((e) => setError(e instanceof Error ? e.message : t('loadFailed', { defaultValue: 'Failed to load suggestions.' })));
  }, [t]);
  useEffect(() => { if (orgId) load(orgId); }, [orgId, load]);

  /** AWG2UX-9 — say what a refusal means rather than echo the server's text. */
  const failure = (e: unknown, fallback: string): string => {
    if (e instanceof WorkGraphError && e.status === 403) return t('forbiddenError', { defaultValue: 'You need edit access in this workspace to do that.' });
    if (e instanceof WorkGraphError && e.status === 404) return t('goneError', { defaultValue: 'This pattern is no longer available. Scan again.' });
    if (e instanceof WorkGraphError && e.status === 409) return t('conflictError', { defaultValue: 'This pattern was dismissed, so it can’t be made into a workflow.' });
    return e instanceof Error ? e.message : fallback;
  };

  const refresh = async (): Promise<void> => {
    setScanning(true);
    try {
      const scan = await refreshSuggestions(orgId);
      setSuggestions(scan.suggestions);
      setSettings((cur) => ({ ...(cur ?? {}), paused: scan.paused }));
      setTruncatedAt(scan.truncated ? scan.scanned : null);
      toast.success(scan.truncated
        ? t('refreshedTruncated', { count: scan.scanned, defaultValue: `Scanned your runs among the workspace’s ${scan.scanned} most recent` })
        : t('refreshed', { defaultValue: 'Scanned your recent runs' }));
    }
    catch (e) { toast.error(failure(e, t('refreshFailed', { defaultValue: 'Failed to scan runs.' }))); } finally { setScanning(false); }
  };
  const dismiss = async (id: string, index: number): Promise<void> => {
    setPending(id);
    try {
      await dismissSuggestion(orgId, id);
      setSuggestions((cur) => (cur ?? []).filter((s) => s.suggestionId !== id));
      // AWG2UX-7 — keep the keyboard where it was: the next row's first action, else
      // the previous row's, else the list's heading region.
      setTimeout(() => {
        const rows = listRef.current?.querySelectorAll<HTMLElement>('li [data-row-action]');
        const next = rows?.[Math.min(index, (rows?.length ?? 1) - 1)];
        (next ?? document.getElementById('work-graph-heading'))?.focus();
      }, 0);
    }
    catch (e) { toast.error(failure(e, t('dismissFailed', { defaultValue: 'Failed to dismiss the suggestion.' }))); } finally { setPending(null); }
  };
  const accept = async (s: WorkflowSuggestion): Promise<void> => {
    setPending(s.suggestionId);
    try {
      const draftSeed = await acceptSuggestion(orgId, s.suggestionId);
      toast.success(t('accepted', { defaultValue: 'Opening the workflow author…' }));
      navigate('/builder', { state: { workGraphSeed: draftSeed } });
    } catch (e) { toast.error(failure(e, t('acceptFailed', { defaultValue: 'Failed to open the workflow author.' }))); }
    finally { setPending(null); }
  };

  const togglePause = async (next: boolean): Promise<void> => {
    // AWG2UX-3 — pausing deletes stored patterns; say so BEFORE, not after.
    if (next && !(await confirm({
      title: t('pauseConfirmTitle', { defaultValue: 'Pause pattern detection?' }),
      body: t('pauseConfirmBody', { defaultValue: 'Your runs will not be read, and your stored patterns will be deleted. Patterns you dismissed stay dismissed. You can resume at any time.' }),
      confirmLabel: t('pause', { defaultValue: 'Pause pattern detection' }),
      danger: true,
    }))) return;
    setPending('pause');
    try {
      const r = await setWorkGraphPaused(orgId, next);
      setSettings({ paused: r.paused });
      if (r.paused) setTruncatedAt(null); else load(orgId);
      toast.success(r.paused
        ? t('pausedToast', { defaultValue: 'Pattern detection paused' })
        : t('resumedToast', { defaultValue: 'Pattern detection resumed' }));
    } catch (e) { toast.error(failure(e, t('pauseFailed', { defaultValue: 'Failed to change pattern detection.' }))); }
    finally { setPending(null); }
  };

  if (orgs && orgs.length === 0) {
    return <StateCard icon={<SparklesIcon size={28} />} title={t('noOrgsTitle', { defaultValue: 'No organizations' })} body={t('noOrgsBody', { defaultValue: 'Create an organization to see work-pattern suggestions.' })} />;
  }

  // AWG-R2-1 — a failed FIRST read used to leave this early-return showing the
  // loading card forever (the error was set but never reachable below it):
  // failure-as-LOADING. Two prior passes graded this page "clean" by checking
  // the error was SET — neither checked it could RENDER.
  if (suggestions === null || settings === null) {
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

  const erased = settings.reason === 'erased';
  const truncatedText = truncatedAt === null ? '' : t('truncated', { count: truncatedAt, defaultValue: `Scanned the workspace’s ${truncatedAt} most recent runs. Older runs were not read.` });

  return (
    <div data-walkthrough="work-patterns.page" className="u-flex u-flex-col u-gap-3">
      <div id="work-graph-heading" tabIndex={-1}>
        <PageHeader eyebrow={t('eyebrow', { defaultValue: 'Operations' })} title={t('title', { defaultValue: 'Work patterns' })} lede={t('lede', { defaultValue: 'Steps you have repeated in the runs you started. Only you can see these; turn one into a reusable workflow.' })} />
      </div>
      <p className="muted u-fs-11">{t('privacyNote', { defaultValue: 'Only tool names are read, never their inputs. Scheduled, key-driven, forked and re-run runs are left out.' })}</p>
      {error && <Notice variant="error" announce={error}>{error}</Notice>}

      {!paused && (
        <div className="u-flex u-flex-wrap u-items-center u-gap-2">
          <Button variant="secondary" loading={scanning} disabled={pending !== null || !orgId} onClick={refresh}>
            {scanning ? t('scanning', { defaultValue: 'Scanning…' }) : t('refresh', { defaultValue: 'Scan now' })}
          </Button>
          <Button variant="secondary" disabled={scanning || pending !== null || !orgId} onClick={() => void togglePause(true)}>
            {t('pause', { defaultValue: 'Pause pattern detection' })}
          </Button>
        </div>
      )}
      {truncatedAt !== null && <Notice variant="info" announce={truncatedText}>{truncatedText}</Notice>}

      {!paused && suggestions.length > 3 ? (
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

      {paused ? (
        <StateCard
          icon={<SparklesIcon size={28} />}
          title={erased ? t('erasedTitle', { defaultValue: 'Your work patterns were erased' }) : t('pausedTitle', { defaultValue: 'Pattern detection is paused' })}
          body={erased
            ? t('erasedBody', { defaultValue: 'A data-erasure request removed your patterns in this workspace, and detection stays off. Turning it back on starts reading your runs again.' })
            : t('pausedBody', { defaultValue: 'Your runs are not read while paused, and your stored patterns were deleted. Patterns you dismissed stay dismissed.' })}
          action={<Button variant="secondary" disabled={pending !== null} onClick={() => void togglePause(false)}>{erased ? t('turnBackOn', { defaultValue: 'Turn pattern detection back on' }) : t('resume', { defaultValue: 'Resume pattern detection' })}</Button>}
        />
      ) : suggestions.length === 0 ? (
        <StateCard icon={<SparklesIcon size={28} />} title={t('emptyTitle', { defaultValue: 'No patterns yet' })} body={t('emptyBody', { defaultValue: 'Patterns come only from finished runs you started that called tools, three or more times with the same steps. Chat conversations stay open and are not read yet, so most people will not see patterns here today.' })} />
      ) : visibleSuggestions.length === 0 ? (
        <StateCard icon={<SparklesIcon size={28} />} title={t('noMatchTitle', { defaultValue: 'No matches' })} body={t('noMatchBody', { defaultValue: 'Nothing matches the current filter.' })} action={<Button variant="secondary" onClick={() => setStatusFilter('')}>{t('clearFilters', { defaultValue: 'Clear filters' })}</Button>} />
      ) : (
      <ul ref={listRef} className="u-list-none u-p-0 u-flex u-flex-col u-gap-2">
        {visibleSuggestions.map((s, index) => {
          const name = s.sampleGoal ?? s.toolSequence.join(' → ');
          return (
          <li key={s.suggestionId} className="surface-card u-pad-2 u-flex u-flex-col u-gap-1">
            <div className="u-flex u-flex-wrap u-items-center u-justify-between u-gap-2">
              <span className="u-fs-12 u-fw-600 u-min-w-0 u-break-anywhere">{s.sampleGoal ?? t('aPattern', { defaultValue: 'A repeated pattern' })}</span>
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
                  <span className="chip chip--muted u-break-anywhere">{tool}</span>
                </span>
              ))}
            </div>
            <p className="muted u-fs-11">{t('evidence', { count: s.exampleRunIds.length, defaultValue: `${s.exampleRunIds.length} example runs kept as evidence` })}</p>
            {s.status === 'accepted' ? (
              <span className="chip chip--success u-fs-11 u-self-start">{t('statusAccepted', { defaultValue: 'accepted' })}</span>
            ) : (
              <div className="u-flex u-flex-wrap u-gap-2">
                <Button data-row-action variant="primary" disabled={pending !== null || scanning} onClick={() => void accept(s)} aria-label={t('makeWorkflowNamed', { name, defaultValue: `Make a workflow: ${name}` })} aria-describedby="work-graph-share-note">{t('makeWorkflow', { defaultValue: 'Make a workflow' })}</Button>
                <Button variant="secondary" disabled={pending !== null || scanning} onClick={() => void dismiss(s.suggestionId, index)} aria-label={t('dismissNamed', { name, defaultValue: `Dismiss: ${name}` })}>{t('dismiss', { defaultValue: 'Dismiss' })}</Button>
              </div>
            )}
          </li>
          );
        })}
      </ul>
      )}
      {!paused && visibleSuggestions.some((s) => s.status !== 'accepted') && (
        <p id="work-graph-share-note" className="muted u-fs-11">{t('shareNote', { defaultValue: 'Making a workflow shares the step pattern (not your goal text) with this workspace as a proposal.' })}</p>
      )}
    </div>
  );
}
