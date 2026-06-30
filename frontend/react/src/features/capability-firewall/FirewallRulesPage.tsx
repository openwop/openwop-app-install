/**
 * ADR 0135 — the Capability Firewall rule manager (admin), clarity redesign.
 *
 * The rule model is unchanged (server is authority): a rule fires when the run has
 * done ANY of [classes] AND the next tool is in [classes] → verdict. What changed
 * is comprehension — the page now explains what the firewall is, speaks the RFC
 * 0078 safetyTier/egress classes in plain language (the raw class stays as a
 * tooltip), offers the recommended read→send rule in one click, renders every rule
 * and the builder as a sentence, and frames the unclassified-tools control by its
 * consequence.
 *
 * @see docs/adr/0135-capability-firewall.md
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { useHub } from '../../chrome/hubContext.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { toast } from '../../ui/toast.js';
import { ShieldIcon } from '../../ui/icons/index.js';
import { confirm } from '../../ui/confirm.js';
import {
  listOrgs, getFirewallRules, setFirewallRules,
  type Org, type FirewallRule, type CapabilityClass, type SafetyTier, type Egress, type UnknownToolPolicy,
} from './firewallClient.js';

const SAFETY_TIERS: SafetyTier[] = ['pure', 'read', 'write', 'exec'];
const EGRESSES: Egress[] = ['none', 'safe-fetch', 'host-mediated', 'host-owned'];

/** i18n key for each class's plain-language label. */
const TIER_KEY: Record<SafetyTier, string> = { pure: 'tierPure', read: 'tierRead', write: 'tierWrite', exec: 'tierExec' };
const EGRESS_KEY: Record<Egress, string> = {
  none: 'egrNone', 'safe-fetch': 'egrSafeFetch', 'host-mediated': 'egrHostMediated', 'host-owned': 'egrHostOwned',
};

/** Stable identity for a class (the raw wire form). */
const classKey = (c: CapabilityClass): string =>
  'safetyTier' in c ? `safetyTier:${c.safetyTier}` : 'egress' in c ? `egress:${c.egress}` : `scope:${c.scope}`;

type T = ReturnType<typeof useTranslation>['t'];
/** Plain-language label; the raw class rides along as a tooltip via `classKey`. */
const humanClass = (c: CapabilityClass, t: T): string =>
  'safetyTier' in c ? t(TIER_KEY[c.safetyTier])
    : 'egress' in c ? t(EGRESS_KEY[c.egress])
      : t('scopeClass', { scope: c.scope, defaultValue: 'scope: {{scope}}' });

/** The ADR 0135 canonical exfiltration guard: read data, then send it off-host. */
const recommendedRule = (t: T): FirewallRule => ({
  id: `rule-${Date.now().toString(36)}`,
  description: t('recommendedDesc', { defaultValue: 'Reading data then sending it off-host' }),
  when: { anyOf: [{ safetyTier: 'read' }], with: [{ egress: 'host-mediated' }, { egress: 'host-owned' }] },
  verdict: 'require-approval',
  reason: t('recommendedReason', { defaultValue: 'This run read data and is about to send it off-host — approve to proceed.' }),
});

export function FirewallRulesPage(): JSX.Element {
  const { t } = useTranslation('capability-firewall');
  const { embedded } = useHub();
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [orgId, setOrgId] = useState('');
  const [rules, setRules] = useState<FirewallRule[] | null>(null);
  const [isDefault, setIsDefault] = useState(true);
  const [unknownPolicy, setUnknownPolicy] = useState<UnknownToolPolicy>('skip');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // add-form state
  const [anyOf, setAnyOf] = useState<CapabilityClass[]>([]);
  const [withC, setWithC] = useState<CapabilityClass[]>([]);
  const [verdict, setVerdict] = useState<'deny' | 'require-approval'>('require-approval');
  const [reason, setReason] = useState('');

  useEffect(() => {
    void listOrgs().then((o) => { setOrgs(o); setOrgId((cur) => cur || (o[0]?.orgId ?? '')); })
      .catch((e) => setError(e instanceof Error ? e.message : t('loadOrgsFailed', { defaultValue: 'Failed to load organizations.' })));
  }, [t]);

  const load = useCallback((org: string) => {
    void getFirewallRules(org).then((r) => { setRules(r.rules); setIsDefault(r.isDefault); setUnknownPolicy(r.unknownToolPolicy); })
      .catch((e) => setError(e instanceof Error ? e.message : t('loadFailed', { defaultValue: 'Failed to load rules.' })));
  }, [t]);
  useEffect(() => { if (orgId) load(orgId); }, [orgId, load]);

  const save = async (next: FirewallRule[], policy: UnknownToolPolicy = unknownPolicy): Promise<void> => {
    setBusy(true);
    try { const r = await setFirewallRules(orgId, next, policy); setRules(r.rules); setIsDefault(r.isDefault); setUnknownPolicy(r.unknownToolPolicy); toast.success(t('saved', { defaultValue: 'Firewall rules saved' })); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('saveFailed', { defaultValue: 'Failed to save rules.' })); }
    finally { setBusy(false); }
  };

  const toggleClass = (list: CapabilityClass[], setList: (v: CapabilityClass[]) => void, c: CapabilityClass): void => {
    const k = classKey(c);
    setList(list.some((x) => classKey(x) === k) ? list.filter((x) => classKey(x) !== k) : [...list, c]);
  };

  const addRule = (): void => {
    if (withC.length === 0) { toast.error(t('needWith', { defaultValue: 'Pick at least one thing the next tool might do.' })); return; }
    const desc = reason || t('customRule', { defaultValue: 'Custom rule' });
    const rule: FirewallRule = {
      id: crypto.randomUUID(),
      description: desc,
      when: { ...(anyOf.length ? { anyOf } : {}), with: withC },
      verdict,
      reason: desc,
    };
    void save([...(rules ?? []), rule]);
    setAnyOf([]); setWithC([]); setReason('');
  };

  const addRecommended = (): void => { void save([...(rules ?? []), recommendedRule(t)]); };

  const removeRule = async (r: FirewallRule): Promise<void> => {
    if (!(await confirm({ title: t('removeRuleConfirm', { defaultValue: 'Remove this rule?' }), danger: true, confirmLabel: t('remove', { defaultValue: 'Remove' }) }))) return;
    await save((rules ?? []).filter((x) => x.id !== r.id));
  };

  if (orgs === null) return <StateCard loading title={t('loading', { defaultValue: 'Loading…' })} />;
  if (orgs && orgs.length === 0) {
    return <StateCard icon={<ShieldIcon size={28} />} title={t('noOrgsTitle', { defaultValue: 'No organizations' })} body={t('noOrgsBody', { defaultValue: 'Create an organization to configure the capability firewall.' })} />;
  }
  if (orgId && rules === null) return <StateCard loading title={t('loading', { defaultValue: 'Loading…' })} />;

  const list = rules ?? [];
  const hasRecommended = list.some((r) => (r.when.anyOf ?? []).some((c) => classKey(c) === 'safetyTier:read')
    && (r.when.with ?? []).some((c) => classKey(c).startsWith('egress:host-')));

  return (
    <div className="u-flex u-flex-col u-gap-3">
      {embedded ? null : <PageHeader eyebrow={t('eyebrow', { defaultValue: 'Access & data' })} title={t('title', { defaultValue: 'Capability firewall' })} lede={t('lede', { defaultValue: 'Require approval (or block) when an AI run combines risky steps — like reading data and then sending it off-host.' })} />}
      {error && <Notice variant="error">{error}</Notice>}

      {/* What this is — the comprehension fix */}
      <Notice variant="info">
        <strong>{t('whatTitle', { defaultValue: 'What this does' })}</strong>
        <p className="u-mt-1 u-mb-0">{t('whatBody', { defaultValue: 'AI agents call tools to get work done. Reading data is fine; sending data out is fine — but reading data and then sending it off-host is how information leaks. This firewall watches the combination of what a run has already done and what a tool is about to do, and can pause for approval or block it.' })}</p>
      </Notice>

      <div className="u-flex u-flex-wrap u-items-center u-gap-3">
        <label className="u-flex u-items-center u-gap-2 u-fs-12">
          {t('org', { defaultValue: 'Organization' })}
          <select value={orgId} onChange={(e) => setOrgId(e.target.value)} aria-label={t('org', { defaultValue: 'Organization' })}>
            {(orgs ?? []).map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
          </select>
          {isDefault && <span className="chip chip--muted u-fs-11">{t('usingDefault', { defaultValue: 'using default' })}</span>}
        </label>
      </div>

      {/* Rules */}
      <section aria-labelledby="cf-rules-h" className="u-flex u-flex-col u-gap-2">
        <h2 id="cf-rules-h" className="u-fs-13">{t('rulesHeading', { defaultValue: 'Active rules' })}</h2>
        {list.length === 0 ? (
          <StateCard
            icon={<ShieldIcon size={28} />}
            title={t('emptyTitle', { defaultValue: 'On, but watching nothing yet' })}
            body={t('emptyBody', { defaultValue: 'No rules means every tool combination is allowed. Add the recommended rule below, or build your own.' })}
          />
        ) : (
          <ul className="u-list-none u-p-0 u-flex u-flex-col u-gap-2">
            {list.map((r) => (
              <li key={r.id} className="surface-card u-pad-2 u-flex u-flex-col u-gap-1">
                <div className="u-flex u-items-center u-justify-between u-gap-2">
                  <span className="u-fs-12 u-fw-600">{r.description || r.id}</span>
                  <span className={`chip u-fs-11 ${r.verdict === 'deny' ? 'chip--danger' : 'chip--warning'}`}>
                    {t(r.verdict === 'deny' ? 'verdictDeny' : 'verdictRequireApproval', { defaultValue: r.verdict })}
                  </span>
                </div>
                <RuleSentence rule={r} t={t} />
                <div>
                  <button type="button" className="secondary u-fs-11" disabled={busy} onClick={() => void removeRule(r)} aria-label={t('removeRuleAria', { desc: r.description || r.id, defaultValue: 'Remove rule {{desc}}' })}>
                    {t('remove', { defaultValue: 'Remove' })}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {!hasRecommended && (
          <div className="surface-card u-pad-2 u-flex u-flex-wrap u-items-center u-justify-between u-gap-2">
            <div className="u-flex u-flex-col u-gap-1">
              <span className="u-fs-12 u-fw-600">{t('recommendedTitle', { defaultValue: 'Recommended rule' })}</span>
              <span className="muted u-fs-11">{t('recommendedBody', { defaultValue: 'Ask for approval when a run reads data and a tool then tries to send it off-host — the most common leak.' })}</span>
            </div>
            <button type="button" className="btn-primary u-fs-12" disabled={busy} onClick={addRecommended}>{t('recommendedAdd', { defaultValue: 'Add recommended rule' })}</button>
          </div>
        )}
      </section>

      {/* Builder */}
      <section aria-labelledby="cf-add-h" className="surface-card u-pad-2 u-flex u-flex-col u-gap-2">
        <h2 id="cf-add-h" className="u-fs-13">{t('addHeading', { defaultValue: 'Build a rule' })}</h2>
        <ClassPicker legend={t('anyOfLegend', { defaultValue: 'If a run has already…' })} hint={t('anyOfHint', { defaultValue: 'leave blank to match any run' })} selected={anyOf} onToggle={(c) => toggleClass(anyOf, setAnyOf, c)} />
        <ClassPicker legend={t('withLegend', { defaultValue: '…and a tool then tries to…' })} selected={withC} onToggle={(c) => toggleClass(withC, setWithC, c)} />
        <label className="u-flex u-items-center u-gap-2 u-fs-12">
          {t('verdictLabel', { defaultValue: 'then' })}
          <select value={verdict} onChange={(e) => setVerdict(e.target.value as 'deny' | 'require-approval')} aria-label={t('verdictLabel', { defaultValue: 'then' })}>
            <option value="require-approval">{t('verdictRequireApproval', { defaultValue: 'require approval' })}</option>
            <option value="deny">{t('verdictDeny', { defaultValue: 'deny' })}</option>
          </select>
        </label>
        {/* Live preview of the rule as a sentence — region stays mounted so SRs announce it */}
        <p className="muted u-fs-11 u-mb-0" aria-live="polite">
          {withC.length > 0 ? <>{t('previewLabel', { defaultValue: 'Preview' })}: <RulePreview anyOf={anyOf} withC={withC} verdict={verdict} t={t} /></> : null}
        </p>
        <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('reasonPlaceholder', { defaultValue: 'Reason shown to the user (optional)' })} aria-label={t('reasonPlaceholder', { defaultValue: 'Reason shown to the user' })} className="u-fs-12" />
        <div><button type="button" className="btn-primary u-fs-12" disabled={busy || withC.length === 0} onClick={addRule}>{t('addRule', { defaultValue: 'Add rule' })}</button></div>
      </section>

      {/* Unclassified-tools posture — framed by consequence */}
      <section aria-labelledby="cf-policy-h" className="u-flex u-flex-col u-gap-2">
        <h2 id="cf-policy-h" className="u-fs-13">{t('policyHeading', { defaultValue: 'Tools we can’t classify' })}</h2>
        <fieldset className="u-border-0 u-p-0 u-m-0 u-flex u-flex-col u-gap-2">
          <legend className="muted u-fs-11">{t('policyBody', { defaultValue: 'Custom and third-party tools may not be classified yet. Choose what the firewall assumes about them.' })}</legend>
          <label className="u-flex u-items-center u-gap-2 u-fs-12">
            <input type="radio" name="cf-policy" checked={unknownPolicy === 'skip'} disabled={busy} onChange={() => void save(rules ?? [], 'skip')} />
            {t('policySkipLabel', { defaultValue: 'Allow them — only classified tools are checked' })}
          </label>
          <label className="u-flex u-items-center u-gap-2 u-fs-12">
            <input type="radio" name="cf-policy" checked={unknownPolicy === 'treat-as-risky'} disabled={busy} onChange={() => void save(rules ?? [], 'treat-as-risky')} />
            {t('policyRiskyLabel', { defaultValue: 'Treat as risky — safer, but may prompt for approval more often' })}
          </label>
        </fieldset>
      </section>
    </div>
  );
}

/** Render a saved rule as a plain-language sentence. */
function RuleSentence({ rule, t }: { rule: FirewallRule; t: T }): JSX.Element {
  const hasAny = (rule.when.anyOf ?? []).length > 0;
  return (
    <div className="u-flex u-flex-wrap u-items-center u-gap-1 u-fs-11">
      {hasAny ? (
        <>
          <span className="muted">{t('sentRunDid', { defaultValue: 'If a run did' })}</span>
          {(rule.when.anyOf ?? []).map((c) => <span key={classKey(c)} title={classKey(c)} className="chip chip--muted">{humanClass(c, t)}</span>)}
          <span className="muted">{t('sentAndTool', { defaultValue: 'and a tool tries to' })}</span>
        </>
      ) : (
        <span className="muted">{t('sentToolOnly', { defaultValue: 'If a tool tries to' })}</span>
      )}
      {(rule.when.with ?? []).map((c) => <span key={classKey(c)} title={classKey(c)} className="chip chip--accent">{humanClass(c, t)}</span>)}
    </div>
  );
}

/** Live sentence preview in the builder. */
function RulePreview({ anyOf, withC, verdict, t }: { anyOf: CapabilityClass[]; withC: CapabilityClass[]; verdict: 'deny' | 'require-approval'; t: T }): JSX.Element {
  const join = (cs: CapabilityClass[]) => cs.map((c) => humanClass(c, t)).join(t('orJoin', { defaultValue: ' or ' }));
  const head = anyOf.length
    ? t('previewWithAny', { any: join(anyOf), next: join(withC), defaultValue: 'If a run did {{any}} and a tool tries to {{next}}' })
    : t('previewNoAny', { next: join(withC), defaultValue: 'If a tool tries to {{next}}' });
  const tail = t(verdict === 'deny' ? 'previewDeny' : 'previewApproval', { defaultValue: verdict === 'deny' ? 'block it' : 'ask for approval' });
  return <span className="u-fw-600">{head} → {tail}.</span>;
}

function ClassPicker({ legend, hint, selected, onToggle }: { legend: string; hint?: string; selected: CapabilityClass[]; onToggle: (c: CapabilityClass) => void }): JSX.Element {
  const { t } = useTranslation('capability-firewall');
  const has = (c: CapabilityClass): boolean => selected.some((x) => classKey(x) === classKey(c));
  const chip = (c: CapabilityClass, key: string) => (
    <button key={key} type="button" aria-pressed={has(c)} title={classKey(c)} className={`chip u-fs-11 ${has(c) ? 'chip--accent' : 'chip--muted'}`} onClick={() => onToggle(c)}>
      {humanClass(c, t)}
    </button>
  );
  return (
    <fieldset className="u-border-0 u-p-0 u-m-0">
      <legend className="u-fs-12 u-fw-600">{legend}{hint ? <span className="muted u-fw-400"> — {hint}</span> : null}</legend>
      <div className="u-mt-1 u-flex u-flex-col u-gap-1">
        <div className="u-flex u-flex-wrap u-items-center u-gap-1">
          <span className="muted u-fs-11">{t('groupAction', { defaultValue: 'do this:' })}</span>
          {SAFETY_TIERS.map((s) => chip({ safetyTier: s }, `st-${s}`))}
        </div>
        <div className="u-flex u-flex-wrap u-items-center u-gap-1">
          <span className="muted u-fs-11">{t('groupData', { defaultValue: 'with data:' })}</span>
          {EGRESSES.map((g) => chip({ egress: g }, `eg-${g}`))}
        </div>
      </div>
    </fieldset>
  );
}
