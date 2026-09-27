/**
 * CDP console (ADR 0263 / CDP-A) — customer identity resolution + compliance reads.
 *
 * Two tabs:
 *  - Identity: a focused lookup — pick an identifier type, enter a value, and see
 *    the unified golden record (contact + every identifier it resolves by).
 *  - Compliance (CFP D7): the read-only governance surfaces that already existed
 *    on the backend but had no window — the unified governance decision log
 *    (ADR 0268), tamper-evident audit-chain verification (ADR 0301, admin-gated),
 *    the event-schema registry, and the collected-event stream (ADR 0269).
 *
 * Reuses the shared ui/ design system; gated on the `cdp` toggle (backend
 * authority — the route is hidden when off, this is the defensive in-page gate).
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { announce } from '../../ui/announce.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton, SkeletonRows } from '../../ui/Skeleton.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { TextField, SelectField } from '../../ui/Field.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { formatDate, formatDateTime } from '../../i18n/format.js';
import { UsersIcon, SearchIcon, ShieldIcon, ActivityIcon, DatabaseIcon, ListIcon } from '../../ui/icons/index.js';
import {
  resolveIdentity,
  listGovernanceDecisions,
  verifyAuditChain,
  listEventSchemas,
  listCollectedEvents,
  listMergeEvents,
  type MergeEventRow,
  IDENTIFIER_TYPES,
  type GoldenRecord,
  type GovernanceDecisionRow,
  type AuditChainResult,
  type EventSchemaRecord,
  type CollectedEventRow,
} from '../../client/cdpClient.js';

type Tab = 'identity' | 'compliance';

export function CdpConsolePage(): JSX.Element {
  const { t } = useTranslation('cdp');
  const access = useFeatureAccess('cdp');
  const [tab, setTab] = useState<Tab>('identity');
  // First-activation latch for the compliance section's lazy mount.
  const complianceVisited = useRef(false);
  if (tab === 'compliance') complianceVisited.current = true;

  if (!access.enabled) {
    return (
      <>
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
        <StateCard icon={<UsersIcon />} title={t('notEnabledTitle')} body={t('notEnabledBody')} />
      </>
    );
  }

  return (
    <>
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />

      <div className="segmented view-toggle" role="group" aria-label={t('tabsAria')}>
        <Button variant="primary" aria-pressed={tab === 'identity'} onClick={() => setTab('identity')}>
          <SearchIcon size={13} /> {t('tabIdentity')}
        </Button>
        <Button variant="primary" aria-pressed={tab === 'compliance'} onClick={() => setTab('compliance')}>
          <ShieldIcon size={13} /> {t('tabCompliance')}
        </Button>
      </div>

      {/* R2 CD-SP-10 (review-corrected) — LAZY-mount the compliance section
          on FIRST activation, then keep it mounted (hidden) across switches.
          Mount-at-page-load would fire its four reads for every identity-only
          visitor (the majority) — inverting the fan-out cost the change was
          meant to reduce; unmount-per-switch refired them on every visit. */}
      <div hidden={tab !== 'identity'}><IdentitySection /></div>
      {complianceVisited.current ? <div hidden={tab !== 'compliance'}><ComplianceSection /></div> : null}
    </>
  );
}

function IdentitySection(): JSX.Element {
  const { t } = useTranslation('cdp');
  const [type, setType] = useState<string>('email');
  const [value, setValue] = useState('');
  const [record, setRecord] = useState<GoldenRecord | null>(null);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onResolve = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const v = value.trim();
      if (!v || busy) return;
      setBusy(true);
      setError(null);
      try {
        const found = await resolveIdentity(type, v);
        setRecord(found);
        setSearched(true);
        // R2 CD-SP-6 — the outcome was silent to screen-reader users.
        announce(found ? t('resolveAnnounceFound', { name: found.contact.name }) : t('resolveAnnounceEmpty'));
      } catch {
        // R2 CD-SP-1 — the previous customer's record must NEVER co-render
        // under the error: a failed second lookup kept the old record on
        // screen with `resolvedBy` still naming the old query — read as a
        // direct hit for the NEW query (the misattribution CDP-G2 closed,
        // through a different door).
        setRecord(null);
        setSearched(false);
        setError(t('actionFailed'));
        // (announced by the error Notice's `announce` prop below — an
        // imperative call HERE would double-announce, the DS-8 bug.)
      } finally {
        setBusy(false);
      }
    },
    [type, value, busy, t],
  );

  return (
    <>
      {/* .surface-form, not .action-bar: .surface-card is a column flex and
          .action-bar declares no direction, so the combo stacks the fields
          full-height (the HV-CDP1 finding); .surface-card.surface-form is the
          defined row-wrap form combo. */}
      <form className="surface-card surface-form" onSubmit={onResolve}>
        <SelectField
          label={t('typeLabel')}
          value={type}
          onChange={(ev) => setType(ev.target.value)}
        >
          {IDENTIFIER_TYPES.map((it) => (
            <option key={it} value={it}>{t(`type_${it}`)}</option>
          ))}
        </SelectField>
        <TextField
          label={t('valueLabel')}
          value={value}
          placeholder={t('valuePlaceholder')}
          onChange={(ev) => setValue(ev.target.value)}
        />
        <Button type="submit" variant="accent-solid" disabled={busy || !value.trim()}>
          <SearchIcon /> {busy ? t('resolving') : t('resolve')}
        </Button>
      </form>

      {error && <Notice variant="error" announce={error}>{error}</Notice>}

      {!searched && !error && (
        <StateCard icon={<SearchIcon />} title={t('introTitle')} body={t('introBody')} />
      )}

      {searched && !record && !error && (
        <StateCard icon={<UsersIcon />} title={t('emptyTitle')} body={t('emptyBody')} />
      )}

      {record && (
        <section className="surface-card" aria-label={t('resultTitle')}>
          {/* CDP-G2 — the resolver followed a merge tombstone, so this is the
              SURVIVING record, not the one the identifier was filed under. Say
              so before the name, or the reader takes a different customer for a
              direct hit. */}
          {record.mergedFrom && (
            <div className="u-mb-2">
              <Notice variant="warning" announce={t('mergedBody')}>
                {t('mergedBody')}{' '}
                <span className="u-mono u-fs-12">{record.mergedFrom.contactId}</span>
              </Notice>
            </div>
          )}
          {record.masked ? (
            <div className="u-mb-2">
              {/* R2 CDP-G5 — PII fields below are PSEUDONYMIZED for this
                  caller (label-based access). Rendered as masked, never
                  silently substituted. */}
              <Notice variant="info" announce={t('maskedNotice')}>{t('maskedNotice')}</Notice>
            </div>
          ) : null}
          <header className="u-mb-2">
            <h2 className="u-fs-16">{record.contact.name}</h2>
            <p className="u-fs-12 u-ink-3">
              {t('resolvedBy')}: <span className="chip chip--muted u-fs-11">{t(`type_${record.resolvedBy.type}` as const, { defaultValue: record.resolvedBy.type })}</span> {record.resolvedBy.value}
            </p>
          </header>
          <dl className="u-grid u-gap-2">
            <Row label={t('fEmail')} value={record.contact.email} />
            <Row label={t('fCompany')} value={record.contact.company} />
            {/* R2 CD-SP-3 — resolvable BY phone yet phone was unrendered;
                title/owner/leadSource rode the wire unseen; customFields were
                agent-settable-but-invisible (the sixth sibling). */}
            <Row label={t('fPhone')} value={record.contact.phone} />
            <Row label={t('fTitle')} value={record.contact.title} />
            <Row label={t('fOwner')} value={record.contact.owner} />
            <Row label={t('fLeadSource')} value={record.contact.leadSource} />
            <Row label={t('fStage')} value={record.contact.stage} chip />
            <Row label={t('fContactId')} value={record.contact.contactId} mono />
          </dl>
          {record.contact.customFields && Object.keys(record.contact.customFields).length > 0 ? (
            <>
              <h3 className="u-fs-13 u-mt-3 u-mb-1">{t('customFieldsTitle')}</h3>
              <dl className="u-grid u-gap-2">
                {Object.entries(record.contact.customFields).map(([k, v]) => (
                  <Row key={k} label={k} value={v} />
                ))}
              </dl>
            </>
          ) : null}
          <h3 className="u-fs-13 u-mt-3 u-mb-1">{t('identifiersTitle')}</h3>
          {record.identifiers.length === 0 ? (
            <p className="u-fs-12 u-ink-3">{t('noIdentifiers')}</p>
          ) : (
            <ul className="action-bar u-gap-2 u-flex-wrap">
              {record.identifiers.map((id) => (
                <li key={`${id.type}:${id.value}`} className="chip chip--accent u-fs-11">
                  {t(`type_${id.type}` as const, { defaultValue: id.type })}: {id.value}
                  <span className="u-ink-3"> · {t('sourceLabel')} {id.source}</span>
                  {/* CDP-G3 — `verifiedAt` rides every identifier and was dropped.
                      Both states render: ABSENCE is the meaningful one (nobody
                      confirmed this identifier), so it can't be left blank. */}
                  <span className="u-ink-3">
                    {' · '}
                    {id.verifiedAt ? t('verifiedOn', { date: formatDate(id.verifiedAt) }) : t('unverified')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}

/** Strip the `governance.decision.` prefix off an audit action → the bare kind. */
function decisionKind(action: string): string {
  return action.replace(/^governance\.decision\./, '') || action;
}

/** Compliance reads (CFP D7) — four read-only governance surfaces. Each loads
 *  once when this section first mounts (i.e. when the Compliance tab is opened),
 *  so the four reads never fan out on the console's initial page load. */
function ComplianceSection(): JSX.Element {
  const { t } = useTranslation('cdp');
  const [chain, setChain] = useState<AuditChainResult | null>(null);
  const [decisions, setDecisions] = useState<GovernanceDecisionRow[] | null>(null);
  const [schemas, setSchemas] = useState<EventSchemaRecord[] | null>(null);
  const [events, setEvents] = useState<CollectedEventRow[] | null>(null);
  // CFP UXR-3 — each read owns an error flag with a retry, so a failed fetch reads
  // as a genuine error (not a permanent skeleton for the chain, nor an empty table
  // for the lists that hides the difference between "none" and "couldn't load").
  const [chainError, setChainError] = useState(false);
  const [decisionsError, setDecisionsError] = useState(false);
  const [decisionsExhaustive, setDecisionsExhaustive] = useState(true);
  const [schemasError, setSchemasError] = useState(false);
  const [eventsError, setEventsError] = useState(false);
  // R3 — merge-history audit (the R2 "deferred SAFELY" read half).
  const [merges, setMerges] = useState<MergeEventRow[] | null>(null);
  const [mergesError, setMergesError] = useState(false);

  const loadChain = useCallback(() => {
    setChainError(false); setChain(null);
    void verifyAuditChain().then(setChain).catch(() => setChainError(true));
  }, []);
  const loadDecisions = useCallback(() => {
    setDecisionsError(false); setDecisions(null);
    void listGovernanceDecisions()
      .then(({ decisions: rows, exhaustive }) => { setDecisions(rows); setDecisionsExhaustive(exhaustive); })
      .catch(() => setDecisionsError(true));
  }, []);
  const loadSchemas = useCallback(() => {
    setSchemasError(false); setSchemas(null);
    void listEventSchemas().then(setSchemas).catch(() => setSchemasError(true));
  }, []);
  const loadEvents = useCallback(() => {
    setEventsError(false); setEvents(null);
    void listCollectedEvents().then(setEvents).catch(() => setEventsError(true));
  }, []);
  const loadMerges = useCallback(() => {
    setMergesError(false); setMerges(null);
    void listMergeEvents().then(setMerges).catch(() => setMergesError(true));
  }, []);

  useEffect(() => {
    loadChain();
    loadDecisions();
    loadSchemas();
    loadEvents();
    loadMerges();
  }, [loadChain, loadDecisions, loadSchemas, loadEvents, loadMerges]);

  const decisionColumns: DataColumn<GovernanceDecisionRow>[] = [
    { key: 'kind', header: t('colKind'), render: (r) => <span className="chip chip--muted">{decisionKind(r.action)}</span> },
    { key: 'outcome', header: t('colOutcome'), render: (r) => r.outcome
      ? <span className={`chip ${r.outcome === 'allow' ? 'chip--success' : 'chip--danger'}`}>{t(`outcome_${r.outcome}`, { defaultValue: r.outcome })}</span>
      : <span className="muted">—</span> },
    { key: 'resource', header: t('colResource'), cellClassName: 'muted', render: (r) => r.resource ?? '—' },
    { key: 'timestamp', header: t('colWhen'), cellClassName: 'muted', render: (r) => formatDateTime(r.timestamp), sortValue: (r) => r.timestamp },
    { key: 'payload', header: t('colDetail'), render: (r) => <JsonDetails label={t('viewPayload')} value={r.payload} /> },
  ];

  const schemaColumns: DataColumn<EventSchemaRecord>[] = [
    { key: 'eventType', header: t('colEventType'), render: (s) => s.eventType, sortValue: (s) => s.eventType },
    { key: 'version', header: t('colVersion'), render: (s) => <span className="chip chip--muted">v{s.version}</span>, sortValue: (s) => s.version },
    { key: 'createdAt', header: t('colRegistered'), cellClassName: 'muted', render: (s) => formatDateTime(s.createdAt), sortValue: (s) => s.createdAt },
    { key: 'schema', header: t('colDetail'), render: (s) => <JsonDetails label={t('viewSchema')} value={s.schema} /> },
  ];

  const mergeColumns: DataColumn<MergeEventRow>[] = [
    { key: 'who', header: t('colMergePair'), render: (m) => (
      <span><code>{m.sourceId}</code> → <code>{m.survivorId}</code></span>
    ) },
    { key: 'filled', header: t('colFilled'), render: (m) => {
      const n = Object.keys(m.filledFields).length;
      return n > 0
        ? <span className="chip chip--muted" title={Object.keys(m.filledFields).join(', ')}>{t('filledCount', { count: n })}<span className="sr-only">: {Object.keys(m.filledFields).join(', ')}</span></span>
        : <span className="muted">—</span>;
    } },
    { key: 'absorbed', header: t('colAbsorbed'), render: (m) => m.absorbedIdentifiers.length > 0
      ? <span className="chip chip--muted" title={m.absorbedIdentifiers.map((i) => `${i.type}:${i.value}`).join(', ')}>{t('absorbedCount', { count: m.absorbedIdentifiers.length })}<span className="sr-only">: {m.absorbedIdentifiers.map((i) => `${i.type}:${i.value}`).join(', ')}</span></span>
      : <span className="muted">—</span> },
    { key: 'status', header: t('colOutcome'), render: (m) => m.unmergedAt
      ? <span className="chip chip--warning" title={formatDateTime(m.unmergedAt)}>{t('mergeUnmerged')}</span>
      : <span className="chip chip--success">{t('mergeActive')}</span> },
    { key: 'actor', header: t('colActor'), cellClassName: 'muted', render: (m) => m.actor },
    { key: 'mergedAt', header: t('colWhen'), cellClassName: 'muted', render: (m) => formatDateTime(m.mergedAt), sortValue: (m) => m.mergedAt },
  ];

  const eventColumns: DataColumn<CollectedEventRow>[] = [
    { key: 'eventType', header: t('colEventType'), render: (e) => e.eventType, sortValue: (e) => e.eventType },
    { key: 'pii', header: t('colPii'), render: (e) => e.piiFields.length > 0
      ? (
        <span className="chip chip--warning" title={e.piiFields.join(', ')}>
          {t('piiCount', { count: e.piiFields.length })}
          <span className="sr-only">: {e.piiFields.join(', ')}</span>
        </span>
      )
      : <span className="muted">{t('piiNone')}</span> },
    { key: 'schemaVersion', header: t('colVersion'), render: (e) => e.schemaVersion !== undefined ? <span className="chip chip--muted">v{e.schemaVersion}</span> : <span className="muted">—</span> },
    { key: 'at', header: t('colWhen'), cellClassName: 'muted', render: (e) => formatDateTime(e.at), sortValue: (e) => e.at },
    { key: 'payload', header: t('colDetail'), render: (e) => <JsonDetails label={t('viewPayload')} value={e.payload} /> },
  ];

  return (
    <div className="u-grid u-gap-4" data-walkthrough="cdp.page">
      {/* Audit-chain verification (ADR 0301) — a status card, admin-gated. */}
      <section className="surface-card u-grid u-gap-2" aria-label={t('auditChainTitle')}>
        <div className="u-flex u-items-center u-gap-2 u-wrap">
          <ShieldIcon size={16} aria-hidden />
          <h2 className="u-fs-15 u-m-0 u-flex-1">{t('auditChainTitle')}</h2>
          {chainError ? (
            <span className="u-flex u-items-center u-gap-2">
              <span className="chip chip--danger">{t('auditChainCheckFailed')}</span>
              <Button variant="link" onClick={loadChain}>{t('retry')}</Button>
            </span>
          ) : chain === null ? <Skeleton width={110} height={22} radius={999} /> : chain.state === 'forbidden' ? (
            <span className="chip chip--muted">{t('auditChainAdminOnly')}</span>
          ) : chain.ok ? (
            <span className="chip chip--success">{t('auditChainIntact')}</span>
          ) : (
            <span className="chip chip--danger">{chain.brokenAt !== undefined ? t('auditChainBroken', { seq: chain.brokenAt }) : t('auditChainBrokenUnknown')}</span>
          )}
        </div>
        <p className="u-fs-12 u-ink-3 u-m-0">
          {chain !== null && chain.state === 'verified'
            ? t('auditChainLength', { count: chain.length })
            : t('auditChainLede')}
        </p>
      </section>

      {/* Governance decision log (ADR 0268). */}
      <section className="u-grid u-gap-2" aria-label={t('decisionsTitle')}>
        <h2 className="u-fs-15 u-m-0"><ActivityIcon size={15} aria-hidden /> {t('decisionsTitle')}</h2>
        <p className="u-fs-12 u-ink-3 u-m-0">{t('decisionsLede')}</p>
        {decisionsError ? (
          <Notice variant="error">{t('decisionsLoadFailed')} <Button variant="link" onClick={loadDecisions}>{t('retry')}</Button></Notice>
        ) : decisions === null ? <SkeletonRows rows={3} columns={[110, 80, 160, 150]} /> : (
          <DataTable
            stack
            rows={decisions}
            rowKey={(r) => r.auditId}
            columns={decisionColumns}
            caption={t('decisionsTitle')}
            initialSort={{ key: 'timestamp', dir: 'desc' }}
            empty={decisionsExhaustive
              ? <StateCard icon={<ActivityIcon />} title={t('decisionsEmptyTitle')} body={t('decisionsEmptyBody')} />
              // Review F2 — the caveat matters MOST on the empty state: zero
              // rows from a budget-capped scan must never read as a confident
              // "no decisions yet".
              : <StateCard icon={<ActivityIcon />} title={t('decisionsEmptyBoundedTitle')} body={t('decisionsEmptyBoundedBody')} />}
          />
        )}
        {/* R2 CDP-G4 (promoted) — a bounded read SAYS SO. `exhaustive:false`
            additionally means older tenant rows may exist beyond the
            escalating audit scan (CD-SP-2) — the stronger caveat wins. */}
        {decisions !== null && decisions.length > 0 ? (
          <p className="u-fs-12 u-ink-3 u-m-0">
            {decisionsExhaustive ? t('decisionsCapNote', { count: decisions.length }) : t('decisionsBoundedNote', { count: decisions.length })}
          </p>
        ) : null}
      </section>

      {/* Event-schema registry (ADR 0269). */}
      <section className="u-grid u-gap-2" aria-label={t('schemasTitle')}>
        <h2 className="u-fs-15 u-m-0"><DatabaseIcon size={15} aria-hidden /> {t('schemasTitle')}</h2>
        <p className="u-fs-12 u-ink-3 u-m-0">{t('schemasLede')}</p>
        {schemasError ? (
          <Notice variant="error">{t('schemasLoadFailed')} <Button variant="link" onClick={loadSchemas}>{t('retry')}</Button></Notice>
        ) : schemas === null ? <SkeletonRows rows={3} columns={[180, 60, 150]} /> : (
          <DataTable
            stack
            rows={schemas}
            rowKey={(s) => s.key}
            columns={schemaColumns}
            caption={t('schemasTitle')}
            initialSort={{ key: 'eventType', dir: 'asc' }}
            empty={<StateCard icon={<DatabaseIcon />} title={t('schemasEmptyTitle')} body={t('schemasEmptyBody')} />}
          />
        )}
      </section>

      {/* Collected-event stream (ADR 0269). */}
      <section className="u-grid u-gap-2" aria-label={t('eventsTitle')}>
        <h2 className="u-fs-15 u-m-0"><ListIcon size={15} aria-hidden /> {t('eventsTitle')}</h2>
        <p className="u-fs-12 u-ink-3 u-m-0">{t('eventsLede')}</p>
        {eventsError ? (
          <Notice variant="error">{t('eventsLoadFailed')} <Button variant="link" onClick={loadEvents}>{t('retry')}</Button></Notice>
        ) : events === null ? <SkeletonRows rows={3} columns={[180, 90, 60, 150]} /> : (
          <DataTable
            stack
            rows={events}
            rowKey={(e) => e.eventId}
            columns={eventColumns}
            caption={t('eventsTitle')}
            initialSort={{ key: 'at', dir: 'desc' }}
            empty={<StateCard icon={<ListIcon />} title={t('eventsEmptyTitle')} body={t('eventsEmptyBody')} />}
          />
        )}
        {events !== null && events.length > 0 ? (
          <p className="u-fs-12 u-ink-3 u-m-0">{t('eventsCapNote', { count: events.length })}</p>
        ) : null}
      </section>

      {/* R3 — merge-history audit (ADR 0264 recorded every merge all along;
          this is the read half the R2 pass deferred SAFELY). An unmerged row
          stays listed with its unmerge stamp — the trail, not a deletion. */}
      <section className="u-grid u-gap-2" aria-label={t('mergesTitle')}>
        <h2 className="u-fs-15 u-m-0"><UsersIcon size={15} aria-hidden /> {t('mergesTitle')}</h2>
        <p className="u-fs-12 u-ink-3 u-m-0">{t('mergesLede')}</p>
        {mergesError ? (
          <Notice variant="error">{t('mergesLoadFailed')} <Button variant="link" onClick={loadMerges}>{t('retry')}</Button></Notice>
        ) : merges === null ? <SkeletonRows rows={3} columns={[180, 120, 90, 150]} /> : (
          <DataTable
            stack
            rows={merges}
            rowKey={(m) => m.mergeEventId}
            columns={mergeColumns}
            caption={t('mergesTitle')}
            initialSort={{ key: 'mergedAt', dir: 'desc' }}
            empty={<StateCard icon={<UsersIcon />} title={t('mergesEmptyTitle')} body={t('mergesEmptyBody')} />}
          />
        )}
      </section>
    </div>
  );
}


/** R2 CD-SP-4 — the compliance tables were metadata façades: the WHY of a
 *  deny (decision payload), the registered schema, and the event payload were
 *  unviewable. A native <details> keeps the table scannable; the JSON renders
 *  in a <pre> (text node — no injection surface). */
function JsonDetails({ label, value }: { label: string; value: unknown }): JSX.Element | null {
  // Labeled absence, matching sibling columns (the CD-SP-8 principle).
  if (value === undefined || value === null) return <span className="muted">—</span>;
  let text: string;
  try { text = JSON.stringify(value, null, 2); } catch { return <span className="muted">—</span>; }
  return (
    <details>
      <summary className="u-fs-12">{label}</summary>
      <pre className="u-fs-11 u-mono u-m-0 cdp-json">{text}</pre>
    </details>
  );
}

function Row({ label, value, mono, chip }: { label: string; value: string | undefined; mono?: boolean; chip?: boolean }): JSX.Element | null {
  // R2 CD-SP-8 — labeled ABSENCE, not a vanished row: an operator reading a
  // golden record needs "Email: —" (we know there is none) rather than no
  // email line at all (indistinguishable from "this console doesn't show it").
  if (!value) {
    return (
      <div className="action-bar u-gap-2">
        <dt className="u-fs-12 u-ink-3 u-w-auto">{label}</dt>
        <dd className="u-fs-13 muted">—</dd>
      </div>
    );
  }
  return (
    <div className="action-bar u-gap-2">
      <dt className="u-fs-12 u-ink-3 u-w-auto">{label}</dt>
      {chip ? (
        <dd><span className="chip chip--muted u-fs-11">{value}</span></dd>
      ) : (
        <dd className={mono ? 'u-fs-12 u-mono' : 'u-fs-13'}>{value}</dd>
      )}
    </div>
  );
}
