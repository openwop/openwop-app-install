/**
 * UI Plugins (host-extension feature — ADR 0300, RFC 0117/0119).
 *
 * The reachable witness surface for the front-end-plugin graduation boundary. Gates
 * on useFeatureAccess('ui-plugins'). Lists the plugins the host serves + its
 * advertised isolation mechanism, then MOUNTS the reference artifact-viewer plugin
 * (a downloaded, signed `kind:"frontend-plugin"` pack) in a cross-origin sandboxed
 * iframe via PluginFrame — where the four falsifiable legs are observable:
 * isolated (opaque origin) · egress-denied (CSP) · allowlist-bound
 * (method_not_allowed) · no-BYOK.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { ErrorBoundary } from '../../ui/ErrorBoundary.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { LockIcon, PlugIcon, ShieldIcon } from '../../ui/icons/index.js';
import { PluginFrame } from './PluginFrame.js';
import { IsolationSelfTest } from './IsolationSelfTest.js';
import { TrustedPluginHost } from './TrustedPluginHost.js';
import { ensureDemoArtifact, listPlugins, type PluginList, type ServedPlugin } from './pluginClient.js';

export function UiPluginsPage(): JSX.Element {
  const { t } = useTranslation('ui-plugins');
  const access = useFeatureAccess('ui-plugins');
  const [list, setList] = useState<PluginList | null>(null);
  const [artifactId, setArtifactId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The demo artifact the reference viewer reads. Tracked separately because
   *  its failure used to be swallowed — see the comment on the witness card. */
  const [artifactError, setArtifactError] = useState<string | null>(null);

  useEffect(() => {
    if (!access.enabled) return;
    void listPlugins().then((l) => { setList(l); setError(null); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    void ensureDemoArtifact().then((a) => { setArtifactId(a.artifactId); setArtifactError(null); })
      .catch((e) => setArtifactError(e instanceof Error ? e.message : String(e)));
  }, [access.enabled]);

  if (access.loading) {
    // PACK-UX-3 — keep the page chrome stable while access resolves (no
    // header pop-in after the skeleton).
    return (
      <div className="u-gap-3 u-flex u-flex-col" data-walkthrough="ui-plugins.page">
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
        <Skeleton />
      </div>
    );
  }
  if (!access.enabled) {
    return <StateCard icon={<LockIcon />} title={t('notEnabledTitle')} body={t('notEnabledBody')} />;
  }

  // ADR 0367 P3 — prefer a TRUSTED artifact-viewer when the lane serves one
  // (the T1 partner pack demoes main-frame); otherwise the first sandbox viewer.
  const viewers = list?.plugins.filter((p) => p.surface === 'artifact-viewer') ?? [];
  const viewer: ServedPlugin | undefined = viewers.find((p) => p.tier === 'trusted') ?? viewers[0];

  return (
    <div className="u-gap-3 u-flex u-flex-col" data-walkthrough="ui-plugins.page">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />

      <div className="surface-card u-gap-2 u-p-4">
        <div className="u-flex u-items-center u-gap-2">
          <ShieldIcon />
          <strong>{t('isolationLabel')}</strong>
          {/* Never leave the ellipsis standing as if still loading once the read
              has definitively failed — this chip is the page's headline claim. */}
          <span className={list ? 'chip chip--accent' : 'chip chip--muted'}>
            {list ? list.isolation : error ? t('isolationUnknown') : '…'}
          </span>
        </div>
        <p className="muted">{t('boundaryExplainer')}</p>
        <ul className="muted u-gap-1">
          <li>{t('legIsolation')}</li>
          <li>{t('legEgress')}</li>
          <li>{t('legAllowlist')}</li>
          <li>{t('legNoByok')}</li>
        </ul>
      </div>

      {/* ADR 0493 — the legs above are CLAIMS; this checks the three that are
          mechanically checkable and says plainly that the fourth is not. */}
      <IsolationSelfTest plugin={viewer} />

      <div className="surface-card u-gap-2 u-p-4">
        <div className="u-flex u-items-center u-gap-2">
          <PlugIcon />
          <strong>{t('installedLabel')}</strong>
        </div>
        {/* A failed list read used to leave this skeleton spinning forever — a
            page that says "still loading" about a request that already failed.
            "This host serves no frontend-plugin packs" is also a claim only a
            read that LANDED may make. */}
        {error ? (
          <StateCard announce icon={<PlugIcon />} title={t('listFailedTitle')} body={`${t('listFailedLead')} ${error}`} />
        ) : !list ? <Skeleton /> : list.plugins.length === 0 ? (
          <StateCard icon={<PlugIcon />} title={t('noneTitle')} body={t('noneBody')} />
        ) : (
          <ul className="u-gap-2 u-flex u-flex-col">
            {list.plugins.map((p) => (
              <li key={`${p.packName}:${p.pluginId}`} className="u-flex u-items-center u-gap-2">
                <code>{p.packName}</code>
                <span className="chip chip--muted">{p.surface}</span>
                {/* ADR 0367 — the host's live trust verdict, never a cached claim */}
                <span className={p.tier === 'trusted' ? 'chip chip--success' : 'chip chip--muted'}>
                  {p.tier === 'trusted' ? t('tierTrusted') : t('tierCommunity')}
                </span>
                {p.hostApi.map((m) => <span key={m} className="chip chip--accent">{m}</span>)}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/*
        The live witness. This card USED to be `viewer && artifactId ? … : null`,
        so four different situations all rendered as nothing at all: still
        loading · the host serves no artifact-viewer · the demo artifact could
        not be prepared · the list read failed. The old code carried the comment
        "viewer shows the read error" on the swallowed `ensureDemoArtifact`
        catch — but the viewer never mounted, so nothing showed it.

        That matters more here than on an ordinary page: this IS the falsifiable
        witness for the plugin-isolation boundary. An operator who came to check
        that isolation holds, and silently saw no witness at all, could conclude
        the page was fine. An absent witness must announce itself.
      */}
      <div className="surface-card u-gap-2 u-p-4">
        <strong>{t('liveLabel')}</strong>
        {!list && !error ? (
          <Skeleton />
        ) : error ? (
          <StateCard announce icon={<PlugIcon />} title={t('witnessUnavailableTitle')} body={t('witnessListFailedBody')} />
        ) : !viewer ? (
          <StateCard icon={<PlugIcon />} title={t('witnessUnavailableTitle')} body={t('witnessNoViewerBody')} />
        ) : artifactError ? (
          <StateCard announce
            icon={<PlugIcon />}
            title={t('witnessUnavailableTitle')}
            body={`${t('witnessArtifactFailedBody')} ${artifactError}`}
          />
        ) : !artifactId ? (
          <Skeleton />
        ) : (
          <>
            <p className="muted">{viewer.tier === 'trusted' ? t('trustedLiveExplainer') : t('liveExplainer')}</p>
            {/* UPU-2 — a CARD-scoped boundary. These two components host third-party
                code, and a host-side render throw inside either one used to unwind to the
                page boundary and replace the WHOLE /ui-plugins page — including the
                isolation self-test, which is the surface an operator would use to judge
                whether the sandbox is working. The blast radius of a plugin failing
                should be the plugin's own card. `resetKey` on the plugin id so switching
                plugins clears a previous crash. */}
            <ErrorBoundary resetKey={viewer.pluginId} label={`ui-plugin viewer ${viewer.pluginId}`}>
              {viewer.tier === 'trusted' ? (
                <TrustedPluginHost
                  plugin={viewer}
                  loadingLabel={t('pluginLoading')}
                  errorLabel={t('pluginLoadFailed')}
                  regionLabel={t('liveLabel')}
                />
              ) : (
                <PluginFrame
                  plugin={viewer}
                  artifactId={artifactId}
                  title={t('liveLabel')}
                  loadingLabel={t('pluginLoading')}
                  errorLabel={t('pluginLoadFailed')}
                />
              )}
            </ErrorBoundary>
          </>
        )}
      </div>
    </div>
  );
}
