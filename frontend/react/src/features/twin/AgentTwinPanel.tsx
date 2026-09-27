/**
 * Agent "Twin of …" affordance (ADR 0044, Phase 3) — shown on an agent's profile
 * when the `twin-recall` toggle is on. Surfaces the agent↔person LINK (admin
 * link/unlink) and, when the viewer IS the linked person, the GRANT controls that
 * let the agent recall the viewer's memory/knowledge. Self-gates on the toggle
 * (renders nothing when off) so the mount can stay unconditional.
 *
 * Link ≠ grant: linking says "this agent is your twin"; only YOU (the linked
 * person) can then allow it to recall your corpus, per scope. Fail-closed.
 */
import { Button } from '../../ui/Button.js';
import { confirm } from '../../ui/confirm.js';
import { useCallback, useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { CheckboxField } from '../../ui/Field.js';
import i18n from '../../i18n/index.js';
import { SparklesIcon, UserIcon, ShieldIcon } from '../../ui/icons/index.js';
import { getProfile } from '../profiles/profilesClient.js';
import { isMine, useMyIdentity } from '../profiles/useMyIdentity.js';
import {
  getAgentTwin, linkTwinToUser, unlinkTwin, grantRecall, revokeRecall,
  type AgentTwinView, type TwinScope,
} from './twinClient.js';

const ALL_SCOPES: TwinScope[] = ['memory', 'knowledge'];

export function AgentTwinPanel({ rosterId, persona }: { rosterId: string; persona: string }): JSX.Element | null {
  const { t } = useTranslation('twin');
  const access = useFeatureAccess('twin-recall');
  const [view, setView] = useState<AgentTwinView | null>(null);
  // ADR 0492 — one identity seam; `isMine` yields 'unknown', never a silent false.
  const identity = useMyIdentity();
  const myUserId = identity.status === 'known' ? identity.userId : null;
  const identityKnown = identity.status === 'known';
  const [linkedName, setLinkedName] = useState<string | null>(null);
  const [scopes, setScopes] = useState<Set<TwinScope>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The twin read FAILED — a third state, because `view === null` (loading) and
   *  an empty view (`{ link: null }`) are both taken AND both are wrong here.
   *  See the load effect for why an empty view is the dangerous one. */
  const [loadFailed, setLoadFailed] = useState(false);

  /** The load, shared by the mount effect and the retry — so the retry cannot
   *  reintroduce the very state this fix removes (a failure that leaves the
   *  panel on the loading branch). `isCancelled` keeps the unmount guard. */
  const load = useCallback(async (isCancelled: () => boolean = () => false): Promise<void> => {
      try {
        const v = await getAgentTwin(rosterId);
        if (isCancelled()) return;
        setView(v);
        setLoadFailed(false);
        setError(null);
        setScopes(new Set(v.grant?.scopes ?? []));
      } catch (e) {
        if (isCancelled()) return;
        setError(e instanceof Error ? e.message : t('failedToLoadTwinLink'));
        // NOT `setView(prev ?? { link: null, grant: null })`. Leaving the loading
        // sentinel spins forever, but resolving to an EMPTY VIEW is worse: `!link`
        // is the branch that renders "{persona} isn't a twin of anyone yet." AND
        // the "Make {persona} a twin of me" button. So a failed read would both
        // assert something false and OFFER A WRITE PREMISED ON IT.
        //
        // Checked, not assumed: the server cannot catch this. `linkTwin`
        // (host/twinService.ts) has no already-linked rejection — it silently
        // re-links and REVOKES THE PRIOR TWIN'S GRANT, which is correct for a
        // deliberate admin re-link and indistinguishable from this one. The guard
        // therefore has to be here: while the read is unresolved we know nothing
        // about the link, so we claim nothing and offer nothing.
        setLoadFailed(true);
      }
  }, [rosterId, t]);

  useEffect(() => {
    if (!access.enabled) return undefined;
    let cancelled = false;
    void load(() => cancelled);
    return () => { cancelled = true; };
  }, [access.enabled, load]);

  // Resolving the linked person's name depends on BOTH the twin view and the
  // viewer's identity, so it gets its own effect keyed on both. Folding it into
  // the fetch above would capture `identity` while it is still `loading` and
  // look up a name for your OWN twin — the self case must show "you".
  // Best-effort: falls back to the opaque id if the lookup fails.
  useEffect(() => {
    const link = view?.link;
    if (!link || identity.status === 'loading') return undefined;
    if (isMine(identity, link.userId) === true) { setLinkedName(null); return undefined; }
    let cancelled = false;
    void getProfile(link.userId)
      .then((p) => { if (!cancelled) setLinkedName(p.displayName ?? null); })
      .catch(() => { if (!cancelled) setLinkedName(null); });
    return () => { cancelled = true; };
  }, [view, identity]);

  if (!access.enabled) return null;

  // TWIN-UX-13 — the write and the refetch used to share ONE catch, so a
  // successful grant/revoke followed by a failed re-read rendered "getAgentTwin
  // failed (500)" with NO success notice, while the consent state had in fact
  // changed. On a privacy control, telling someone their revoke failed when it
  // succeeded is the wrong error to invent. The write's outcome is now reported
  // on its own; a refetch failure degrades the VIEW, not the verdict.
  // The notice may depend on what the write REPORTED (unlink returns `removed`),
  // so `ok` can be a function of the op's result — a static string otherwise.
  const run = async <T,>(op: () => Promise<T>, ok: string | ((result: T) => string)): Promise<void> => {
    setBusy(true); setError(null); setNotice(null);
    let result: T;
    try {
      result = await op();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('actionFailed'));
      setBusy(false);
      return;
    }
    setNotice(typeof ok === 'function' ? ok(result) : ok);
    try {
      setView(await getAgentTwin(rosterId));
    } catch {
      // The act SUCCEEDED; only the re-read did not. Say so instead of
      // contradicting the notice above.
      setLoadFailed(true);
    } finally { setBusy(false); }
  };

  const link = view?.link ?? null;
  const mine = link ? isMine(identity, link.userId) : false;
  const toggleScope = (s: TwinScope): void => setScopes((prev) => { const n = new Set(prev); n.has(s) ? n.delete(s) : n.add(s); return n; });

  return (
    <div className="surface-card u-flex u-flex-col u-gap-3 u-mt-4">
      <span className="u-flex u-items-center u-gap-2"><SparklesIcon size={16} /> <strong>{t('digitalTwin')}</strong></span>
      <p className="muted u-fs-13 u-m-0">
        <Trans t={t} i18nKey="panelIntro" values={{ persona }} components={{ 0: <strong /> }} />
      </p>
      {error ? <Notice variant="error">{error}</Notice> : null}
      {notice ? <Notice variant="success" announce={notice}>{notice}</Notice> : null}
      {/* Ownership is undecidable without an identity. Say so, rather than letting
          every `=== myUserId` test quietly resolve to "not yours" and take the
          recall-grant controls off screen with it. */}
      {view !== null && !identityKnown ? (
        <Notice variant="warning">{t('identityUnknown')}</Notice>
      ) : null}

      {/* Tested BEFORE the loading branch, or the spinner wins and the
          distinction is decorative. Renders no link control on purpose. */}
      {loadFailed ? (
        // TWIN-UX-15 / TWIN-UX-16 — this was a bare <p> that announced NOTHING,
        // beside a Retry that was never disabled during its own fetch (`busy` is
        // written only by `run`, never by `load`). Both fixed by mirroring the
        // sibling tab, which already does it correctly.
        <StateCard announce
          icon={<SparklesIcon size={20} />}
          title={t('failedToLoadTwinLink')}
          body={t('twinLoadFailedBody', { persona })}
          action={<Button variant="secondary" size="sm" disabled={busy}
            onClick={() => { setBusy(true); void load().finally(() => setBusy(false)); }}>{t('twinRetry')}</Button>}
        />
      ) : view === null ? (
        <StateCard icon={<SparklesIcon size={20} />} title={t('loading')} loading />
      ) : !link ? (
        <div className="action-bar u-gap-2">
          <span className="muted u-fs-13">{t('notTwinYet', { persona })}</span>
          <Button variant="primary" size="sm" disabled={busy || !myUserId}
            onClick={() => void run(() => linkTwinToUser(rosterId, myUserId!).then(() => undefined), t('nowYourTwin', { persona }))}>
            {t('makeTwinOfMe', { persona })}
          </Button>
        </div>
      ) : (
        <div className="u-flex u-flex-col u-gap-3">
          <div className="action-bar u-justify-between u-items-center">
            <span className="u-flex u-items-center u-gap-2">
              <UserIcon size={14} />
              {mine === true
                ? <Trans t={t} i18nKey="twinOfYou" components={{ 0: <strong /> }} />
                : mine === 'unknown'
                  // Don't attribute the link to "a person" we can't rule out is
                  // the viewer — that raw id may well be their own.
                  ? <>{t('twinOfUnknown')} <span className="chip chip--muted">{linkedName ?? link.userId}</span></>
                  : <>{t('twinOfPerson')} <span className="chip chip--muted">{linkedName ?? link.userId}</span></>}
            </span>
            {/* TWIN-UX-3 — this destroys ANOTHER PERSON'S consent grant
                (`unlinkTwin` → `revokeByOwner`). It was an unconfirmed, quiet
                button that named nobody. Confirm, name them, and mark it danger. */}
            <Button variant="danger" size="sm" disabled={busy}
              onClick={() => void (async () => {
                if (!(await confirm({
                  title: t('unlinkConfirmTitle', { persona }),
                  // MEDIUM-2 — the self case gets its OWN sentence. Splicing a
                  // possessive pronoun into the `{{name}}'s` slot produced
                  // "revokes your's consent" (and its equivalent in all four
                  // locales); possessives don't compose across languages.
                  body: mine === true
                    ? t('unlinkConfirmBodySelf', { persona })
                    : t('unlinkConfirmBody', { persona, name: linkedName ?? link.userId }),
                  confirmLabel: t('unlink'),
                  danger: true,
                }))) return;
                // TWIN-UX-3 (unlink lane) — branch on what the route REPORTED. A
                // stale second tab removes nothing; saying "Twin link removed."
                // for that is the same dishonesty as the 204-on-nothing it had.
                await run(() => unlinkTwin(rosterId), (r) => (r.removed ? t('twinLinkRemoved') : t('unlinkNothingRemoved')));
              })()}>{t('unlink')}</Button>
          </div>

          {/* TWIN-UX-8 — the two checkboxes are labelled with the bare words
              "memory" and "knowledge", and `ui/Field` makes the label the input's
              own accessible name, so a screen-reader user heard "memory, checkbox,
              not checked" with no idea what was being consented to. A fieldset +
              legend gives the group a name, and the legend is reachable by heading
              navigation, which a bare strong element is not. */}
          {mine === true ? (
            <fieldset className="surface-card u-flex u-flex-col u-gap-2 u-border-0 u-m-0">
              <legend className="u-flex u-items-center u-gap-2"><ShieldIcon size={14} /> <strong>{t('allowRecallHeading', { persona })}</strong></legend>
              <div className="action-bar u-gap-3">
                {ALL_SCOPES.map((s) => (
                  <CheckboxField
                    key={s}
                    label={s === 'memory' ? t('scopeMemory') : t('scopeKnowledge')}
                    checked={scopes.has(s)}
                    disabled={busy}
                    onChange={() => toggleScope(s)}
                  />
                ))}
              </div>
              <div className="action-bar u-gap-2">
                <Button variant="primary" size="sm" disabled={busy || scopes.size === 0}
                  onClick={() => void run(() => grantRecall(rosterId, [...scopes]), t('recallConsentSaved'))}>
                  {view.grant ? t('updateConsent') : t('allowRecall')}
                </Button>
                {view.grant ? (
                  <Button variant="quiet" size="sm" disabled={busy}
                    onClick={() => void run(() => revokeRecall(rosterId).then(() => { setScopes(new Set()); }), t('recallRevoked'))}>
                    {t('revokeRecall')}
                  </Button>
                ) : null}
              </div>
              <p className="muted u-fs-12 u-m-0">
                {/* TWIN-UX-18 — `' + '` was a hardcoded English list join, and the
                    empty-scope fallback spliced "nothing"/"nada"/"rien" into the
                    sentence ("Ada can recall your nothing."). A zero-scope grant is
                    reachable from the server, so it gets its OWN sentence. */}
                {!view.grant
                  ? t('noRecallGranted', { persona })
                  : view.grant.scopes.length === 0
                    ? t('recallActiveEmpty', { persona })
                    : t('recallActive', {
                        persona,
                        scopes: new Intl.ListFormat(i18n.language, { style: 'long', type: 'conjunction' })
                          .format(view.grant.scopes.map((s) => (s === 'memory' ? t('scopeMemory') : t('scopeKnowledge')))),
                      })}
              </p>
            </fieldset>
          ) : mine === 'unknown' ? (
            // TWIN-16 — the else-branch asserted "Only {{name}} can allow…" using
            // an id that may be the VIEWER'S OWN. `:161` was written to avoid
            // exactly that claim; this branch had not been.
            <p className="muted u-fs-12 u-m-0">{t('identityUnknown')}</p>
          ) : (
            <p className="muted u-fs-12 u-m-0">{t('onlyLinkedCanAllow', { name: linkedName ?? link.userId, persona })}</p>
          )}
        </div>
      )}
    </div>
  );
}
