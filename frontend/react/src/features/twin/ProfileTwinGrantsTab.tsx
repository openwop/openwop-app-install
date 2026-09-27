/**
 * "Who can recall my memory" tab (ADR 0044, Phase 3) — the user's consent
 * dashboard: every agent the user has granted twin-recall, the scopes it may
 * read, and one-click revoke. Granting happens on the agent ("Twin of you ·
 * Allow recall"); this is the place to review + withdraw it. Shown on My Profile
 * only when the `twin-recall` toggle is on (ProfilePage gates the tab).
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { SparklesIcon, TrashIcon } from '../../ui/icons/index.js';
import { formatDateTime } from '../../i18n/format.js';
import { listRoster } from '../../agents/rosterClient.js';
import { listMyGrants, listMyRecalls, revokeRecall, type MyTwinGrant, type MyTwinRecall } from './twinClient.js';

export function ProfileTwinGrantsTab(): JSX.Element {
  const { t } = useTranslation('twin');
  const [grants, setGrants] = useState<MyTwinGrant[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [namesUnavailable, setNamesUnavailable] = useState(false);
  /** TWIN-UX-4 — the recall audit rows (use-visibility). `null` + unavailable
   *  distinguishes "the read failed" from "never recalled" — on a consent
   *  dashboard those must never be conflated. */
  const [recalls, setRecalls] = useState<MyTwinRecall[] | null>(null);
  const [recallsUnavailable, setRecallsUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The grants read FAILED — distinct from `grants === null` = still loading. */
  const [loadFailed, setLoadFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    // The roster is a COMPANION read — a grant is still revocable without it, so
    // its failure must not take the dashboard down (the primary, `listMyGrants`,
    // is unguarded on purpose and propagates). But it must not fail SILENTLY
    // either: names degrade to raw agent ids, and this is the screen where a
    // person decides which agent to cut off. An unlabelled `agent:7f3a…` is a
    // worse basis for that decision than an admission that names are missing.
    // TWIN-UX-4 — the recall history is a companion read too: revoking must
    // still work when it fails, but its failure renders as an honest
    // "could not load", never as "never recalled".
    const [g, roster, recallRows] = await Promise.all([
      listMyGrants(),
      listRoster().then((r) => { setNamesUnavailable(false); return r; })
        .catch(() => { setNamesUnavailable(true); return []; }),
      listMyRecalls().then((r) => { setRecallsUnavailable(false); return r; })
        .catch(() => { setRecallsUnavailable(true); return null; }),
    ]);
    // `listGrantsForUser` returns the full history (active + revoked); the consent
    // dashboard shows only what's currently in force.
    setGrants(g.filter((x) => x.status !== 'revoked'));
    setNames(Object.fromEntries(roster.map((r) => [r.rosterId, r.persona])));
    setRecalls(recallRows);
  }, []);

  /** Per-agent aggregate of the recall rows: last successful read + counts. */
  const recallsByAgent = useMemo(() => {
    if (!recalls) return null;
    const out: Record<string, { lastOk?: string; okCount: number; deniedCount: number }> = {};
    for (const r of recalls) {
      if (!r.agentId) continue;
      const a = (out[r.agentId] ??= { okCount: 0, deniedCount: 0 });
      if (r.outcome === 'ok') {
        a.okCount += 1;
        if (!a.lastOk || r.timestamp > a.lastOk) a.lastOk = r.timestamp;
      } else {
        // F3 — denied rows are rate-bounded server-side; `attempts` carries
        // the window aggregate, so counting ROWS would undercount the probes.
        a.deniedCount += r.attempts ?? 1;
      }
    }
    return out;
  }, [recalls]);

  useEffect(() => {
    let cancelled = false;
    // SWEEP (ADR 0490-adjacent) — without `loadFailed`, `grants === null` means
    // both "still loading" and "the read failed", so a failure renders the
    // loading card forever. On a CONSENT dashboard that is the worst version:
    // the person is never told whether anything currently has access to them.
    void load().catch((e) => { if (!cancelled) { setLoadFailed(true); setError(e instanceof Error ? e.message : t('failedToLoadGrants')); } });
    return () => { cancelled = true; };
  }, [load, t]);

  // TWIN-UX-13 — the revoke and the refetch used to share ONE catch, so a
  // successful revoke followed by a failed reload rendered "revoke failed" with
  // the revoked agent still listed. The revoke's own outcome is reported first.
  const onRevoke = async (agentId: string): Promise<void> => {
    setBusy(true); setError(null); setNotice(null);
    let removed = false;
    try {
      ({ removed } = await revokeRecall(agentId));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('revokeFailed'));
      setBusy(false);
      return;
    }
    // TWIN-UX-3 — do not claim an act that did not happen. A stale list or a
    // double-click revokes nothing, and saying "revoked" for that is the same
    // dishonesty as a 204-on-nothing success notice.
    setNotice(removed ? t('recallRevokedEverywhere') : t('revokeNothingToRevoke'));
    try { await load(); } catch { setLoadFailed(true); }
    finally { setBusy(false); }
  };

  return (
    <div className="u-flex u-flex-col u-gap-3">
      <p className="muted u-fs-13 u-m-0">
        <Trans t={t} i18nKey="grantsIntro" components={{ 0: <strong /> }} />
      </p>
      {error ? <Notice variant="error">{error}</Notice> : null}
      {notice ? <Notice variant="success" announce={notice}>{notice}</Notice> : null}
      {namesUnavailable && grants && grants.length > 0 ? (
        <Notice variant="warning">{t('agentNamesUnavailable')}</Notice>
      ) : null}

      {grants === null && loadFailed ? (
        <StateCard announce
          icon={<SparklesIcon size={20} />}
          title={t('grantsLoadFailedTitle')}
          body={t('grantsLoadFailedBody')}
          /* TWIN-UX-16 — the retry is disabled during ITS OWN fetch (the row named
             this control; the first pass fixed only the AgentTwinPanel sibling). */
          action={<Button variant="secondary" size="sm" disabled={busy} onClick={() => { setBusy(true); setLoadFailed(false); void load().catch((e) => { setLoadFailed(true); setError(e instanceof Error ? e.message : t('failedToLoadGrants')); }).finally(() => setBusy(false)); }}>{t('grantsRetry')}</Button>}
        />
      ) : grants === null ? (
        <StateCard icon={<SparklesIcon size={20} />} title={t('loading')} loading />
      ) : grants.length === 0 ? (
        <StateCard
          icon={<SparklesIcon size={20} />}
          title={t('noAgentTitle')}
          /* TWIN-UX-21 follow-through (LOW-1) — the instruction is a LINK, not
             prose about a tab. With exactly one agent it deep-links straight to
             that agent's Integrations tab; otherwise to the roster. */
          body={
            <Trans t={t} i18nKey="noAgentBody" components={{
              0: <Link to={Object.keys(names).length === 1
                ? `/agents/${encodeURIComponent(Object.keys(names)[0]!)}?tab=integrations`
                : '/agents'} />,
            }} />
          }
        />
      ) : (
        <ul className="u-flex u-flex-col u-gap-2 u-m-0 u-p-0 u-list-none">
          {grants.map((g) => (
            // u-flex-row: .surface-card is a column flex and .action-bar sets no
            // direction, so without it the row stacks (same trap as HV-CDP1).
            <li key={g.agentId} className="surface-card action-bar u-flex-row u-justify-between u-items-center">
              <span className="u-flex u-flex-col u-gap-1">
                <strong>{names[g.agentId] ?? g.agentId}</strong>
                <span className="u-flex u-items-center u-gap-1">
                  {/* TWIN-UX-20 — the ternary used to end `: s`, rendering the raw
                      unlocalized wire string as the description of what an agent may
                      read about you. `MyTwinGrant.scopes` arrives via a compile-time
                      `as` over unvalidated JSON, so an unknown value IS reachable;
                      name it as unrecognised rather than passing it off as copy.
                      TWIN-UX-27 — `chip--accent` is reserved for run status
                      (DESIGN.md §5.3); a consent scope is not a run state. */}
                  {g.scopes.length
                    ? g.scopes.map((s) => (
                        <span key={s} className={`chip ${s === 'memory' || s === 'knowledge' ? 'chip--ai' : 'chip--warning'} u-fs-12`}>
                          {s === 'memory' ? t('scopeMemory') : s === 'knowledge' ? t('scopeKnowledge') : t('scopeUnknown')}
                        </span>
                      ))
                    : <span className="chip chip--muted u-fs-12">{t('noScopes')}</span>}
                </span>
                {/* TWIN-UX-4 — use-visibility on the grant card: last recall +
                    count (and denied probes), or an honest failed-read line.
                    Consent without visibility of use was this feature's
                    defining gap. */}
                <span className="muted u-fs-12">
                  {recallsUnavailable
                    ? t('recallsUnavailable')
                    : (() => {
                        const a = recallsByAgent?.[g.agentId];
                        const base = a && a.okCount > 0
                          ? t('lastRecalled', { count: a.okCount, date: formatDateTime(a.lastOk ?? '') })
                          : t('neverRecalled');
                        const denied = a && a.deniedCount > 0
                          ? ` · ${t('deniedRecallAttempts', { count: a.deniedCount })}`
                          : '';
                        return `${base}${denied}`;
                      })()}
                </span>
              </span>
              <Button variant="quiet" size="sm" disabled={busy} onClick={() => void onRevoke(g.agentId)}>
                <TrashIcon size={14} /> {t('revoke')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
