import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getCapabilities } from '../client/runsClient.js';
import { authedHeaders, config, fetchOpts } from '../client/config.js';
import { McpToolsPanel } from '../mcp/McpToolsPanel.js';
import { PageHeader } from '../ui/PageHeader.js';
import { DataTable } from '../ui/DataTable.js';
import { KeyFigureBand } from '../ui/KeyFigure.js';
import { StateCard } from '../ui/StateCard.js';
import { Notice } from '../ui/Notice.js';
import { SkeletonRows } from '../ui/Skeleton.js';
import { A2APeerPanel } from '../peers/A2APeerPanel.js';
import { CheckIcon, CircleIcon, BoxesIcon, ZapIcon, ImageIcon, ShieldIcon } from '../ui/icons/index.js';

/** Render an advertised boolean as a tri-state glyph. `undefined` means the
 *  host hasn't declared the field; that's distinct from `false` (declared off). */
function boolGlyph(v: boolean | undefined): JSX.Element {
  if (v === true) return <span className="u-text-success"><CheckIcon size={14} /></span>;
  if (v === false) return <span className="u-ink-3"><CircleIcon size={14} /></span>;
  return <span className="muted">—</span>;
}

interface HostSurfaceAd {
  name: string;
  supported: boolean;
  implementation?: string;
  note?: string;
}

interface CatalogNode {
  typeId: string;
  packName?: string;
  source: 'local' | 'pack';
  requiresHostSurfaces?: string[];
  missingHostSurfaces?: string[];
}

interface EnvelopeReasoningAd {
  supported?: boolean;
  promptDirective?: 'mandatory' | 'advisory' | 'off';
}
interface EnvelopeReliabilityAd {
  supported?: boolean;
  events?: string[];
  completion?: {
    distinguishesTruncation?: boolean;
    truncationBudgetMultiplier?: number;
  };
}
interface ModelCapabilitiesAd {
  supported?: boolean;
  substitutionSupported?: boolean;
  // Per schemas/capabilities.schema.json §modelCapabilities.advertised:
  // flat list of capability identifiers (`structured-output`, `reasoning`, …),
  // not per-model rows.
  advertised?: string[];
}

interface ImplementationAd {
  name?: string;
  version?: string;
  vendor?: string;
}

interface Caps {
  implementation?: ImplementationAd;
  capabilities?: {
    hostSurfaces?: HostSurfaceAd[];
    profiles?: string[];
    auth?: { profiles?: string[] };
    envelopes?: {
      reasoning?: EnvelopeReasoningAd;
      reliability?: EnvelopeReliabilityAd;
      tierOneSubsetCompliance?: 'strict' | 'warn' | 'off';
    };
    modelCapabilities?: ModelCapabilitiesAd;
    /** RFC 0091 — multimodal perception input on `callAI`. The modalities the
     *  host accepts as ContentParts (text always; image/document/audio gated). */
    aiProviders?: { input?: { modalities?: string[] } };
  };
}

/** Reference-host badge filenames served at `${config.siteBaseUrl}/badge/<host>.svg`.
 *  Map common implementation-name fragments to a published badge so a host
 *  that identifies as one of the references gets its credibility surface
 *  inline. Out-of-tree hosts (e.g. MyndHyve workflow-runtime) fall through
 *  to the generic "see leaderboard" affordance. Origin is config-driven so
 *  an air-gapped / fork deployment can point at its own badge mirror via
 *  `VITE_OPENWOP_SITE_URL` (the badge SVGs ship in this repo's
 *  `public/badge/` for same-origin serving). */
const KNOWN_BADGE_HOSTS: ReadonlyArray<{ match: RegExp; file: string; labelKey: string }> = [
  { match: /postgres/i, file: 'postgres.svg', labelKey: 'badgePostgres' },
  { match: /sqlite/i, file: 'sqlite.svg', labelKey: 'badgeSqlite' },
  { match: /python/i, file: 'python-in-memory.svg', labelKey: 'badgePython' },
  { match: /in.?memory|workflow.?engine/i, file: 'in-memory.svg', labelKey: 'badgeInMemory' },
];

function matchBadgeFor(implName?: string): { url: string; labelKey: string } | null {
  if (!implName) return null;
  for (const entry of KNOWN_BADGE_HOSTS) {
    if (entry.match.test(implName)) {
      return { url: `${config.siteBaseUrl}/badge/${entry.file}`, labelKey: entry.labelKey };
    }
  }
  return null;
}

const LEADERBOARD_URL = `${config.siteBaseUrl}/conformance/`;

interface CatalogResp {
  nodes: CatalogNode[];
}

export function CapabilitiesPanel() {
  const { t } = useTranslation('discovery');
  const [caps, setCaps] = useState<Caps | null>(null);
  const [catalog, setCatalog] = useState<CatalogResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The hero coverage figures double as a filter (DESIGN §4.5): toggling
  // "blocked" scopes the surface table below to only the blocked surfaces.
  const [coverageFilter, setCoverageFilter] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getCapabilities() as Promise<Caps>,
      fetch(`${config.baseUrl}/v1/host/openwop-app/node-catalog`, fetchOpts({
        headers: authedHeaders(),
      })).then((r) => r.json() as Promise<CatalogResp>),
    ])
      .then(([c, k]) => {
        if (cancelled) return;
        setCaps(c);
        setCatalog(k);
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, []);

  const surfaces = caps?.capabilities?.hostSurfaces ?? [];
  const nodes = catalog?.nodes ?? [];
  const runnable = nodes.filter((n) => !n.missingHostSurfaces || n.missingHostSurfaces.length === 0);
  const blocked = nodes.length - runnable.length;

  // Group blocked nodes by their first missing surface — so users see
  // "12 nodes need host.mcp" rather than 12 separate rows.
  const blockedBySurface = new Map<string, number>();
  for (const n of nodes) {
    const m = n.missingHostSurfaces ?? [];
    if (m.length === 0) continue;
    const key = m[0]!;
    blockedBySurface.set(key, (blockedBySurface.get(key) ?? 0) + 1);
  }

  const blockedRows = [...blockedBySurface.entries()].map(([surface, count]) => ({ surface, nodes: count }));

  return (
    <section className="page-stack">
      <PageHeader
        eyebrow={t('eyebrow')}
        title={t('title')}
        lede={t('lede')}
      />

      {error && <Notice variant="error">{error}</Notice>}

      {/* Plain-language framing — the headline (can this host run my work?) is up
          top; the raw protocol advertisement below is for operators who need it. */}
      <Notice variant="info">
        <strong>{t('explainTitle')}</strong>
        <p className="u-mt-1 u-mb-0">{t('explainBody')}</p>
      </Notice>

      {/* ── Host identity & coverage tier ─────────────────────────────────
          The page's headline question — "can this host run my workflow,
          and what's missing?" — leads, with identity above the fold. */}
      <ConformanceProfilesCard caps={caps} />

      <div className="surface-card">
        <h2>{t('packCoverage')}</h2>
        <p className="muted u-mb-3">
          {t('packCoverageHelpPrefix')}<strong>{t('packCoverageHelpBlocked')}</strong>{t('packCoverageHelpSuffix')}
        </p>
        {catalog ? (
          <>
            <KeyFigureBand
              ariaLabel={t('coverageAriaLabel')}
              {...(blocked > 0 ? { activeKey: coverageFilter, onToggle: (k: string) => setCoverageFilter((p) => (p === k ? null : k)) } : {})}
              figures={[
                { key: 'runnable', label: t('figureRunnable'), value: runnable.length, glyph: <CheckIcon size={13} /> },
                { key: 'total', label: t('figureTotalNodes'), value: nodes.length, glyph: <BoxesIcon size={13} /> },
                { key: 'blocked', label: t('figureBlocked'), value: blocked, tone: blocked > 0 ? 'attention' : 'default', glyph: <ZapIcon size={13} /> },
              ]}
            />
            {blockedRows.length > 0 ? (
              // The "Blocked" figure is the drill-down toggle (DESIGN §4.5):
              // pressing it scopes the band to the gaps; the breakdown table
              // shows when no filter is active OR when "blocked" is selected.
              (coverageFilter === null || coverageFilter === 'blocked') ? (
                <div className="u-mt-4">
                  <DataTable
                    caption={t('blockedTableCaption')}
                    density="compact"
                    rows={blockedRows}
                    rowKey={(r) => r.surface}
                    initialSort={{ key: 'nodes', dir: 'desc' }}
                    columns={[
                      { key: 'surface', header: t('colBlockedBySurface'), render: (r) => <code>{r.surface}</code>, sortValue: (r) => r.surface },
                      { key: 'nodes', header: t('colNodes'), align: 'right', render: (r) => <span className="chip chip--warning">{r.nodes}</span>, sortValue: (r) => r.nodes },
                    ]}
                  />
                </div>
              ) : (
                <p className="muted u-mt-3 u-fs-13">{t('allRunnableClearPrefix', { count: runnable.length })}<strong>{t('allRunnableClearBlocked')}</strong>{t('allRunnableClearSuffix', { blocked })}</p>
              )
            ) : (
              <div className="u-mt-4">
                <StateCard
                  icon={<CheckIcon size={20} />}
                  title={t('everyNodeRunnableTitle')}
                  body={t('everyNodeRunnableBody')}
                />
              </div>
            )}
          </>
        ) : (
          !error && <SkeletonRows rows={3} columns={['60%', '20%']} />
        )}
      </div>

      {/* ── Surfaces & envelopes tier ─────────────────────────────────── */}
      <div className="surface-card">
        <h2>{t('hostSurfaces')}</h2>
        <p className="muted">
          {t('hostSurfacesHelpPrefix')}<code>capabilities.hostSurfaces</code>{t('hostSurfacesHelpImplLead')}
          <em> {t('hostSurfacesHelpImplEm')}</em>{t('hostSurfacesHelpImplMid')}<code>in-memory</code>{t('hostSurfacesHelpImplOr')}<code>sqlite-in-memory</code>{t('hostSurfacesHelpImplTail')}<code>examples/hosts/postgres</code>{t('hostSurfacesHelpEnd')}
        </p>
        {caps ? (
          <DataTable
            caption={t('surfacesTableCaption')}
            density="compact"
            rows={surfaces}
            rowKey={(s) => s.name}
            initialSort={{ key: 'supported', dir: 'asc' }}
            empty={<StateCard icon={<BoxesIcon size={20} />} title={t('noSurfacesTitle')} body={<>{t('noSurfacesBodyPrefix')}<code>capabilities.hostSurfaces</code>{t('noSurfacesBodySuffix')}</>} />}
            columns={[
              { key: 'name', header: t('colSurface'), render: (s) => <code>{s.name}</code>, sortValue: (s) => s.name },
              { key: 'supported', header: t('colSupported'), align: 'center', render: (s) => (s.supported ? <span className="u-text-success"><CheckIcon size={14} /></span> : <span className="u-ink-3"><CircleIcon size={14} /></span>), sortValue: (s) => (s.supported ? 0 : 1) },
              { key: 'implementation', header: t('colImplementation'), render: (s) => (s.implementation ? <code>{s.implementation}</code> : <span className="muted">{t('emDash')}</span>), sortValue: (s) => s.implementation ?? '' },
              { key: 'note', header: t('colNote'), render: (s) => <span className="muted">{s.note ?? ''}</span>, cellClassName: 'muted' },
            ]}
          />
        ) : (
          !error && <SkeletonRows rows={4} columns={['28%', '12%', '24%', '30%']} />
        )}
      </div>

      <div className="surface-card">
        <h2>{t('envelopeDiscipline')}</h2>
        <p className="muted">
          {t('envelopeHelp')}
        </p>
        <p className="muted u-fs-12 u-mt-0">
          {t('envelopeHelp2')}
        </p>
        {caps ? (
          <DataTable
            caption={t('envelopeTableCaption')}
            density="compact"
            rows={envelopeRows(caps, t)}
            rowKey={(r) => r.key}
            columns={[
              { key: 'key', header: t('colSurface'), render: (r) => <code>{r.key}</code> },
              { key: 'value', header: t('colValue'), render: (r) => r.value },
              { key: 'note', header: t('colNote'), render: (r) => <span className="muted">{r.note}</span>, cellClassName: 'muted' },
            ]}
          />
        ) : (
          !error && <SkeletonRows rows={6} columns={['40%', '12%', '40%']} />
        )}
      </div>

      <div className="surface-card">
        <h2>{t('modelCapabilities')}</h2>
        <p className="muted">
          {t('modelCapabilitiesHelpPrefix')}<code>model.capability.substituted</code>{t('modelCapabilitiesHelpSuffix')}
        </p>
        {caps ? (
          caps.capabilities?.modelCapabilities ? (
            <>
              <div className="u-flex u-gap-2 u-items-center cap-chip-list u-mb-3">
                <span className={`chip ${caps.capabilities.modelCapabilities.supported ? 'chip--success' : 'chip--muted'}`}>
                  {caps.capabilities.modelCapabilities.supported ? t('advertised') : t('notAdvertised')}
                </span>
                <span className={`chip ${caps.capabilities.modelCapabilities.substitutionSupported ? 'chip--accent' : 'chip--muted'}`}>
                  {caps.capabilities.modelCapabilities.substitutionSupported ? t('substitutionOn') : t('substitutionOff')}
                </span>
                <span className="chip chip--muted">{t('declaredCount', { count: caps.capabilities.modelCapabilities.advertised?.length ?? 0 })}</span>
              </div>
              {caps.capabilities.modelCapabilities.advertised?.length ? (
                <div className="cap-chip-list">
                  {caps.capabilities.modelCapabilities.advertised.map((c) => (
                    <span key={c} className="chip chip--success">{c}</span>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <StateCard
              icon={<ZapIcon size={20} />}
              title={t('modelCapsNotAdvertisedTitle')}
              body={<>{t('modelCapsNotAdvertisedBodyPrefix')}<code>modelCapabilities</code>{t('modelCapsNotAdvertisedBodySuffix')}</>}
            />
          )
        ) : (
          !error && <SkeletonRows rows={1} columns={['50%']} />
        )}
      </div>

      <div className="surface-card">
        <h2>{t('inputModalities')}</h2>
        <p className="muted">
          {t('inputModalitiesHelpPrefix')}<code>callAI</code>{t('inputModalitiesHelpMid')}<code>{t('inputModalitiesHelpTextEm')}</code>{t('inputModalitiesHelpAfterText')}<code>unsupported_modality</code>{t('inputModalitiesHelpSuffix')}
        </p>
        {caps ? (
          caps.capabilities?.aiProviders?.input?.modalities?.length ? (
            <div className="cap-chip-list">
              {caps.capabilities.aiProviders.input.modalities.map((m) => (
                <span key={m} className="chip chip--success">{m}</span>
              ))}
            </div>
          ) : (
            <StateCard
              icon={<ImageIcon size={20} />}
              title={t('noModalitiesTitle')}
              body={<>{t('noModalitiesBodyPrefix')}<code>aiProviders.input.modalities</code>{t('noModalitiesBodyMid')}<code>text</code>{t('noModalitiesBodySuffix')}</>}
            />
          )
        ) : (
          !error && <SkeletonRows rows={1} columns={['40%']} />
        )}
      </div>

      <McpToolsPanel />
      <A2APeerPanel />

      <div className="surface-card">
        <h2>{t('rawAdvertisement')}</h2>
        <p className="muted">
          {t('rawAdvertisementHelpPrefix')}<code>GET /.well-known/openwop</code>{t('rawAdvertisementHelpSuffix')}
        </p>
        {caps ? (
          // tabIndex=0 so the scrollable JSON is keyboard-reachable.
          <pre tabIndex={0} aria-label={t('rawCapsAriaLabel')}>{JSON.stringify(caps, null, 2)}</pre>
        ) : (
          !error && <SkeletonRows rows={5} columns={['80%', '60%', '70%', '50%', '65%']} />
        )}
      </div>
    </section>
  );
}

interface EnvelopeRow { key: string; value: JSX.Element; note: JSX.Element }

/** Flatten the envelope-discipline advertisement into table rows so it renders
 *  through the shared <DataTable> register (was a bespoke cap-table). */
function envelopeRows(caps: Caps, t: (key: string) => string): EnvelopeRow[] {
  const env = caps.capabilities?.envelopes;
  return [
    {
      key: 'envelopes.reasoning.supported',
      value: boolGlyph(env?.reasoning?.supported),
      note: <>{t('envReasoningSupportedNoteLead')} <code>reasoning</code> {t('envReasoningSupportedNoteTail')}</>,
    },
    {
      key: 'envelopes.reasoning.promptDirective',
      value: env?.reasoning?.promptDirective ? <code>{env.reasoning.promptDirective}</code> : <span className="muted">{t('emDash')}</span>,
      note: <>{t('envReasoningDirectiveNote')}</>,
    },
    {
      key: 'envelopes.tierOneSubsetCompliance',
      value: env?.tierOneSubsetCompliance ? <code>{env.tierOneSubsetCompliance}</code> : <span className="muted">{t('emDash')}</span>,
      note: <>{t('envTierOneNote')}</>,
    },
    {
      key: 'envelopes.reliability.supported',
      value: boolGlyph(env?.reliability?.supported),
      note: <>{t('envReliabilitySupportedNote')}</>,
    },
    {
      key: 'envelopes.reliability.events',
      value: env?.reliability?.events?.length ? (
        <span className="cap-chip-list">
          {env.reliability.events.map((e) => <span key={e} className="chip chip--muted">{e}</span>)}
        </span>
      ) : <span className="muted">{t('emDash')}</span>,
      note: <>{t('envReliabilityEventsNote')}</>,
    },
    {
      key: 'envelopes.reliability.completion.distinguishesTruncation',
      value: boolGlyph(env?.reliability?.completion?.distinguishesTruncation),
      note: <>{t('envTruncationNote')}</>,
    },
    {
      key: 'envelopes.reliability.completion.truncationBudgetMultiplier',
      value: typeof env?.reliability?.completion?.truncationBudgetMultiplier === 'number'
        ? <code>×{env.reliability.completion.truncationBudgetMultiplier}</code>
        : <span className="muted">{t('emDash')}</span>,
      note: <>{t('envTruncationBudgetNote')}</>,
    },
  ];
}

/** Per `plans/app-buildable-now-on-existing-protocol.md` §21 — render the
 *  connected host's implementation identity + advertised profile set + a
 *  conformance-badge affordance. The badge is embedded when the implementation
 *  name matches a published reference-host badge (openwop.dev/badge/*.svg);
 *  out-of-tree hosts get a leaderboard link instead. Always shows the
 *  Implementation row so an operator can copy the exact `{name, version, vendor}`
 *  for a bug report. Leads the page as the host-identity surface. */
function ConformanceProfilesCard({ caps }: { caps: Caps | null }): JSX.Element {
  const { t } = useTranslation('discovery');
  const impl = caps?.implementation ?? {};
  const interruptProfiles = caps?.capabilities?.profiles ?? [];
  const authProfiles = caps?.capabilities?.auth?.profiles ?? [];
  const allProfiles = [...new Set([...interruptProfiles, ...authProfiles])].sort();
  const badge = matchBadgeFor(impl.name);
  return (
    <div className="surface-card">
      <h2 className="u-flex u-gap-2 u-items-center"><span className="u-ink-3" aria-hidden="true"><ShieldIcon size={18} /></span> {t('conformanceAndProfiles')}</h2>
      <p className="muted">
        {t('conformanceHelpPrefix')}{' '}
        <code>capabilities.profiles[]</code>{t('conformanceHelpAnd')}<code>capabilities.auth.profiles[]</code>{' '}
        {t('conformanceHelpMid')}{' '}
        <a href={LEADERBOARD_URL} target="_blank" rel="noreferrer">
          {t('conformanceLeaderboardLink')}
        </a>{' '}
        {t('conformanceHelpSuffix')}
      </p>
      <table className="cap-table">
        <tbody>
          <tr>
            <th className="cap-table-label">{t('implementationLabel')}</th>
            <td>
              {caps ? (
                <>
                  {impl.name ? <code>{impl.name}</code> : <span className="muted">{t('emDash')}</span>}
                  {impl.version ? <> <span className="muted">{t('versionPrefix', { version: impl.version })}</span></> : null}
                  {impl.vendor ? <> <span className="muted">{t('vendorPrefix', { vendor: impl.vendor })}</span></> : null}
                </>
              ) : <span className="muted">{t('emDash')}</span>}
            </td>
          </tr>
          <tr>
            <th className="cap-table-label">{t('profilesClaimed', { count: allProfiles.length })}</th>
            <td>
              {allProfiles.length === 0 ? (
                <span className="muted">{t('noneAdvertised')}</span>
              ) : (
                <div className="cap-chip-list">
                  {allProfiles.map((p) => (
                    <span key={p} className="chip chip--accent">{p}</span>
                  ))}
                </div>
              )}
            </td>
          </tr>
          <tr>
            <th className="cap-table-label">{t('referenceHostBadge')}</th>
            <td>
              {badge ? (
                <a href={LEADERBOARD_URL} target="_blank" rel="noreferrer" title={t(badge.labelKey)}>
                  <img className="cap-badge-img" src={badge.url} alt={t('badgeAlt', { label: t(badge.labelKey) })} />
                </a>
              ) : (
                <span className="muted">
                  {t('noBadgePrefix')}
                  <a href={LEADERBOARD_URL} target="_blank" rel="noreferrer">{t('leaderboard')}</a>{' '}
                  {t('noBadgeSuffix')}
                </span>
              )}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
