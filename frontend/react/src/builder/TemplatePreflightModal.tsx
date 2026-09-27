/**
 * Template pre-flight (day-1 UX P3 / defect-list B1) — shown on "Use template"
 * BEFORE the chain instantiates, so a new user learns what a template needs
 * (connections, host packs) and can pre-fill its inputs instead of landing on
 * a canvas whose external steps silently no-op.
 *
 * Composition, not invention: `ui/Modal` + the shared `RunInputsForm` field
 * renderer (the ONE run-input UI — ADR 0184 line) + `.chip` status semantics.
 * Requirements come from the chains-list `requirements` block (host-global:
 * uninstalled node typeIds + connectionRef→provider bindings); whether the
 * CALLER is connected joins here against its own /connections rows.
 *
 * Inputs stay OPTIONAL here — "Use template = just copy" is a deliberate product
 * contract (this modal and the from-chain route test both state it), so Confirm
 * does not block on blanks and the user completes the template in the builder.
 *
 * §Correction (2026-07-28) — the RATIONALE was wrong even though the behaviour
 * is right. This used to justify not blocking by saying from-chain "stores params
 * as the workflow's run-input DEFAULTS (never frozen into config)". That
 * describes RFC 0124 DEFERRED mode; from-chain defaults to Path A, which DOES
 * freeze params into node config, and this modal never sends `deferred`. So a
 * blank required field is frozen in as `undefined` — which is exactly how a
 * chain AI node reached dispatch with no provider and failed as
 * `Provider "undefined"`. The fix for that is chain content carrying real
 * defaults, not blocking the copy; but the note should say what actually happens.
 */
import { Button } from '../ui/Button.js';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Modal } from '../ui/Modal.js';
import { Notice } from '../ui/Notice.js';
import { RunInputsForm, initialRunInputValues, toRunInputs, missingRequired } from '../ui/RunInputsForm.js';
import type { RunVariable } from '../workflows/workflowsClient.js';
import { listConnections, listProviders } from '../features/connections/connectionsClient.js';
import { useAllFeatureAccess } from '../featureToggles/FeatureAccessContext.js';
import type { ChainTemplate } from './persistence/backendStore.js';

/** Map a chain's JSON-Schema `parameters` to the shared RunVariable shape the
 *  RunInputsForm renders. Exported for tests. */
export function chainParamsToVariables(parameters: ChainTemplate['parameters']): RunVariable[] {
  const props = parameters?.properties ?? {};
  const required = new Set(parameters?.required ?? []);
  return Object.entries(props).map(([name, spec]) => ({
    name,
    ...(typeof spec.type === 'string' ? { type: spec.type } : {}),
    ...(typeof spec.description === 'string' ? { description: spec.description } : {}),
    required: required.has(name),
    ...(spec.default !== undefined ? { defaultValue: spec.default } : {}),
  }));
}

type ConnectionState = 'connected' | 'not-connected' | 'not-on-host';

/** Join a chain's host-derived `requiredFeatures` (toggle-gated surfaces) against
 *  the caller's resolved assignments to mark each enabled/disabled. Pure, so it
 *  is unit-testable without rendering. Exported for tests. */
export function featureRequirementRows(
  requiredFeatures: NonNullable<ChainTemplate['requirements']>['requiredFeatures'],
  enabledOf: (id: string) => boolean,
): Array<{ id: string; label: string; enabled: boolean }> {
  return (requiredFeatures ?? []).map((f) => ({ ...f, enabled: enabledOf(f.id) }));
}

export function TemplatePreflightModal({
  chain,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  chain: ChainTemplate;
  busy: boolean;
  error: string | null;
  /** Called with the (possibly empty) params object to instantiate with. */
  onConfirm: (params: Record<string, unknown>) => void;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation('builder');
  const nav = useNavigate();
  const variables = useMemo(() => chainParamsToVariables(chain.parameters), [chain.parameters]);
  const [values, setValues] = useState<Record<string, unknown>>(() => initialRunInputValues(variables));

  // The caller's own connections + the provider labels — best-effort: a fetch
  // failure (or an anon session with none) honestly reads as "not connected".
  const [activeProviders, setActiveProviders] = useState<ReadonlySet<string>>(new Set());
  const [providerLabels, setProviderLabels] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    let cancelled = false;
    void listConnections()
      .then((rows) => {
        if (cancelled) return;
        setActiveProviders(new Set(rows.filter((r) => r.status === 'active').map((r) => r.provider)));
      })
      .catch(() => { /* unreachable backend reads as not-connected */ });
    void listProviders()
      .then((rows) => {
        if (cancelled) return;
        setProviderLabels(new Map(rows.map((p) => [p.id, p.label])));
      })
      .catch(() => { /* label fallback = the provider id */ });
    return () => { cancelled = true; };
  }, []);

  const requirements = chain.requirements;
  const connectionRows = (requirements?.connections ?? []).map((c) => {
    const state: ConnectionState = !c.providerInstalled
      ? 'not-on-host'
      : activeProviders.has(c.providerId)
        ? 'connected'
        : 'not-connected';
    return { ...c, state };
  });
  const missingNodes = requirements?.missingNodeTypeIds ?? [];

  // Toggle-gated feature surfaces the chain reads (ADR 0191 Phase 2) — a
  // `feature.<id>.nodes.*` node is INSTALLED yet throws host_capability_disabled
  // at runtime when its feature is off. Join the host's list against the
  // caller's own resolved assignments (byId) so a disabled feature reads as
  // "not enabled" with an Enable affordance, instead of failing mid-run.
  const { byId: featureAccessById } = useAllFeatureAccess();
  const featureRows = featureRequirementRows(
    requirements?.requiredFeatures,
    (id) => featureAccessById[id]?.enabled === true,
  );
  const anyFeatureDisabled = featureRows.some((f) => !f.enabled);

  // Only claim "zero connections" when the host actually DERIVED requirements
  // (an older backend omits the block — say nothing rather than overpromise).
  //
  // §Correction (grade-ux TPI-2): this ignored unanswered REQUIRED inputs, so a
  // green "ready to go" chip rendered directly above a blank required field on
  // the 117 chains that have one. A template that still needs an answer is not
  // ready. `missingRequired` is the same helper `RunInputsDialog` already uses.
  const unanswered = missingRequired(variables, values);
  const zeroConfig =
    requirements != null && connectionRows.length === 0 && missingNodes.length === 0
    && !anyFeatureDisabled && unanswered.length === 0;

  return (
    <Modal onClose={onClose} label={t('preflightTitle', { name: chain.label })} showClose>
      <form
        className="u-grid u-gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) onConfirm(toRunInputs(variables, values));
        }}
      >
        <div className="u-grid u-gap-1">
          <strong className="u-fs-16">{t('preflightTitle', { name: chain.label })}</strong>
          <p className="muted u-fs-13">{chain.description}</p>
        </div>

        {/* `announce` is required: a conditionally-MOUNTED Notice enters the DOM
             with its text already inside, so it announces nothing while looking
             correct (ui/Notice's own docblock). This is the flow's only failure. */}
        {error ? <Notice variant="error" announce={error}>{error}</Notice> : null}

        {requirements != null ? (
        <section className="u-grid u-gap-2" aria-label={t('preflightRequirementsTitle')}>
          <strong className="u-fs-13">{t('preflightRequirementsTitle')}</strong>
          {anyFeatureDisabled ? (
            <Notice variant="warning">
              {t('preflightFeaturesNotice', {
                features: featureRows.filter((f) => !f.enabled).map((f) => f.label).join(', '),
              })}
            </Notice>
          ) : null}
          {zeroConfig ? (
            <p className="muted u-fs-13">
              <span className="chip chip--success">{t('preflightZeroConfig')}</span>
            </p>
          ) : (
            <ul className="u-flex u-flex-col u-gap-2 u-m-0 u-p-0 u-list-none">
              {connectionRows.map((c) => (
                <li key={c.ref} className="action-bar u-justify-between">
                  <span>{providerLabels.get(c.providerId) ?? c.providerId}</span>
                  {c.state === 'connected' ? (
                    <span className="chip chip--success">{t('preflightConnected')}</span>
                  ) : c.state === 'not-connected' ? (
                    <span className="action-bar">
                      <span className="chip chip--warning">{t('preflightNotConnected')}</span>
                      <Button variant="quiet" onClick={() => nav('/access?tab=connections')}>
                        {t('preflightConnectCta')}
                      </Button>
                    </span>
                  ) : (
                    <span className="chip chip--muted" title={t('preflightNotOnHostHint')}>
                      {t('preflightNotOnHost')}
                    </span>
                  )}
                </li>
              ))}
              {missingNodes.map((typeId) => (
                <li key={typeId} className="action-bar u-justify-between">
                  <span className="u-fs-13">{typeId}</span>
                  <span className="chip chip--warning" title={t('preflightNotOnHostHint')}>
                    {t('preflightMissingNode')}
                  </span>
                </li>
              ))}
              {featureRows.map((f) => (
                <li key={f.id} className="action-bar u-justify-between">
                  <span>{f.label}</span>
                  {f.enabled ? (
                    <span className="chip chip--success">{t('preflightFeatureEnabled')}</span>
                  ) : (
                    <span className="action-bar">
                      <span className="chip chip--warning">{t('preflightFeatureDisabled')}</span>
                      <Button variant="quiet" onClick={() => nav('/feature-toggles')}>
                        {t('preflightFeatureEnableCta')}
                      </Button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
        ) : null}

        {(requirements?.approvalGateCount ?? 0) > 0 ? (
          <p className="muted u-fs-13" role="note">
            <span className="chip chip--accent">{t('preflightApprovalGates', { count: requirements?.approvalGateCount ?? 0 })}</span>
          </p>
        ) : null}

        {variables.length > 0 ? (
          <section className="u-grid u-gap-2" aria-label={t('preflightInputsTitle')}>
            <div className="u-grid u-gap-1">
              <strong className="u-fs-13">{t('preflightInputsTitle')}</strong>
              <p className="muted u-fs-12">{t('preflightInputsBlurb')}</p>
            </div>
            <RunInputsForm
              variables={variables}
              values={values}
              onChange={(name, value) => setValues((p) => ({ ...p, [name]: value }))}
            />
          </section>
        ) : null}

        <div className="action-bar u-justify-end">
          <Button variant="quiet" onClick={onClose} disabled={busy}>
            {t('common:cancel')}
          </Button>
          <Button variant="primary" type="submit" disabled={busy}>
            {busy ? t('preflightCreating') : t('preflightConfirm')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
