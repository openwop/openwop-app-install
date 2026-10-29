/**
 * Agent compaction panel (ADR 0999 D7, closes `TOCU-2`) — the per-agent `lossy`
 * tool-output compaction opt-in, which until now could be set only through the
 * raw profile API: the one control that enables information-REMOVING compaction
 * had no editor and no indicator anywhere in the SPA.
 *
 * It lives in the existing agent-config seam (`agentProfile.configParameters.compaction
 * = { lossy, head?, tail?, … }`, ADR 0031 / ADR 0099 Phase 2), read once at run start by
 * `backend/…/tool-output-compaction/decision.ts`. PUT merges, so save carries every
 * loaded `configParameters` sibling through and replaces only the `lossy`/`head`/`tail`
 * keys, keeping any `minChars` / `exemptTools` set through the API (the AgentVoicePanel
 * discipline — never wipe siblings).
 *
 * Shown only when the `tool-output-compaction` toggle resolves enabled for the caller:
 * the setting does nothing otherwise, and a control that does nothing is a false claim.
 *
 * NON-NORMATIVE host-local product config under `/host/openwop-app/*`.
 */
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Button.js';
import { Notice } from '../ui/Notice.js';
import { CheckboxField, TextField } from '../ui/Field.js';
import { getAgentProfile, putAgentProfile, type AgentProfile, type AgentProfileInput } from './rosterClient.js';
import { writeErrorMessage, useAgentWriteAccess } from './agentWriteAccess.js';
import { useFeatureVisible } from '../featureToggles/FeatureAccessContext.js';

export const COMPACTION_TOGGLE_ID = 'tool-output-compaction';

interface CompactionConfig { lossy?: boolean; head?: number; tail?: number; [k: string]: unknown }

/** Kernel defaults (`compact.ts` DEFAULT_HEAD / DEFAULT_TAIL), shown as placeholders. */
const DEFAULT_HEAD = 3;
const DEFAULT_TAIL = 1;

/** A whole number ≥ 0, or `undefined` for blank. `null` = invalid (refuse to save). */
function parseCount(raw: string): number | undefined | null {
  const s = raw.trim();
  if (s === '') return undefined;
  return /^\d{1,4}$/.test(s) ? Number(s) : null;
}

/** Build a full PUT body from the loaded profile, merging only the compaction keys this panel owns. */
export function buildCompactionInput(
  profile: AgentProfile | null,
  next: { lossy: boolean; head?: number; tail?: number },
): AgentProfileInput {
  const configParameters = { ...(profile?.configParameters ?? {}) } as Record<string, unknown>;
  const prev = (configParameters.compaction ?? {}) as CompactionConfig;
  const { lossy: _l, head: _h, tail: _t, ...kept } = prev;
  const compaction: CompactionConfig = {
    ...kept,
    ...(next.lossy ? { lossy: true } : {}),
    // Kept while lossy is off (review TOC2UX-13): the run-start reader honours
    // head/tail only under lossy, so a stored count is inert until it is re-enabled.
    ...(next.head !== undefined ? { head: next.head } : {}),
    ...(next.tail !== undefined ? { tail: next.tail } : {}),
  };
  if (Object.keys(compaction).length) configParameters.compaction = compaction;
  else delete configParameters.compaction;
  return {
    roleKey: profile?.roleKey ?? 'custom',
    // ADR 0775 P4 — the PUT MERGES; send only what this panel owns. An emptied
    // map is sent as `null` (clear), and `autonomy` is required and replaced whole.
    configParameters: Object.keys(configParameters).length ? configParameters : null,
    autonomy: {
      specLevel: profile?.autonomy.specLevel ?? 'draft-only',
      ...(profile?.autonomy.withinPolicyActions?.length ? { withinPolicyActions: profile.autonomy.withinPolicyActions } : {}),
    },
  };
}

/** The panel's editable state, as strings for the two count fields. */
interface Draft { lossy: boolean; head: string; tail: string }

function draftFrom(p: AgentProfile | null): Draft {
  const c = (p?.configParameters as { compaction?: CompactionConfig } | undefined)?.compaction;
  return {
    lossy: c?.lossy === true,
    head: typeof c?.head === 'number' ? String(c.head) : '',
    tail: typeof c?.tail === 'number' ? String(c.tail) : '',
  };
}

export function AgentCompactionPanel({ rosterId }: { rosterId: string }): JSX.Element | null {
  const visible = useFeatureVisible();
  const canWrite = useAgentWriteAccess();
  const { t } = useTranslation('agents');
  const headingId = useId();
  const [profile, setProfile] = useState<AgentProfile | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [draft, setDraft] = useState<Draft>({ lossy: false, head: '', tail: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const enabled = visible(COMPACTION_TOGGLE_ID);

  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    setState('loading');
    void (async () => {
      try {
        const p = await getAgentProfile(rosterId);
        if (!live) return;
        setProfile(p);
        setDraft(draftFrom(p));
        setState('ready');
      } catch {
        // A failed read is a state with a retry, never a disabled form with no
        // explanation (review TOC2UX-10).
        if (live) setState('failed');
      }
    })();
    return () => { live = false; };
  }, [rosterId, enabled, attempt]);

  if (!enabled) return null;

  // The chip states the SAVED setting — what the agent's next run will use — not
  // the unsaved checkbox (review TOC2UX-8: the indicator must not claim a mode
  // the agent is not running).
  const saved = draftFrom(profile);
  const headN = parseCount(draft.head);
  const tailN = parseCount(draft.tail);
  const invalid = draft.lossy && (headN === null || tailN === null);
  const dirty = draft.lossy !== saved.lossy || draft.head !== saved.head || draft.tail !== saved.tail;
  const edit = (patch: Partial<Draft>): void => { setDraft((d) => ({ ...d, ...patch })); setNotice(null); };

  const save = async (): Promise<void> => {
    if (invalid) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const next = await putAgentProfile(
        rosterId,
        buildCompactionInput(profile, { lossy: draft.lossy, ...(headN != null ? { head: headN } : {}), ...(tailN != null ? { tail: tailN } : {}) }),
        { ifMatch: profile?.etag },
      );
      setProfile(next);
      setDraft(draftFrom(next));
      setNotice(t('compactionSaved'));
    } catch (err) {
      setError(writeErrorMessage(err, t('common:error_forbidden'), t('agentChangedReload')));
    } finally {
      setBusy(false);
    }
  };

  const ready = state === 'ready';
  return (
    <section className="surface-card u-flex u-flex-col u-gap-3" aria-labelledby={headingId}>
      <h3 id={headingId} className="u-fs-14 u-fw-600 u-m-0 u-flex u-items-center u-gap-2">
        {t('compactionTitle')}
        {ready ? (
          <span className={saved.lossy ? 'chip chip--warning' : 'chip'}>{saved.lossy ? t('compactionChipLossy') : t('compactionChipLossless')}</span>
        ) : null}
      </h3>
      <p className="muted u-fs-13 u-m-0">{t('compactionDesc')}</p>
      {state === 'loading' ? <p className="muted u-fs-13 u-m-0" role="status">{t('compactionLoading')}</p> : null}
      {state === 'failed' ? (
        <Notice variant="error" announce={t('compactionLoadFailed')}>
          {t('compactionLoadFailed')}{' '}
          <Button variant="quiet" size="sm" onClick={() => setAttempt((n) => n + 1)}>{t('common:retry')}</Button>
        </Notice>
      ) : null}
      {error ? <Notice variant="error" announce={error}>{error}</Notice> : null}
      {notice ? <Notice variant="success" announce={notice}>{notice}</Notice> : null}
      {ready && !canWrite ? <p className="muted u-fs-13 u-m-0">{t('viewerPanelReadOnly')}</p> : null}
      {ready ? (
        <>
          <CheckboxField
            label={t('compactionLossyLabel')}
            help={t('compactionLossyWarning')}
            checked={draft.lossy}
            disabled={!canWrite}
            onChange={(e) => edit({ lossy: e.target.checked })}
          />
          {draft.lossy ? (
            <div className="u-flex u-gap-3 u-flex-wrap u-items-end">
              <TextField
                label={t('compactionHead')}
                help={t('compactionCountHelp', { n: DEFAULT_HEAD })}
                inputMode="numeric"
                value={draft.head}
                onChange={(e) => edit({ head: e.target.value })}
                placeholder={String(DEFAULT_HEAD)}
                disabled={!canWrite}
                {...(headN === null ? { error: t('compactionCountInvalid') } : {})}
                className="u-flex-1"
              />
              <TextField
                label={t('compactionTail')}
                help={t('compactionCountHelp', { n: DEFAULT_TAIL })}
                inputMode="numeric"
                value={draft.tail}
                onChange={(e) => edit({ tail: e.target.value })}
                placeholder={String(DEFAULT_TAIL)}
                disabled={!canWrite}
                {...(tailN === null ? { error: t('compactionCountInvalid') } : {})}
                className="u-flex-1"
              />
            </div>
          ) : null}
          <p className="muted u-fs-12 u-m-0">{t('compactionScopeNote')}</p>
          {canWrite ? (
            <div className="action-bar">
              <Button variant="primary" size="sm" disabled={busy || invalid || !dirty} onClick={() => void save()}>
                {busy ? t('compactionSaving') : t('compactionSave')}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
