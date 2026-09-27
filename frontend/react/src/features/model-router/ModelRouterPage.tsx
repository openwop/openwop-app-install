/**
 * ADR 0130 Phase 5 — the rule-based model-router config manager (admin).
 *
 * Org picker → the org's routing rules. Each rule is "when <condition> → route to
 * <provider>/<model>"; a required fallback target catches every other turn. An enable
 * toggle gates the dispatch stage (disabled until a config is saved — the backend 404s
 * `/enable` otherwise). The server validates + is authority. The per-turn "which model
 * answered" signal is already shown on each message (ADR 0124 provenance), so there is
 * no separate transparency chip here.
 *
 * @see docs/adr/0130-rule-based-model-router.md
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { useHub } from '../../chrome/hubContext.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { SelectField } from '../../ui/Field.js';
import { toast } from '../../ui/toast.js';
import { WorkflowIcon } from '../../ui/icons/index.js';
import {
  listOrgs, getRouterConfig, setRouterConfig, setRouterEnabled,
  type Org, type RoutingRule, type RoutingTarget, type RuleCondition,
} from './modelRouterClient.js';

type CondKind = RuleCondition['kind'];
const COND_KINDS: CondKind[] = ['always', 'attachment', 'tokensOver', 'difficultyAtLeast', 'conversationKind'];
const DIFFICULTY_LEVELS = ['low', 'medium', 'high'] as const;
const CONVERSATION_KINDS = ['group', 'workspace', 'channel'] as const;

const emptyTarget = (): RoutingTarget => ({ provider: '', model: '' });
const targetValid = (t: RoutingTarget): boolean => t.provider.trim().length > 0 && t.model.trim().length > 0;

function condLabel(c: RuleCondition, t: ReturnType<typeof useTranslation>['t']): string {
  switch (c.kind) {
    case 'always': return t('condAlways', { defaultValue: 'always' });
    case 'attachment': return t('condAttachment', { defaultValue: 'has an attachment' });
    case 'tokensOver': return t('condTokensOver', { defaultValue: 'tokens over {{n}}', n: c.threshold });
    case 'difficultyAtLeast': return t('condDifficultyAtLeast', { defaultValue: 'difficulty is at least {{level}}', level: c.level });
    case 'conversationKind': return t('condConversationKind', { defaultValue: 'conversation is a {{value}}', value: c.value });
  }
}

export function ModelRouterPage(): JSX.Element {
  const { t } = useTranslation('model-router');
  const { embedded } = useHub(); // a tab inside the Models console → drop our own header
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [orgId, setOrgId] = useState('');
  const [rules, setRules] = useState<RoutingRule[]>([]);
  const [fallback, setFallback] = useState<RoutingTarget>(emptyTarget());
  const [enabled, setEnabled] = useState(false);
  const [hasConfig, setHasConfig] = useState(false);
  /** MR-G1 — the stored config could not be READ, so every write on this page
   *  would be built on state we do not have. Distinct from , which
   *  means we read successfully and there is none. */
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // add-rule form state
  const [kind, setKind] = useState<CondKind>('always');
  const [threshold, setThreshold] = useState('8000');
  const [conversationKind, setConversationKind] = useState<(typeof CONVERSATION_KINDS)[number]>('group');
  const [difficulty, setDifficulty] = useState<(typeof DIFFICULTY_LEVELS)[number]>('high');
  const [target, setTarget] = useState<RoutingTarget>(emptyTarget());

  useEffect(() => {
    void listOrgs().then((o) => { setOrgs(o); setOrgId((cur) => cur || (o[0]?.orgId ?? '')); })
      .catch((e) => setError(e instanceof Error ? e.message : t('loadOrgsFailed', { defaultValue: 'Failed to load organizations.' })));
  }, [t]);

  const load = useCallback((org: string) => {
    setLoadFailed(false);
    void getRouterConfig(org).then((stored) => {
      setHasConfig(stored !== null);
      setEnabled(stored?.enabled ?? false);
      setRules(stored?.config.rules ?? []);
      setFallback(stored?.config.fallback ?? emptyTarget());
      setError(null);
    }).catch((e) => {
      // MR-G1 — the editor's writes send the WHOLE config (`persist(rules, …)`),
      // so an unread config plus an enabled Save silently replaces every stored
      // rule with the empty list this page happens to be holding. The `enabled`
      // toggle was already gated on `hasConfig`; the DESTRUCTIVE controls were
      // not. A failed read must disable the writes, not just report itself.
      setLoadFailed(true);
      setError(e instanceof Error ? e.message : t('loadFailed', { defaultValue: 'Failed to load routing config.' }));
    });
  }, [t]);
  useEffect(() => { if (orgId) load(orgId); }, [orgId, load]);

  const persist = async (nextRules: RoutingRule[], nextFallback: RoutingTarget): Promise<void> => {
    if (!targetValid(nextFallback)) { toast.error(t('needFallback', { defaultValue: 'Set a fallback provider and model first.' })); return; }
    setBusy(true);
    try {
      const stored = await setRouterConfig(orgId, { rules: nextRules, fallback: { provider: nextFallback.provider.trim(), model: nextFallback.model.trim() } });
      setHasConfig(true); setEnabled(stored.enabled); setRules(stored.config.rules); setFallback(stored.config.fallback);
      toast.success(t('saved', { defaultValue: 'Routing config saved' }));
    } catch (e) { toast.error(e instanceof Error ? e.message : t('saveFailed', { defaultValue: 'Could not save routing config.' })); }
    finally { setBusy(false); }
  };

  const toggleEnabled = async (next: boolean): Promise<void> => {
    setBusy(true);
    try { const stored = await setRouterEnabled(orgId, next); setEnabled(stored.enabled); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('toggleFailed', { defaultValue: 'Could not change routing state.' })); }
    finally { setBusy(false); }
  };

  const buildCondition = (): RuleCondition | null => {
    switch (kind) {
      case 'always': return { kind: 'always' };
      case 'attachment': return { kind: 'attachment' };
      case 'tokensOver': {
        const n = Number(threshold);
        if (!Number.isFinite(n) || n < 0) { toast.error(t('badThreshold', { defaultValue: 'Token threshold must be a non-negative number.' })); return null; }
        return { kind: 'tokensOver', threshold: Math.floor(n) };
      }
      case 'difficultyAtLeast': return { kind: 'difficultyAtLeast', level: difficulty };
      case 'conversationKind': return { kind: 'conversationKind', value: conversationKind };
    }
  };

  const addRule = (): void => {
    if (!targetValid(target)) { toast.error(t('needRuleTarget', { defaultValue: 'Set the rule’s provider and model.' })); return; }
    const when = buildCondition();
    if (!when) return;
    const rule: RoutingRule = { when, target: { provider: target.provider.trim(), model: target.model.trim() } };
    void persist([...rules, rule], fallback);
    setKind('always'); setThreshold('8000'); setTarget(emptyTarget());
  };

  // Inside the Models console the console owns the page chrome → no header here.
  const header = embedded ? null : (
    <PageHeader
      eyebrow={t('eyebrow', { defaultValue: 'Platform' })}
      title={t('title', { defaultValue: 'Model routing' })}
      lede={t('lede', { defaultValue: 'Send each chat turn to the right model by rule — cheaper models for simple turns, stronger ones when it matters.' })}
    />
  );

  // Designed loading state — keep the header stable and skeleton the config
  // surfaces, so the org picker + cards don't flash empty before orgs resolve.
  if (orgs === null && !error) {
    return (
      <div className="u-flex u-flex-col u-gap-3" aria-busy="true">
        {header}
        {embedded ? null : <Skeleton width={220} height={28} />}
        <div className="surface-card u-pad-2 u-flex u-flex-col u-gap-2"><Skeleton width="40%" height={16} /><Skeleton width="100%" height={36} /></div>
        <div className="surface-card u-pad-2 u-flex u-flex-col u-gap-2"><Skeleton width="30%" height={16} /><Skeleton width="100%" height={36} /></div>
      </div>
    );
  }

  if (orgs && orgs.length === 0) {
    return <StateCard icon={<WorkflowIcon size={28} />} title={t('noOrgsTitle', { defaultValue: 'No organizations' })} body={t('noOrgsBody', { defaultValue: 'Create an organization to configure model routing.' })} />;
  }

  return (
    <div className="u-flex u-flex-col u-gap-3">
      {header}
      {error && <Notice variant="error">{error}</Notice>}
      {/* `announce` is REQUIRED, not decoration: `variant="warning"` renders
          role="status"/aria-live="polite", and a live region that ARRIVES
          complete announces nothing. Only the `error` variant is assertive. This
          disclosure was silent to screen readers until 2026-08-10 and the gate
          could not see it — see check-notice-announce.mjs FAILED_READ_GATE. */}
      {loadFailed && (
        <Notice variant="warning" announce={t('loadFailedGuard', { defaultValue: 'Editing is disabled because the current routing config could not be read — saving now would replace every stored rule with what is on screen.' })}>
          {t('loadFailedGuard', { defaultValue: 'Editing is disabled because the current routing config could not be read — saving now would replace every stored rule with what is on screen.' })}{' '}
          <Button variant="quiet" size="sm" onClick={() => orgId && load(orgId)}>
            {t('retryLoad', { defaultValue: 'Try again' })}
          </Button>
        </Notice>
      )}

      <div className="u-flex u-items-end u-gap-2">
        <SelectField label={t('org', { defaultValue: 'Organization' })} className="u-w-auto u-mb-0" value={orgId} onChange={(e) => setOrgId(e.target.value)}>
          {(orgs ?? []).map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
        </SelectField>
        {!hasConfig && <span className="chip chip--muted u-fs-11">{t('notConfigured', { defaultValue: 'not configured' })}</span>}
      </div>

      <label className="u-flex u-items-center u-gap-2 u-fs-12">
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy || loadFailed || !hasConfig}
          onChange={(e) => void toggleEnabled(e.target.checked)}
        />
        {t('enableLabel', { defaultValue: 'Routing enabled for this organization' })}
        {!hasConfig && <span className="muted u-fs-11">{t('enableHint', { defaultValue: '(save a config first)' })}</span>}
      </label>

      <section aria-labelledby="mr-fallback-h" className="surface-card u-pad-2 u-flex u-flex-col u-gap-2">
        <h2 id="mr-fallback-h" className="u-fs-13">{t('fallbackHeading', { defaultValue: 'Fallback target (required)' })}</h2>
        <p className="muted u-fs-11">{t('fallbackHint', { defaultValue: 'Used when no rule matches — should be vision-capable so attachment turns always have an eligible target.' })}</p>
        <TargetInputs value={fallback} onChange={setFallback} idPrefix="mr-fb" />
        <div><Button variant="primary" className="u-fs-12" disabled={busy || loadFailed} onClick={() => void persist(rules, fallback)}>{t('saveFallback', { defaultValue: 'Save routing' })}</Button></div>
      </section>

      <section aria-labelledby="mr-rules-h">
        <h3 id="mr-rules-h" className="u-fs-13">{t('rulesHeading', { defaultValue: 'Rules' })}</h3>
        {/* MR-R2-1 — `rules` is `useState<RoutingRule[]>([])`, i.e. NOT nullable,
            so a failed load leaves it `[]` and this line asserted "every turn
            uses the fallback target" — a claim about live routing behaviour we
            could not read.
            Gated rather than made nullable on purpose: `rules` is read at ~12
            sites and `persist(rules, fallback)` writes the WHOLE config, so a
            nullable type ripples through every one — and MR-G1 already solved
            the dangerous half by disabling every save while `loadFailed`. What
            was left was the sentence, so the sentence is what changed.

            A TERNARY, not a bare gate. The first cut just suppressed the line,
            which left this section as a bare "Rules" heading with nothing under
            it. The `loadFailed` warning is at the TOP of the page — ~34 lines
            and two <section>s above — so an empty heading here reads as "no
            rules", which is the same false impression the gate was meant to
            remove. Same reasoning as CreatorInsightsPage: a failed read gets its
            own sentence rather than a blank. */}
        {loadFailed ? (
          <p className="muted u-fs-12">{t('rulesUnknown', { defaultValue: 'The current rules could not be read, so what routing is doing right now is unknown.' })}</p>
        ) : rules.length === 0 ? (
          <p className="muted u-fs-12">{t('noRules', { defaultValue: 'No rules — every turn uses the fallback target.' })}</p>
        ) : null}
        <ul className="u-list-none u-p-0 u-flex u-flex-col u-gap-2 u-mt-1">
          {rules.map((r, i) => (
            <li key={`${r.when.kind}-${i}`} className="surface-card u-pad-2 u-flex u-flex-row u-items-center u-justify-between u-gap-2">
              <div className="u-flex u-flex-wrap u-items-center u-gap-1 u-fs-11">
                <span className="chip chip--muted">{condLabel(r.when, t)}</span>
                <span className="muted">{t('routesTo', { defaultValue: '→ route to' })}</span>
                <span className="chip chip--accent">{r.target.provider}/{r.target.model}</span>
              </div>
              <Button variant="secondary" className="u-fs-11" disabled={busy || loadFailed} onClick={() => void persist(rules.filter((_, j) => j !== i), fallback)} aria-label={t('removeAria', { defaultValue: 'Remove rule' })}>{t('remove', { defaultValue: 'Remove' })}</Button>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="mr-add-h" className="surface-card u-pad-2 u-flex u-flex-col u-gap-2">
        <h3 id="mr-add-h" className="u-fs-13">{t('addHeading', { defaultValue: 'Add a rule' })}</h3>
        <label className="u-flex u-items-center u-gap-2 u-fs-12">
          {t('whenLabel', { defaultValue: 'When' })}
          <select value={kind} onChange={(e) => setKind(e.target.value as CondKind)} aria-label={t('whenLabel', { defaultValue: 'When' })}>
            {COND_KINDS.map((k) => <option key={k} value={k}>{t(`kind_${k}`, { defaultValue: k })}</option>)}
          </select>
        </label>
        {kind === 'tokensOver' && (
          <label className="u-flex u-items-center u-gap-2 u-fs-12">
            {t('thresholdLabel', { defaultValue: 'Token threshold' })}
            <input type="number" min={0} value={threshold} onChange={(e) => setThreshold(e.target.value)} aria-label={t('thresholdLabel', { defaultValue: 'Token threshold' })} className="u-fs-12" />
          </label>
        )}
        {kind === 'difficultyAtLeast' && (
          <label className="u-flex u-items-center u-gap-2 u-fs-12">
            {t('difficultyLabel', { defaultValue: 'Difficulty at least' })}
            <select value={difficulty} onChange={(e) => setDifficulty(e.target.value as (typeof DIFFICULTY_LEVELS)[number])} aria-label={t('difficultyLabel', { defaultValue: 'Difficulty at least' })}>
              {DIFFICULTY_LEVELS.map((l) => <option key={l} value={l}>{t(`difficulty_${l}`, { defaultValue: l })}</option>)}
            </select>
          </label>
        )}
        {kind === 'conversationKind' && (
          <label className="u-flex u-items-center u-gap-2 u-fs-12">
            {t('conversationKindLabel', { defaultValue: 'Conversation kind' })}
            <select value={conversationKind} onChange={(e) => setConversationKind(e.target.value as (typeof CONVERSATION_KINDS)[number])} aria-label={t('conversationKindLabel', { defaultValue: 'Conversation kind' })}>
              {CONVERSATION_KINDS.map((k) => <option key={k} value={k}>{t(`convKind_${k}`, { defaultValue: k })}</option>)}
            </select>
            <span className="muted">{t('conversationKindHint', { defaultValue: '“group” = board / multi-agent rooms — route them to your strongest model.' })}</span>
          </label>
        )}
        <fieldset className="u-border-0 u-p-0 u-m-0">
          <legend className="u-fs-12 u-fw-600">{t('targetLegend', { defaultValue: 'Route to' })}</legend>
          <TargetInputs value={target} onChange={setTarget} idPrefix="mr-rt" />
        </fieldset>
        <div><Button variant="primary" className="u-fs-12" disabled={busy || loadFailed} onClick={addRule}>{t('addRule', { defaultValue: 'Add rule' })}</Button></div>
      </section>
    </div>
  );
}

function TargetInputs({ value, onChange, idPrefix }: { value: RoutingTarget; onChange: (t: RoutingTarget) => void; idPrefix: string }): JSX.Element {
  const { t } = useTranslation('model-router');
  return (
    <div className="u-flex u-flex-wrap u-gap-2">
      <label className="u-flex u-items-center u-gap-1 u-fs-12">
        {t('provider', { defaultValue: 'Provider' })}
        <input id={`${idPrefix}-provider`} type="text" value={value.provider} onChange={(e) => onChange({ ...value, provider: e.target.value })} placeholder={t('providerPlaceholder', { defaultValue: 'anthropic' })} aria-label={t('provider', { defaultValue: 'Provider' })} className="u-fs-12" />
      </label>
      <label className="u-flex u-items-center u-gap-1 u-fs-12">
        {t('model', { defaultValue: 'Model' })}
        <input id={`${idPrefix}-model`} type="text" value={value.model} onChange={(e) => onChange({ ...value, model: e.target.value })} placeholder={t('modelPlaceholder', { defaultValue: 'claude-opus-4-8' })} aria-label={t('model', { defaultValue: 'Model' })} className="u-fs-12" />
      </label>
    </div>
  );
}
