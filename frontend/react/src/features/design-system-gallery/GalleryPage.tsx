/**
 * Design-system gallery (ADR 0510 Phase 2, DSA-031) — the in-repo visual
 * contract surface. Renders every shared `ui/` primitive and the composed
 * patterns in their meaningful states, from DETERMINISTIC fixture data (no
 * backend fetch, no clock, no randomness), so Playwright can snapshot each
 * section as a blocking baseline across the theme/preference matrix
 * (`e2e/design-system.spec.ts`).
 *
 * An engineering surface, not a product feature: admin-tier route behind the
 * existing `developer-tools` toggle (the manual-tests ADR 0183/0196 Gate-B
 * precedent). ADR 0510 §1 forbids a dedicated design-system toggle — the
 * design system itself is not disableable; only this INSPECTION page is gated.
 *
 * State labels render as literal mono identifiers on purpose (they name code
 * states, like `chip--danger`); page chrome is localized via the feature ns.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton, SkeletonRows } from '../../ui/Skeleton.js';
import { Field } from '../../ui/Field.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { StatusBadge } from '../../ui/StatusBadge.js';
import { KeyFigureBand } from '../../ui/KeyFigure.js';
import { Sparkline } from '../../ui/Sparkline.js';
import { Avatar } from '../../ui/Avatar.js';
import { Tabs } from '../../ui/Tabs.js';
import { IconButton } from '../../ui/IconButton.js';
import { Button } from '../../ui/Button.js';
import { InlineState } from '../../ui/InlineState.js';
import { InfoTip } from '../../ui/InfoTip.js';
import { Tooltip } from '../../ui/Tooltip.js';
import { ToastCard } from '../../ui/ToasterView.js';
import { AlertIcon, CheckIcon, ChevronDownIcon, SearchIcon, SettingsIcon, ShieldIcon, UserIcon, WorkflowIcon } from '../../ui/icons/index.js';
import { NavRailItemContent, NavRailSection } from '../../chrome/NavRailPrimitives.js';

/** Deterministic fixture rows for the table specimen. */
interface FixtureRow { id: string; name: string; status: string; count: number }
const TABLE_ROWS: FixtureRow[] = [
  { id: 'r1', name: 'Lead enrichment', status: 'succeeded', count: 24 },
  { id: 'r2', name: 'Invoice sync', status: 'running', count: 3 },
  { id: 'r3', name: 'Weekly digest', status: 'failed', count: 0 },
];
const TABLE_COLS: DataColumn<FixtureRow>[] = [
  { key: 'name', header: 'Name', render: (r) => r.name, sortValue: (r) => r.name },
  { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
  { key: 'count', header: 'Runs', align: 'right', render: (r) => r.count, sortValue: (r) => r.count },
];

const SPARK_POINTS = [2, 5, 3, 8, 6, 9, 4, 7, 10, 8];

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section data-gallery={id} className="surface-card u-p-4 u-grid u-gap-3">
      <h2 className="u-fs-16 u-m-0">{title}</h2>
      {children}
    </section>
  );
}

/** A labelled specimen row: the literal state identifier + the rendering. */
function Specimen({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="u-grid u-gap-1">
      <code className="u-fs-11 muted">{label}</code>
      <div className="u-flex u-gap-2 u-items-center u-wrap">{children}</div>
    </div>
  );
}

interface AdminRailSpecimenProps {
  mode: 'expanded' | 'collapsed' | 'mobile';
  label: string;
  title: string;
  group: string;
  overview: string;
  capabilities: string;
  users: string;
  locked: string;
  beta: string;
  pageContent: string;
}

function AdminRailSpecimen({ mode, label, title, group, overview, capabilities, users, locked, beta, pageContent }: AdminRailSpecimenProps): JSX.Element {
  const compact = mode === 'collapsed';
  return (
    <article className={`dsg-admin-fixture dsg-admin-fixture--${mode}`} aria-label={label}>
      {mode === 'mobile' ? <Button variant="secondary" className="admin-rail-mobile-toggle" aria-expanded aria-controls="dsg-admin-mobile-nav"><span className="admin-rail-mobile-current">{title} · {overview}</span><span className="admin-nav-group-chevron" aria-hidden><ChevronDownIcon size={14} /></span></Button> : null}
      <div className="dsg-admin-fixture__body">
        <nav id={mode === 'mobile' ? 'dsg-admin-mobile-nav' : undefined} className="dsg-admin-fixture__rail" aria-label={label}>
          {!compact ? <strong className="admin-rail-title">{title}</strong> : null}
          {/* The collapsed rail hides every label, so each link needs its name
              another way — exactly what the real rail does (`AdminLayout.tsx`:
              `aria-label={collapsed ? label : undefined}`). This specimen copied
              the markup and not that line, so the gallery shipped three
              icon-only links with no accessible name (axe `link-name`, serious). */}
          <NavRailSection classPrefix="admin-nav" title={group} showHeader={!compact} collapsed={false} onToggle={() => undefined}>
            <li><a href="#admin-specimen" className="admin-nav-link is-active" aria-current="page" {...(compact ? { 'aria-label': overview } : {})}><NavRailItemContent classPrefix="admin-nav" icon={<SettingsIcon size={16} />} label={overview} locked={false} lockedLabel={locked} compact={compact} /></a></li>
            <li><a href="#admin-specimen" className="admin-nav-link" {...(compact ? { 'aria-label': capabilities } : {})}><NavRailItemContent classPrefix="admin-nav" icon={<ShieldIcon size={16} />} label={capabilities} locked={false} lockedLabel={locked} badge={beta} compact={compact} /></a></li>
            <li><a href="#admin-specimen" className="admin-nav-link" {...(compact ? { 'aria-label': `${users} · ${locked}` } : {})}><NavRailItemContent classPrefix="admin-nav" icon={<UserIcon size={16} />} label={users} locked lockedLabel={locked} compact={compact} /></a></li>
          </NavRailSection>
        </nav>
        <div className="dsg-admin-fixture__content"><strong>{label}</strong><span className="muted">{pageContent}</span></div>
      </div>
    </article>
  );
}

export function GalleryPage(): JSX.Element {
  const { t } = useTranslation('design-system-gallery');
  const [tab, setTab] = useState<'first' | 'second' | 'third'>('first');
  /* Fixed, not interactive-by-accident: the gallery is a determinism contract,
     so the active figure tile is seeded and stays put across renders. */
  const [figureKey, setFigureKey] = useState<string | null>('total');

  return (
    <div className="u-grid u-gap-4" data-walkthrough="design-system.page">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />

      <Section id="typography" title={t('typography')}>
        <Specimen label="serif display / sans body / mono meta">
          <div className="u-grid u-gap-1">
            <span className="dsg-type-display">Editorial voice</span>
            <span className="dsg-type-body">{t('typographyBody')}</span>
            <span className="dsg-type-meta">MONO · METADATA · 2026-08-01</span>
          </div>
        </Specimen>
      </Section>

      <Section id="buttons" title={t('buttons')}>
        <Specimen label="Button: primary / secondary / quiet / danger / link">
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="quiet">Quiet</Button>
          <Button variant="danger">Delete</Button>
          <Button variant="link">Link action</Button>
        </Specimen>
        <Specimen label="size=sm / disabled / loading / fullWidth">
          <Button variant="secondary" size="sm">Small</Button>
          <Button variant="primary" disabled>Disabled</Button>
          <Button variant="primary" loading>Saving…</Button>
        </Specimen>
        <Specimen label="icon-button / with-glyph">
          <Tooltip text={t('searchLabel')}><IconButton label={t('searchLabel')} icon={<SearchIcon size={15} />} onClick={() => undefined} /></Tooltip>
          <Button variant="secondary"><CheckIcon size={14} /> With glyph</Button>
        </Specimen>
      </Section>

      <Section id="inline-states" title={t('inlineStates')}>
        <Specimen label="loading / empty / failed (compact embedded regions)">
          <div className="u-grid u-gap-1 u-w-full">
            <InlineState kind="loading" />
            <InlineState kind="empty" message={t('inlineEmptySample')} action={<Button variant="quiet" size="sm">{t('stateEmptyCta')}</Button>} />
            <InlineState kind="failed" message={t('inlineFailedSample')} action={<Button variant="quiet" size="sm">{t('stateRetry')}</Button>} />
          </div>
        </Specimen>
      </Section>

      <Section id="chips" title={t('chips')}>
        <Specimen label="chip / chip--muted / chip--accent / chip--success / chip--warning / chip--danger / chip--ai">
          <span className="chip">Default</span>
          <span className="chip chip--muted">Muted</span>
          <span className="chip chip--accent">Accent</span>
          <span className="chip chip--success">Succeeded</span>
          <span className="chip chip--warning">Degraded</span>
          <span className="chip chip--danger">Failed</span>
          <span className="chip chip--ai">AI</span>
        </Specimen>
      </Section>

      <Section id="notices" title={t('notices')}>
        {/* Notice renders its own variant glyph — children carry text only. */}
        <Notice variant="info">{t('noticeInfo')}</Notice>
        <Notice variant="success">{t('noticeSuccess')}</Notice>
        <Notice variant="warning">{t('noticeWarning')}</Notice>
        <Notice variant="error">{t('noticeError')}</Notice>
      </Section>

      <Section id="states" title={t('states')}>
        <div className="u-grid-3 u-gap-3">
          <StateCard loading title={t('stateLoading')} body={<Skeleton width="80%" />} />
          <StateCard icon={<WorkflowIcon size={26} />} title={t('stateEmpty')} body={t('stateEmptyBody')} action={<Button variant="secondary">{t('stateEmptyCta')}</Button>} />
          {/* Deliberately SILENT: this is a static specimen — announcing it
              would post a phantom failure to the global live region on every
              gallery visit (allowlisted in check-failure-card-announce). */}
          <StateCard icon={<AlertIcon size={26} />} title={t('stateFailed')} body={t('stateFailedBody')} action={<Button variant="secondary">{t('stateRetry')}</Button>} />
        </div>
        <Specimen label="skeleton-rows">
          <div className="u-grid u-gap-1 u-w-full"><SkeletonRows rows={3} columns={['2fr', '1fr', '1fr']} /></div>
        </Specimen>
      </Section>

      <Section id="admin-shell" title={t('adminShell')}>
        <div id="admin-specimen" className="dsg-admin-matrix">
          {(['expanded', 'collapsed', 'mobile'] as const).map((mode) => (
            <AdminRailSpecimen
              key={mode}
              mode={mode}
              label={t(mode === 'expanded' ? 'adminExpanded' : mode === 'collapsed' ? 'adminCollapsed' : 'adminMobile')}
              title={t('adminTitle')}
              group={t('adminGroup')}
              overview={t('adminOverview')}
              capabilities={t('adminCapabilities')}
              users={t('adminUsers')}
              locked={t('adminLocked')}
              beta={t('adminBeta')}
              pageContent={t('adminPageContent')}
            />
          ))}
          <div className="dsg-admin-state"><code>{t('adminLoading')}</code><StateCard loading title={t('stateLoading')} /></div>
          <div className="dsg-admin-state"><code>{t('adminForbidden')}</code><StateCard icon={<ShieldIcon size={20} />} title={t('adminForbiddenTitle')} body={t('adminForbiddenBody')} /></div>
          <div className="dsg-admin-state"><code>{t('adminEmpty')}</code><StateCard icon={<SettingsIcon size={20} />} title={t('adminEmptyTitle')} body={t('adminEmptyBody')} /></div>
        </div>
      </Section>

      <Section id="fields" title={t('fields')}>
        <div className="u-grid-3 u-gap-3">
          <Field label={t('fieldText')} help={t('fieldHelp')}>{(p) => <input {...p} defaultValue="A value" />}</Field>
          <Field label={t('fieldInvalid')} error={t('fieldError')}>{(p) => <input {...p} defaultValue="not-an-email" />}</Field>
          <Field label={t('fieldSelect')}>
            {(p) => (
              <select {...p} defaultValue="b">
                <option value="a">Option A</option>
                <option value="b">Option B</option>
              </select>
            )}
          </Field>
        </div>
        <Field label={t('fieldTextarea')}>{(p) => <textarea {...p} rows={2} defaultValue="Multiline content" />}</Field>
      </Section>

      <Section id="table" title={t('table')}>
        <DataTable columns={TABLE_COLS} rows={TABLE_ROWS} rowKey={(r) => r.id} caption={t('tableCaption')} />
        <DataTable columns={TABLE_COLS} rows={[]} rowKey={(r) => r.id} caption={t('tableEmptyCaption')} empty={<span className="muted">{t('tableEmpty')}</span>} />
      </Section>

      <Section id="figures" title={t('figures')}>
        {/* INTERACTIVE with one tile active. A static band never renders
            `.figure-tile--active`, so its selected rail had NO snapshot coverage
            — which is how a 14px corner radius on a 3px-wide bar shipped
            unnoticed (fixed 2026-08-08). `activeKey` + `onToggle` put the
            selected state in the visual contract. */}
        <KeyFigureBand
          ariaLabel={t('figuresLabel')}
          activeKey={figureKey}
          onToggle={setFigureKey}
          figures={[
            { key: 'total', label: t('figTotal'), value: 128 },
            { key: 'risk', label: t('figAttention'), value: 4, tone: 'attention' },
            { key: 'trend', label: t('figTrend'), value: '92%', sub: '+12%', subTone: 'up' },
          ]}
        />
        <Specimen label="sparkline">
          <Sparkline points={SPARK_POINTS} label={t('sparkLabel')} />
        </Specimen>
      </Section>

      <Section id="identity" title={t('identity')}>
        <Specimen label="avatar / status-badge / info-tip">
          <Avatar name="Ada Lovelace" hueKey="ada" size={28} />
          <Avatar name="Grace Hopper" hueKey="grace" size={28} />
          <StatusBadge status="succeeded" />
          <StatusBadge status="running" />
          <StatusBadge status="failed" />
          <InfoTip label={t('tipLabel')} text={t('tipText')} />
        </Specimen>
      </Section>

      <Section id="tabs" title={t('tabs')}>
        <Tabs
          label={t('tabsLabel')}
          idBase="gallery-tabs"
          items={[
            { id: 'first', label: 'First' },
            { id: 'second', label: 'Second' },
            { id: 'third', label: 'Third' },
          ]}
          value={tab}
          onChange={setTab}
        />
        <div id="gallery-tabs-panel" role="tabpanel" className="u-fs-13 muted">{t('tabsPanel', { tab })}</div>
      </Section>

      <Section id="toasts" title={t('toasts')}>
        {/* The live stack is fixed bottom-right; the specimen renders the same
            cards in flow. An error persists until dismissed (WCAG 2.2.1). */}
        <div className="toast-specimen">
          <ToastCard item={{ id: 1, variant: 'success', message: t('toastSuccess') }} onDismiss={() => undefined} />
          <ToastCard item={{ id: 2, variant: 'info', message: t('toastInfo') }} onDismiss={() => undefined} />
          <ToastCard item={{ id: 3, variant: 'warning', message: t('toastWarning') }} onDismiss={() => undefined} />
          <ToastCard item={{ id: 4, variant: 'error', message: t('toastError') }} onDismiss={() => undefined} />
        </div>
      </Section>
    </div>
  );
}
