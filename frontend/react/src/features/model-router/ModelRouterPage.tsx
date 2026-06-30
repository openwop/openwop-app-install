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
const COND_KINDS: CondKind[] = ['always', 'attachment', 'tokensOver', 'intentIs'];

const emptyTarget = (): RoutingTarget => ({ provider: '', model: '' });
const targetValid = (t: RoutingTarget): boolean => t.provider.trim().length > 0 && t.model.trim().length > 0;

function condLabel(c: RuleCondition, t: ReturnType<typeof useTranslation>['t']): string {
  switch (c.kind) {
    case 'always': return t('condAlways', { defaultValue: 'always' });
    case 'attachment': return t('condAttachment', { defaultValue: 'has an attachment' });
    case 'tokensOver': return t('condTokensOver', { defaultValue: 'tokens over {{n}}', n: c.threshold });
    case 'intentIs': return t('condIntentIs', { defaultValue: 'intent is “{{intent}}”', intent: c.intent });
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // add-rule form state
  const [kind, setKind] = useState<CondKind>('always');
  const [threshold, setThreshold] = useState('8000');
  const [intent, setIntent] = useState('');
  const [target, setTarget] = useState<RoutingTarget>(emptyTarget());

  useEffect(() => {
    void listOrgs().then((o) => { setOrgs(o); setOrgId((cur) => cur || (o[0]?.orgId ?? '')); })
      .catch((e) => setError(e instanceof Error ? e.message : t('loadOrgsFailed', { defaultValue: 'Failed to load organizations.' })));
  }, [t]);

  const load = useCallback((org: string) => {
    void getRouterConfig(org).then((stored) => {
      setHasConfig(stored !== null);
      setEnabled(stored?.enabled ?? false);
      setRules(stored?.config.rules ?? []);
      setFallback(stored?.config.fallback ?? emptyTarget());
    }).catch((e) => setError(e instanceof Error ? e.message : t('loadFailed', { defaultValue: 'Failed to load routing config.' })));
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
      case 'intentIs': {
        if (!intent.trim()) { toast.error(t('badIntent', { defaultValue: 'Enter an intent label.' })); return null; }
        return { kind: 'intentIs', intent: intent.trim() };
      }
    }
  };

  const addRule = (): void => {
    if (!targetValid(target)) { toast.error(t('needRuleTarget', { defaultValue: 'Set the rule’s provider and model.' })); return; }
    const when = buildCondition();
    if (!when) return;
    const rule: RoutingRule = { when, target: { provider: target.provider.trim(), model: target.model.trim() } };
    void persist([...rules, rule], fallback);
    setKind('always'); setThreshold('8000'); setIntent(''); setTarget(emptyTarget());
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

      <div className="u-flex u-items-end u-gap-2">
        <SelectField label={t('org', { defaultValue: 'Organization' })} className="u-w-auto" value={orgId} onChange={(e) => setOrgId(e.target.value)}>
          {(orgs ?? []).map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
        </SelectField>
        {!hasConfig && <span className="chip chip--muted u-fs-11">{t('notConfigured', { defaultValue: 'not configured' })}</span>}
      </div>

      <label className="u-flex u-items-center u-gap-2 u-fs-12">
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy || !hasConfig}
          onChange={(e) => void toggleEnabled(e.target.checked)}
        />
        {t('enableLabel', { defaultValue: 'Routing enabled for this organization' })}
        {!hasConfig && <span className="muted u-fs-11">{t('enableHint', { defaultValue: '(save a config first)' })}</span>}
      </label>

      <section aria-labelledby="mr-fallback-h" className="surface-card u-pad-2 u-flex u-flex-col u-gap-2">
        <h3 id="mr-fallback-h" className="u-fs-13">{t('fallbackHeading', { defaultValue: 'Fallback target (required)' })}</h3>
        <p className="muted u-fs-11">{t('fallbackHint', { defaultValue: 'Used when no rule matches — should be vision-capable so attachment turns always have an eligible target.' })}</p>
        <TargetInputs value={fallback} onChange={setFallback} idPrefix="mr-fb" />
        <div><button type="button" className="btn-primary u-fs-12" disabled={busy} onClick={() => void persist(rules, fallback)}>{t('saveFallback', { defaultValue: 'Save routing' })}</button></div>
      </section>

      <section aria-labelledby="mr-rules-h">
        <h3 id="mr-rules-h" className="u-fs-13">{t('rulesHeading', { defaultValue: 'Rules' })}</h3>
        {rules.length === 0 && <p className="muted u-fs-12">{t('noRules', { defaultValue: 'No rules — every turn uses the fallback target.' })}</p>}
        <ul className="u-list-none u-p-0 u-flex u-flex-col u-gap-2 u-mt-1">
          {rules.map((r, i) => (
            <li key={`${r.when.kind}-${i}`} className="surface-card u-pad-2 u-flex u-items-center u-justify-between u-gap-2">
              <div className="u-flex u-flex-wrap u-items-center u-gap-1 u-fs-11">
                <span className="chip chip--muted">{condLabel(r.when, t)}</span>
                <span className="muted">{t('routesTo', { defaultValue: '→ route to' })}</span>
                <span className="chip chip--accent">{r.target.provider}/{r.target.model}</span>
              </div>
              <button type="button" className="secondary u-fs-11" disabled={busy} onClick={() => void persist(rules.filter((_, j) => j !== i), fallback)} aria-label={t('removeAria', { defaultValue: 'Remove rule' })}>{t('remove', { defaultValue: 'Remove' })}</button>
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
        {kind === 'intentIs' && (
          <label className="u-flex u-items-center u-gap-2 u-fs-12">
            {t('intentLabel', { defaultValue: 'Intent label' })}
            <input type="text" value={intent} onChange={(e) => setIntent(e.target.value)} placeholder={t('intentPlaceholder', { defaultValue: 'e.g. code' })} aria-label={t('intentLabel', { defaultValue: 'Intent label' })} className="u-fs-12" />
          </label>
        )}
        <fieldset className="u-border-0 u-p-0 u-m-0">
          <legend className="u-fs-12 u-fw-600">{t('targetLegend', { defaultValue: 'Route to' })}</legend>
          <TargetInputs value={target} onChange={setTarget} idPrefix="mr-rt" />
        </fieldset>
        <div><button type="button" className="btn-primary u-fs-12" disabled={busy} onClick={addRule}>{t('addRule', { defaultValue: 'Add rule' })}</button></div>
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
