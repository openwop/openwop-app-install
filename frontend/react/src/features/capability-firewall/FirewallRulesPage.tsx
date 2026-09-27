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
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { useHub } from '../../chrome/hubContext.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { toast } from '../../ui/toast.js';
import { ShieldIcon } from '../../ui/icons/index.js';
import { confirm } from '../../ui/confirm.js';
import { formatDateTime } from '../../i18n/format.js';
import {
  listOrgs, getFirewallRules, setFirewallRules, getFirewallDecisions, simulateFirewall,
  type Org, type FirewallRule, type CapabilityClass, type SafetyTier, type Egress, type UnknownToolPolicy, type FirewallDecision,
  type FirewallMode, type SimulateResult,
} from './firewallClient.js';

const SAFETY_TIERS: SafetyTier[] = ['pure', 'read', 'write', 'exec'];
const EGRESSES: Egress[] = ['none', 'safe-fetch', 'host-mediated', 'host-owned'];

/** Which predicate the rule builder is authoring (exactly one kind per rule). */
type BuilderMode = 'combination' | 'volume' | 'expression';

/** i18n key for each class's plain-language label. */
const TIER_KEY: Record<SafetyTier, string> = { pure: 'tierPure', read: 'tierRead', write: 'tierWrite', exec: 'tierExec' };
const EGRESS_KEY: Record<Egress, string> = {
  none: 'egrNone', 'safe-fetch': 'egrSafeFetch', 'host-mediated': 'egrHostMediated', 'host-owned': 'egrHostOwned',
};

/** Stable identity for a class (the raw wire form). */
const classKey = (c: CapabilityClass): string =>
  'safetyTier' in c ? `safetyTier:${c.safetyTier}`
    : 'egress' in c ? `egress:${c.egress}`
      : 'kind' in c ? `kind:${c.kind}`
        : `scope:${c.scope}`;

type T = ReturnType<typeof useTranslation>['t'];
/** Plain-language label; the raw class rides along as a tooltip via `classKey`. */
const humanClass = (c: CapabilityClass, t: T): string =>
  'safetyTier' in c ? t(TIER_KEY[c.safetyTier])
    : 'egress' in c ? t(EGRESS_KEY[c.egress])
      : 'kind' in c ? t('kindFanOut', { defaultValue: 'fan out to sub-runs' })
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
  /**
   * CF-G1 — the rules/posture read FAILED, as distinct from `rules === null`
   * meaning "still loading". Every write here is a FULL REPLACEMENT
   * (`setFirewallRules(orgId, next, policy, posture)`), and on a failed load
   * `rules` is null while `mode`/`unknownPolicy`/`defaultDenyVerdict` still hold
   * their component defaults — `default-allow` and `skip`. So one click on Add
   * rule would have sent `[thatOneRule]` as the ENTIRE ruleset AND flipped a
   * default-DENY tenant to default-ALLOW with unknown tools unblocked. A
   * security control failing open, from a transient read error.
   */
  const [loadFailed, setLoadFailed] = useState(false);
  /** SWEEP — the DECISIONS read failed; `[]` would claim the firewall has never
   *  blocked anything. Separate from `loadFailed` (the rules read). */
  const [decisionsFailed, setDecisionsFailed] = useState(false);
  const [isDefault, setIsDefault] = useState(true);
  const [unknownPolicy, setUnknownPolicy] = useState<UnknownToolPolicy>('skip');
  const [mode, setMode] = useState<FirewallMode>('default-allow');
  const [defaultDenyVerdict, setDefaultDenyVerdict] = useState<'deny' | 'require-approval'>('deny');
  const [decisions, setDecisions] = useState<FirewallDecision[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // add-form state
  const [builderMode, setBuilderMode] = useState<BuilderMode>('combination');
  const [anyOf, setAnyOf] = useState<CapabilityClass[]>([]);
  const [withC, setWithC] = useState<CapabilityClass[]>([]);
  const [countClass, setCountClass] = useState<CapabilityClass | null>(null);
  const [threshold, setThreshold] = useState(3);
  const [expression, setExpression] = useState('');
  const [exprError, setExprError] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<'deny' | 'require-approval' | 'allow'>('require-approval');
  const [reason, setReason] = useState('');
  /** The orgs read FAILED. Distinct from `orgs === null` (still loading) and from
   *  `orgs === []` (this tenant genuinely has none) — and it needs its own state
   *  because the `orgs === null` early return below sits ABOVE the error Notice,
   *  so a failed read otherwise renders a spinner and the error is never shown. */
  const [orgsFailed, setOrgsFailed] = useState(false);

  useEffect(() => {
    void listOrgs().then((o) => { setOrgs(o); setOrgsFailed(false); setOrgId((cur) => cur || (o[0]?.orgId ?? '')); })
      .catch((e) => {
        // NOT `setOrgs([])`: that renders "No organizations — create an organization
        // to configure the capability firewall", an instruction a failed read has not
        // earned. A third state is required, because `null` and `[]` are both taken.
        setOrgsFailed(true);
        setError(e instanceof Error ? e.message : t('loadOrgsFailed', { defaultValue: 'Failed to load organizations.' }));
      });
  }, [t]);

  const load = useCallback((org: string) => {
    setLoadFailed(false);
    void getFirewallRules(org).then((r) => { setRules(r.rules); setIsDefault(r.isDefault); setUnknownPolicy(r.unknownToolPolicy); setMode(r.mode); setDefaultDenyVerdict(r.defaultDenyVerdict); setError(null); })
      .catch((e) => { setLoadFailed(true); setError(e instanceof Error ? e.message : t('loadFailed', { defaultValue: 'Failed to load rules.' })); });
  }, [t]);
  useEffect(() => { if (orgId) load(orgId); }, [orgId, load]);

  // ADR 0397 Phase 1 — recent firewall decisions (best-effort; an empty/failed load
  // just shows the empty state rather than blocking the rules editor).
  const loadDecisions = useCallback((org: string) => {
    setDecisions(null); setDecisionsFailed(false);
    // SWEEP — `[]` here renders "No decisions yet… when the firewall blocks or
    // holds a tool call it appears here", i.e. "this firewall has never blocked
    // anything". On a security surface that is the AU-G1 shape (#2592), not the
    // loading one my sweep heuristic predicted: the failure is real, the family
    // member is different.
    void getFirewallDecisions(org)
      .then((d) => { setDecisions(d); setDecisionsFailed(false); })
      .catch(() => { setDecisions([]); setDecisionsFailed(true); });
  }, []);
  useEffect(() => { if (orgId) loadDecisions(orgId); }, [orgId, loadDecisions]);

  /** Persist the rule set + posture. Resolves to `null` on success or the error message on
   *  failure (so the expression builder can surface a server 400 inline as well as via toast).
   *  The current mode + defaultDenyVerdict ride every save unless overridden, so editing a
   *  rule never silently reverts the posture. */
  const save = async (next: FirewallRule[], policy: UnknownToolPolicy = unknownPolicy, posture: { mode?: FirewallMode; defaultDenyVerdict?: 'deny' | 'require-approval' } = {}): Promise<string | null> => {
    // CF-G1 — the guard lives at the CHOKE POINT, not only on the controls. Every
    // caller here sends a full replacement built from state we may not have read;
    // disabling nine buttons is a UI fact, refusing the write is the guarantee.
    if (loadFailed) {
      const msg = t('loadFailedGuard', { defaultValue: 'The current firewall rules could not be read, so saving would replace them — and the posture on screen is a default, not this workspace’s.' });
      toast.error(msg);
      return msg;
    }
    setBusy(true);
    try {
      const r = await setFirewallRules(orgId, next, policy, { mode: posture.mode ?? mode, defaultDenyVerdict: posture.defaultDenyVerdict ?? defaultDenyVerdict });
      setRules(r.rules); setIsDefault(r.isDefault); setUnknownPolicy(r.unknownToolPolicy); setMode(r.mode); setDefaultDenyVerdict(r.defaultDenyVerdict);
      toast.success(t('saved', { defaultValue: 'Firewall rules saved' })); return null;
    }
    catch (e) { const msg = e instanceof Error ? e.message : t('saveFailed', { defaultValue: 'Failed to save rules.' }); toast.error(msg); return msg; }
    finally { setBusy(false); }
  };

  const toggleClass = (list: CapabilityClass[], setList: (v: CapabilityClass[]) => void, c: CapabilityClass): void => {
    const k = classKey(c);
    setList(list.some((x) => classKey(x) === k) ? list.filter((x) => classKey(x) !== k) : [...list, c]);
  };

  // Single-select for the countAtLeast builder (clicking the active chip clears it).
  const toggleCountClass = (c: CapabilityClass): void => {
    setCountClass((prev) => (prev && classKey(prev) === classKey(c) ? null : c));
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

  const addCountRule = (): void => {
    if (!countClass) { toast.error(t('needCountClass', { defaultValue: 'Pick a thing to count.' })); return; }
    if (!Number.isInteger(threshold) || threshold < 1) { toast.error(t('needThreshold', { defaultValue: 'The limit must be a whole number of 1 or more.' })); return; }
    const desc = reason || t('customRule', { defaultValue: 'Custom rule' });
    const rule: FirewallRule = {
      id: crypto.randomUUID(),
      description: desc,
      when: { countAtLeast: { class: countClass, threshold, window: 'turn' } },
      verdict,
      reason: desc,
    };
    void save([...(rules ?? []), rule]);
    setCountClass(null); setThreshold(3); setReason('');
  };

  const addExpressionRule = async (): Promise<void> => {
    setExprError(null);
    const src = expression.trim();
    if (!src) { setExprError(t('needExpression', { defaultValue: 'Enter an expression.' })); return; }
    const desc = reason || src;
    const rule: FirewallRule = { id: crypto.randomUUID(), description: desc, when: { expression: src }, verdict, reason: desc };
    const err = await save([...(rules ?? []), rule]);
    if (err) { setExprError(err); return; } // server validated the expression (fail-closed)
    setExpression(''); setReason('');
  };

  const addRecommended = (): void => { void save([...(rules ?? []), recommendedRule(t)]); };

  const removeRule = async (r: FirewallRule): Promise<void> => {
    if (!(await confirm({ title: t('removeRuleConfirm', { defaultValue: 'Remove this rule?' }), danger: true, confirmLabel: t('remove', { defaultValue: 'Remove' }) }))) return;
    await save((rules ?? []).filter((x) => x.id !== r.id));
  };

  // Ordered ABOVE the loading sentinel deliberately: this page's error Notice lives
  // further down the render, which the early return below never reaches.
  if (orgsFailed) {
    return (
      <StateCard announce
        icon={<ShieldIcon size={28} />}
        title={t('loadOrgsFailedTitle', { defaultValue: 'Could not load organizations' })}
        body={error ?? t('loadOrgsFailed', { defaultValue: 'Failed to load organizations.' })}
      />
    );
  }
  if (orgs === null) return <StateCard loading title={t('loading', { defaultValue: 'Loading…' })} />;
  if (orgs && orgs.length === 0) {
    return <StateCard icon={<ShieldIcon size={28} />} title={t('noOrgsTitle', { defaultValue: 'No organizations' })} body={t('noOrgsBody', { defaultValue: 'Create an organization to configure the capability firewall.' })} />;
  }
  // CF-G2 — the SAME shape as MEM-G1/PL-G1 (#2584): `rules === null` meant both
  // "still loading" and "the read failed", so a failure rendered a permanent
  // "Loading…" card — and, here, hid the CF-G1 guard notice below it, so the
  // operator never learned why the page was inert.
  if (orgId && rules === null && loadFailed) {
    return (
      <StateCard announce
        title={t('loadFailedTitle', { defaultValue: 'Could not load the firewall rules' })}
        body={t('loadFailedGuard', { defaultValue: 'The current firewall rules could not be read, so saving would replace them — and the posture on screen is a default, not this workspace’s.' })}
        action={<Button variant="secondary" size="sm" onClick={() => orgId && load(orgId)}>{t('retryLoad', { defaultValue: 'Try again' })}</Button>}
      />
    );
  }
  if (orgId && rules === null) return <StateCard loading title={t('loading', { defaultValue: 'Loading…' })} />;

  const list = rules ?? [];
  const hasRecommended = list.some((r) => (r.when.anyOf ?? []).some((c) => classKey(c) === 'safetyTier:read')
    && (r.when.with ?? []).some((c) => classKey(c).startsWith('egress:host-')));

  return (
    <div className="u-flex u-flex-col u-gap-3">
      {embedded ? null : <PageHeader eyebrow={t('eyebrow', { defaultValue: 'Access & data' })} title={t('title', { defaultValue: 'Capability firewall' })} lede={t('lede', { defaultValue: 'Require approval (or block) when an AI run combines risky steps — like reading data and then sending it off-host.' })} />}
      {error && <Notice variant="error">{error}</Notice>}
      {loadFailed && (
        <Notice variant="warning" announce={t('loadFailedGuard', { defaultValue: 'The current firewall rules could not be read, so saving would replace them — and the posture on screen is a default, not this workspace’s.' })}>
          {t('loadFailedGuard', { defaultValue: 'The current firewall rules could not be read, so saving would replace them — and the posture on screen is a default, not this workspace’s.' })}{' '}
          <Button variant="quiet" size="sm" onClick={() => orgId && load(orgId)}>
            {t('retryLoad', { defaultValue: 'Try again' })}
          </Button>
        </Notice>
      )}

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

      {/* ADR 0397 Phase 3/5 — enforcement posture (mode). */}
      <section aria-labelledby="cf-mode-h" className="u-flex u-flex-col u-gap-2">
        <h2 id="cf-mode-h" className="u-fs-13">{t('modeHeading', { defaultValue: 'Enforcement posture' })}</h2>
        <fieldset className="u-border-0 u-p-0 u-m-0 u-flex u-flex-col u-gap-2">
          <legend className="muted u-fs-11">{t('modeIntro', { defaultValue: 'Decide what happens to an action no rule matched. Start in shadow to see what deny-by-default would block before turning it on.' })}</legend>
          {(['default-allow', 'shadow', 'enforce'] as FirewallMode[]).map((m) => (
            <div key={m} className="u-flex u-items-start u-gap-2 u-fs-12">
              <input id={`cf-mode-${m}`} type="radio" name="cf-mode" checked={mode === m} disabled={busy || loadFailed} onChange={() => void save(rules ?? [], unknownPolicy, { mode: m })} />
              <label htmlFor={`cf-mode-${m}`} className="u-flex u-flex-col">
                <span className="u-fw-600">{t(`mode_${m}_label`, { defaultValue: m })}</span>
                <span className="muted u-fs-11">{t(`mode_${m}_body`, { defaultValue: m })}</span>
              </label>
            </div>
          ))}
        </fieldset>
        {mode === 'shadow' && (
          <Notice variant="info">{t('modeShadowNotice', { defaultValue: 'Shadow is log-only — nothing is blocked. Would-be blocks show up under Recent decisions so you can build the allow-list before enforcing.' })}</Notice>
        )}
        {mode === 'enforce' && (
          <label className="u-flex u-items-center u-gap-2 u-fs-12">
            {t('modeDenyVerdictLabel', { defaultValue: 'An unmatched action should' })}
            <select value={defaultDenyVerdict} disabled={busy || loadFailed} onChange={(e) => void save(rules ?? [], unknownPolicy, { defaultDenyVerdict: e.target.value as 'deny' | 'require-approval' })} aria-label={t('modeDenyVerdictLabel', { defaultValue: 'An unmatched action should' })}>
              <option value="deny">{t('modeDenyVerdictDeny', { defaultValue: 'be blocked' })}</option>
              <option value="require-approval">{t('modeDenyVerdictApproval', { defaultValue: 'need approval' })}</option>
            </select>
          </label>
        )}
      </section>

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
                  <span className={`chip u-fs-11 ${r.verdict === 'deny' ? 'chip--danger' : r.verdict === 'allow' ? 'chip--success' : 'chip--warning'}`}>
                    {t(r.verdict === 'deny' ? 'verdictDeny' : r.verdict === 'allow' ? 'verdictAllow' : 'verdictRequireApproval', { defaultValue: r.verdict })}
                  </span>
                </div>
                <RuleSentence rule={r} t={t} />
                <div>
                  <Button variant="secondary" className="u-fs-11" disabled={busy || loadFailed} onClick={() => void removeRule(r)} aria-label={t('removeRuleAria', { desc: r.description || r.id, defaultValue: 'Remove rule {{desc}}' })}>
                    {t('remove', { defaultValue: 'Remove' })}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {!hasRecommended && (
          <div className="surface-card u-pad-2 u-flex u-flex-row u-flex-wrap u-items-center u-justify-between u-gap-2">
            <div className="u-flex u-flex-col u-gap-1">
              <span className="u-fs-12 u-fw-600">{t('recommendedTitle', { defaultValue: 'Recommended rule' })}</span>
              <span className="muted u-fs-11">{t('recommendedBody', { defaultValue: 'Ask for approval when a run reads data and a tool then tries to send it off-host — the most common leak.' })}</span>
            </div>
            <Button variant="primary" className="u-fs-12" disabled={busy || loadFailed} onClick={addRecommended}>{t('recommendedAdd', { defaultValue: 'Add recommended rule' })}</Button>
          </div>
        )}
      </section>

      {/* Builder */}
      <section aria-labelledby="cf-add-h" className="surface-card u-pad-2 u-flex u-flex-col u-gap-2">
        <h2 id="cf-add-h" className="u-fs-13">{t('addHeading', { defaultValue: 'Build a rule' })}</h2>

        {/* Predicate-kind switch — a rule uses exactly one kind. */}
        <fieldset className="u-border-0 u-p-0 u-m-0">
          <legend className="u-fs-12 u-fw-600">{t('modeLegend', { defaultValue: 'Rule type' })}</legend>
          <div className="u-mt-1 u-flex u-flex-wrap u-items-center u-gap-1" role="group" aria-label={t('modeLegend', { defaultValue: 'Rule type' })}>
            {(['combination', 'volume', 'expression'] as BuilderMode[]).map((m) => (
              <button key={m} type="button" aria-pressed={builderMode === m} className={`chip u-fs-11 ${builderMode === m ? 'chip--accent' : 'chip--muted'}`} onClick={() => { setBuilderMode(m); setExprError(null); }}>
                {t(`mode_${m}`, { defaultValue: m })}
              </button>
            ))}
          </div>
        </fieldset>

        {builderMode === 'combination' && (
          <>
            <ClassPicker legend={t('anyOfLegend', { defaultValue: 'If a run has already…' })} hint={t('anyOfHint', { defaultValue: 'leave blank to match any run' })} selected={anyOf} onToggle={(c) => toggleClass(anyOf, setAnyOf, c)} />
            <ClassPicker legend={t('withLegend', { defaultValue: '…and a tool then tries to…' })} selected={withC} onToggle={(c) => toggleClass(withC, setWithC, c)} />
            {/* Live preview of the rule as a sentence — region stays mounted so SRs announce it */}
            <p className="muted u-fs-11 u-mb-0" aria-live="polite">
              {withC.length > 0 ? <>{t('previewLabel', { defaultValue: 'Preview' })}: <RulePreview anyOf={anyOf} withC={withC} verdict={verdict} t={t} /></> : null}
            </p>
          </>
        )}

        {builderMode === 'volume' && (
          <>
            <ClassPicker legend={t('countLegend', { defaultValue: 'If, in one turn, a tool does this…' })} selected={countClass ? [countClass] : []} onToggle={toggleCountClass} />
            <label className="u-flex u-items-center u-gap-2 u-fs-12">
              {t('countThresholdLabel', { defaultValue: 'this many times or more' })}
              <input type="number" min={1} step={1} value={threshold} onChange={(e) => setThreshold(Math.max(1, Math.floor(Number(e.target.value) || 1)))} aria-label={t('countThresholdLabel', { defaultValue: 'this many times or more' })} className="u-fs-12" />
              <span className="chip chip--muted u-fs-11" title={t('countWindowTitle', { defaultValue: 'Counted per turn' })}>{t('countWindowTurn', { defaultValue: 'per turn' })}</span>
            </label>
          </>
        )}

        {builderMode === 'expression' && (
          <>
            <label className="u-flex u-flex-col u-gap-1 u-fs-12">
              {t('exprLabel', { defaultValue: 'Expression' })}
              <input type="text" value={expression} onChange={(e) => { setExpression(e.target.value); setExprError(null); }} placeholder={t('exprPlaceholder', { defaultValue: 'e.g. seen.read && next.egress:host-mediated' })} aria-label={t('exprLabel', { defaultValue: 'Expression' })} aria-invalid={exprError ? true : undefined} className="u-fs-12" />
            </label>
            {exprError && <Notice variant="error">{exprError}</Notice>}
            <p className="muted u-fs-11 u-mb-0">
              <strong>{t('exprHelpTitle', { defaultValue: 'Available facts' })}:</strong>{' '}
              {t('exprHelpBody', { defaultValue: 'seen.<class> and next.<class> are true/false; count.<class> is a number. Combine with && || ! and comparisons (>= <= > < == !=). Classes look like read, egress:host-mediated, scope:workspace:write, or kind:fan-out.' })}
            </p>
          </>
        )}

        <label className="u-flex u-items-center u-gap-2 u-fs-12">
          {t('verdictLabel', { defaultValue: 'then' })}
          <select value={verdict} onChange={(e) => setVerdict(e.target.value as 'deny' | 'require-approval' | 'allow')} aria-label={t('verdictLabel', { defaultValue: 'then' })}>
            <option value="require-approval">{t('verdictRequireApproval', { defaultValue: 'require approval' })}</option>
            <option value="deny">{t('verdictDeny', { defaultValue: 'deny' })}</option>
            {mode !== 'default-allow' && <option value="allow">{t('verdictAllowList', { defaultValue: 'allow (add to allow-list)' })}</option>}
          </select>
        </label>
        <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('reasonPlaceholder', { defaultValue: 'Reason shown to the user (optional)' })} aria-label={t('reasonPlaceholder', { defaultValue: 'Reason shown to the user' })} className="u-fs-12" />
        <div>
          {builderMode === 'combination' && <Button variant="primary" className="u-fs-12" disabled={busy || loadFailed || withC.length === 0} onClick={addRule}>{t('addRule', { defaultValue: 'Add rule' })}</Button>}
          {builderMode === 'volume' && <Button variant="primary" className="u-fs-12" disabled={busy || loadFailed || countClass === null} onClick={addCountRule}>{t('addRule', { defaultValue: 'Add rule' })}</Button>}
          {builderMode === 'expression' && <Button variant="primary" className="u-fs-12" disabled={busy || loadFailed || expression.trim().length === 0} onClick={() => void addExpressionRule()}>{t('addRule', { defaultValue: 'Add rule' })}</Button>}
        </div>
      </section>

      {/* Unclassified-tools posture — framed by consequence */}
      <section aria-labelledby="cf-policy-h" className="u-flex u-flex-col u-gap-2">
        <h2 id="cf-policy-h" className="u-fs-13">{t('policyHeading', { defaultValue: 'Tools we can’t classify' })}</h2>
        <fieldset className="u-border-0 u-p-0 u-m-0 u-flex u-flex-col u-gap-2">
          <legend className="muted u-fs-11">{t('policyBody', { defaultValue: 'Custom and third-party tools may not be classified yet. Choose what the firewall assumes about them.' })}</legend>
          <label className="u-flex u-items-center u-gap-2 u-fs-12">
            <input type="radio" name="cf-policy" checked={unknownPolicy === 'skip'} disabled={busy || loadFailed} onChange={() => void save(rules ?? [], 'skip')} />
            {t('policySkipLabel', { defaultValue: 'Allow them — only classified tools are checked' })}
          </label>
          <label className="u-flex u-items-center u-gap-2 u-fs-12">
            <input type="radio" name="cf-policy" checked={unknownPolicy === 'treat-as-risky'} disabled={busy || loadFailed} onChange={() => void save(rules ?? [], 'treat-as-risky')} />
            {t('policyRiskyLabel', { defaultValue: 'Treat as risky — safer, but may prompt for approval more often' })}
          </label>
        </fieldset>
      </section>

      {/* ADR 0397 Phase 2 — the side-effect-free policy simulator. */}
      <SimulatorPanel orgId={orgId} />

      {/* ADR 0397 Phase 1 — recent decisions: what the firewall actually blocked or
          held for approval, with matched-rule attribution. */}
      <section aria-labelledby="cf-decisions-h" className="u-flex u-flex-col u-gap-2">
        <div className="u-flex u-items-center u-justify-between u-gap-2">
          <h2 id="cf-decisions-h" className="u-fs-13">{t('decisionsHeading', { defaultValue: 'Recent decisions' })}</h2>
          <Button variant="secondary" className="u-fs-11" onClick={() => loadDecisions(orgId)} aria-label={t('decisionsRefresh', { defaultValue: 'Refresh decisions' })}>
            {t('decisionsRefresh', { defaultValue: 'Refresh' })}
          </Button>
        </div>
        {decisions === null ? (
          <StateCard loading title={t('loading', { defaultValue: 'Loading…' })} />
        ) : decisionsFailed ? (
          <StateCard announce
            icon={<ShieldIcon size={28} />}
            title={t('decisionsFailedTitle', { defaultValue: 'Could not load recent decisions' })}
            body={t('decisionsFailedBody', { defaultValue: 'This is a failed read, not an empty history — it does not mean the firewall has blocked nothing.' })}
            action={<Button variant="secondary" size="sm" onClick={() => orgId && loadDecisions(orgId)}>{t('retryLoad', { defaultValue: 'Try again' })}</Button>}
          />
        ) : decisions.length === 0 ? (
          <StateCard
            icon={<ShieldIcon size={28} />}
            title={t('decisionsEmptyTitle', { defaultValue: 'No decisions yet' })}
            body={t('decisionsEmptyBody', { defaultValue: 'When the firewall blocks or holds a tool call for approval, it appears here with the rule that matched.' })}
          />
        ) : (
          <ul className="u-list-none u-p-0 u-flex u-flex-col u-gap-2">
            {decisions.map((d) => (
              <li key={d.decisionId} className="surface-card u-pad-2 u-flex u-flex-col u-gap-1">
                <div className="u-flex u-items-center u-justify-between u-gap-2">
                  <code className="u-fs-11 u-fw-600">{d.toolName ?? t('decisionsUnknownTool', { defaultValue: 'a tool' })}</code>
                  {d.shadow ? (
                    <span className="chip chip--muted u-fs-11" title={t('decisionsShadowTitle', { defaultValue: 'Shadow mode logged this — the call still proceeded.' })}>
                      {t('decisionsShadow', { verdict: t(d.decision === 'deny' ? 'verdictDeny' : 'verdictRequireApproval', { defaultValue: d.decision }), defaultValue: 'would {{verdict}} (shadow)' })}
                    </span>
                  ) : (
                    <span className={`chip u-fs-11 ${d.decision === 'deny' ? 'chip--danger' : 'chip--warning'}`}>
                      {t(d.decision === 'deny' ? 'verdictDeny' : 'verdictRequireApproval', { defaultValue: d.decision })}
                    </span>
                  )}
                </div>
                {d.reason ? <span className="muted u-fs-11">{d.reason}</span> : null}
                <div className="u-flex u-flex-wrap u-items-center u-gap-2 u-fs-11 muted">
                  <time dateTime={d.timestamp}>{formatDateTime(d.timestamp)}</time>
                  {d.ruleId ? <span className="chip chip--muted" title={t('decisionsMatchedRuleTitle', { defaultValue: 'The rule that matched' })}>{t('decisionsMatchedRule', { rule: d.ruleId, defaultValue: 'rule: {{rule}}' })}</span> : <span className="chip chip--muted">{t('decisionsFellThrough', { defaultValue: 'no specific rule' })}</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** Render a saved rule as a plain-language sentence. */
function RuleSentence({ rule, t }: { rule: FirewallRule; t: T }): JSX.Element {
  // ADR 0135 Phase 6 — an expression rule shows its source verbatim.
  if (rule.when.expression !== undefined) {
    return (
      <div className="u-flex u-flex-wrap u-items-center u-gap-1 u-fs-11">
        <span className="muted">{t('sentExpression', { defaultValue: 'When this expression is true:' })}</span>
        <code className="chip chip--muted">{rule.when.expression}</code>
      </div>
    );
  }
  // ADR 0135 Phase 5 — a composition-VOLUME rule.
  if (rule.when.countAtLeast) {
    const ca = rule.when.countAtLeast;
    return (
      <div className="u-flex u-flex-wrap u-items-center u-gap-1 u-fs-11">
        <span className="muted">{t('sentCountLead', { defaultValue: 'If, in one turn, a tool tries to' })}</span>
        <span title={classKey(ca.class)} className="chip chip--accent">{humanClass(ca.class, t)}</span>
        <span className="muted">{t('sentCountTail', { count: ca.threshold, defaultValue: '{{count}} or more times' })}</span>
      </div>
    );
  }
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
function RulePreview({ anyOf, withC, verdict, t }: { anyOf: CapabilityClass[]; withC: CapabilityClass[]; verdict: 'deny' | 'require-approval' | 'allow'; t: T }): JSX.Element {
  const join = (cs: CapabilityClass[]) => cs.map((c) => humanClass(c, t)).join(t('orJoin', { defaultValue: ' or ' }));
  const head = anyOf.length
    ? t('previewWithAny', { any: join(anyOf), next: join(withC), defaultValue: 'If a run did {{any}} and a tool tries to {{next}}' })
    : t('previewNoAny', { next: join(withC), defaultValue: 'If a tool tries to {{next}}' });
  const tail = verdict === 'deny' ? t('previewDeny', { defaultValue: 'block it' })
    : verdict === 'allow' ? t('previewAllow', { defaultValue: 'allow it' })
      : t('previewApproval', { defaultValue: 'ask for approval' });
  return <span className="u-fw-600">{head} → {tail}.</span>;
}

/** ADR 0397 Phase 2 — pre-flight a hypothetical action against the org's current rules.
 *  Class-based (matches how rules are authored); the server also accepts tool names. */
function SimulatorPanel({ orgId }: { orgId: string }): JSX.Element {
  const { t } = useTranslation('capability-firewall');
  const [seen, setSeen] = useState<CapabilityClass[]>([]);
  const [next, setNext] = useState<CapabilityClass | null>(null);
  const [mode, setMode] = useState<FirewallMode>('default-allow');
  const [result, setResult] = useState<SimulateResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggleSeen = (c: CapabilityClass): void => {
    const k = classKey(c);
    setSeen((cur) => (cur.some((x) => classKey(x) === k) ? cur.filter((x) => classKey(x) !== k) : [...cur, c]));
  };
  const toggleNext = (c: CapabilityClass): void => setNext((cur) => (cur && classKey(cur) === classKey(c) ? null : c));

  const run = async (): Promise<void> => {
    if (!next) { setErr(t('simNeedNext', { defaultValue: 'Pick the action to test.' })); return; }
    setBusy(true); setErr(null);
    try {
      setResult(await simulateFirewall(orgId, { ...(seen.length ? { seen } : {}), next, modeOverride: mode }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('simFailed', { defaultValue: 'Simulation failed.' }));
    } finally { setBusy(false); }
  };

  const decisionChip = (d: SimulateResult['decision']): string =>
    d === 'allow' ? t('verdictAllow', { defaultValue: 'allow' })
      : d === 'deny' ? t('verdictDeny', { defaultValue: 'deny' })
        : t('verdictRequireApproval', { defaultValue: 'require approval' });
  const chipClass = (d: SimulateResult['decision']): string => (d === 'deny' ? 'chip--danger' : d === 'require-approval' ? 'chip--warning' : 'chip--success');

  return (
    <section aria-labelledby="cf-sim-h" className="surface-card u-pad-2 u-flex u-flex-col u-gap-2">
      <h2 id="cf-sim-h" className="u-fs-13">{t('simHeading', { defaultValue: 'Test a rule set' })}</h2>
      <p className="muted u-fs-11 u-mb-0">{t('simIntro', { defaultValue: 'Try a hypothetical run against the current rules — nothing is recorded or changed.' })}</p>

      <ClassPicker legend={t('simSeenLegend', { defaultValue: 'Pretend a run has already…' })} hint={t('anyOfHint', { defaultValue: 'leave blank to match any run' })} selected={seen} onToggle={toggleSeen} />
      <ClassPicker legend={t('simNextLegend', { defaultValue: '…and a tool is about to…' })} selected={next ? [next] : []} onToggle={toggleNext} />

      <label className="u-flex u-items-center u-gap-2 u-fs-12">
        {t('simModeLabel', { defaultValue: 'Evaluate as' })}
        <select value={mode} onChange={(e) => setMode(e.target.value as FirewallMode)} aria-label={t('simModeLabel', { defaultValue: 'Evaluate as' })}>
          <option value="default-allow">{t('simModeDefaultAllow', { defaultValue: 'today (allow unmatched)' })}</option>
          <option value="shadow">{t('simModeShadow', { defaultValue: 'shadow (log-only deny)' })}</option>
          <option value="enforce">{t('simModeEnforce', { defaultValue: 'enforce (deny unmatched)' })}</option>
        </select>
      </label>

      <div>
        <Button variant="primary" className="u-fs-12" disabled={busy || next === null} onClick={() => void run()}>{t('simRun', { defaultValue: 'Simulate' })}</Button>
      </div>
      {err && <Notice variant="error">{err}</Notice>}

      {result && (
        <div className="surface-card u-pad-2 u-flex u-flex-col u-gap-2" aria-live="polite">
          <div className="u-flex u-flex-wrap u-items-center u-gap-2">
            <span className="u-fs-12 u-fw-600">{t('simResultLabel', { defaultValue: 'Decision' })}:</span>
            <span className={`chip u-fs-11 ${chipClass(result.decision)}`}>{decisionChip(result.decision)}</span>
            {result.matchedRuleId ? (
              <span className="muted u-fs-11" title={result.matchedClause}>{t('simMatchedRule', { rule: result.matchedRuleId, defaultValue: 'matched rule: {{rule}}' })}</span>
            ) : (
              <span className="muted u-fs-11">{t('simFellThrough', { defaultValue: 'no rule matched — the mode’s default applied' })}</span>
            )}
          </div>
          {result.trace.length > 0 && (
            <details>
              <summary className="u-fs-11 u-fw-600 u-cursor-pointer">{t('simTraceHeading', { count: result.trace.length, defaultValue: 'Why ({{count}} rules checked)' })}</summary>
              <ul className="u-list-none u-p-0 u-mt-1 u-flex u-flex-col u-gap-1">
                {result.trace.map((row) => (
                  <li key={row.ruleId} className="u-flex u-flex-wrap u-items-baseline u-gap-2 u-fs-11">
                    <span className={`chip u-fs-11 ${row.matched ? 'chip--accent' : 'chip--muted'}`}>{row.matched ? t('simTraceMatched', { defaultValue: 'match' }) : t('simTraceNoMatch', { defaultValue: 'no match' })}</span>
                    <code className="u-fw-600">{row.ruleId}</code>
                    <span className="muted">{row.why}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {result.platformBaseline && result.platformBaseline.length > 0 && (
            <div className="u-flex u-flex-col u-gap-1">
              <span className="u-fs-11 u-fw-600" title={t('simPlatformTitle', { defaultValue: 'A platform-wide floor set by your operator — read-only here.' })}>{t('simPlatformHeading', { defaultValue: 'Platform baseline (read-only)' })}</span>
              <ul className="u-list-none u-p-0 u-flex u-flex-col u-gap-1">
                {result.platformBaseline.map((row) => (
                  <li key={`plat-${row.ruleId}`} className="u-flex u-flex-wrap u-items-baseline u-gap-2 u-fs-11">
                    <span className={`chip u-fs-11 ${row.matched ? 'chip--danger' : 'chip--muted'}`}>{row.matched ? t('simTraceMatched', { defaultValue: 'match' }) : t('simTraceNoMatch', { defaultValue: 'no match' })}</span>
                    <code className="u-fw-600">{row.ruleId}</code>
                    <span className="muted">{row.why}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
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
