/**
 * Install-from-registry browser — `/agents/install` (phase E3).
 *
 * Fetches `GET /host/openwop-app/registry/agent-packs` (BE scans the
 * local packs/ directory for `core.openwop.agents.*`). Each row
 * shows the pack's name, version, description, the personas it
 * ships, and an "Install" button for packs that aren't yet
 * registered in the in-process AgentRegistry. Installed packs show
 * "Installed" with no action.
 *
 * Install posts to `POST /host/openwop-app/registry/agent-packs/install`,
 * which invokes the existing `installPackFromRegistry` machinery
 * (signature verification, etc.). On success, the page refreshes
 * the list so the newly-installed pack flips to "Installed".
 *
 * Most agent packs auto-mount at boot via `mountLocalPacks.ts`, so
 * in the typical sample install the page is mostly "already
 * installed" rows — that's a honest reflection of the host's
 * state, not a UX bug.
 */

import { Button } from '../ui/Button.js';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Link } from 'react-router-dom';
import {
  listAvailableAgentPacks,
  installAgentPack,
  type AgentPackSummary,
} from '../client/agentsClient.js';
import { PageHeader } from '../ui/PageHeader.js';
import { StateCard } from '../ui/StateCard.js';
import { Notice } from '../ui/Notice.js';
import { SkeletonRows } from '../ui/Skeleton.js';
import { PackageIcon, ArrowLeftIcon } from '../ui/icons/index.js';

interface State {
  packs: readonly AgentPackSummary[];
  /** AG-G1 — server-computed: may THIS caller install? Fails closed. */
  canInstall: boolean;
  isLoading: boolean;
  error: string | null;
}

export function AgentInstallPage(): JSX.Element {
  const { t } = useTranslation('agents');
  const [state, setState] = useState<State>({ packs: [], canInstall: false, isLoading: true, error: null });
  const [installingName, setInstallingName] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  // AG-G2 — installing used to be silent on success: the row simply flipped
  // somewhere in a long list. Announce the outcome.
  const [announce, setAnnounce] = useState('');

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const { packs, canInstall } = await listAvailableAgentPacks();
      setState({ packs, canInstall, isLoading: false, error: null });
    } catch (err) {
      setState({
        packs: [],
        canInstall: false,
        isLoading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function onInstall(pack: AgentPackSummary): Promise<void> {
    setInstallingName(pack.name);
    setInstallError(null);
    try {
      await installAgentPack(pack.name, pack.version);
      await refresh();
      setAnnounce(t('installSucceeded', { name: pack.name }));
    } catch (err) {
      // AG-G5 — a 403 here is the one outcome a person can act on; anything
      // else keeps its message but is framed rather than dumped raw.
      const msg = err instanceof Error ? err.message : String(err);
      setInstallError(/403|forbidden|superadmin/i.test(msg) ? t('installForbidden') : msg);
    } finally {
      setInstallingName(null);
    }
  }

  return (
    <section data-walkthrough="agents-install.page">
      <div className="u-mb-3">
        <Link to="/agents" className="u-fs-12 u-ink-3">
          <ArrowLeftIcon size={12} /> {t('installBack')}
        </Link>
      </div>
      <PageHeader
        eyebrow={t('installEyebrow')}
        title={t('installTitle')}
        lede={t('installLede')}
      />

      {state.isLoading && (
        <SkeletonRows rows={4} columns={['40%', '12%', '60%']} />
      )}
      {state.error && (
        <Notice variant="error">{t('installLoadError', { error: state.error })}</Notice>
      )}
      {installError && (
        <Notice variant="error">{installError}</Notice>
      )}
      {/* AG-G1 — installing a host-global pack hot-reloads code into the running
          host, so the route is superadmin-only. Say that ONCE, up front, instead
          of offering every row an action that can only ever 403. */}
      {!state.isLoading && !state.error && !state.canInstall && state.packs.length > 0 && (
        <Notice variant="info">{t('installOperatorOnly')}</Notice>
      )}
      <span aria-live="polite" className="sr-only">{announce}</span>
      {!state.isLoading && !state.error && state.packs.length === 0 && (
        <StateCard
          icon={<PackageIcon size={28} />}
          title={t('installNoneTitle')}
          body={
            <>
              {t('installNoneBody')}
            </>
          }
          action={
            <Link to="/agents" className="btn">
              {t('installBackToAll')}
            </Link>
          }
        />
      )}

      {state.packs.length > 0 && (
        <ul className="u-list-none u-m-0 u-p-0 u-flex u-flex-col u-gap-2">
          {state.packs.map((pack) => (
            <PackRow
              key={pack.name}
              pack={pack}
              isInstalling={installingName === pack.name}
              canInstall={state.canInstall}
              onInstall={() => void onInstall(pack)}
              t={t}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function PackRow({
  pack,
  isInstalling,
  canInstall,
  onInstall,
  t,
}: {
  pack: AgentPackSummary;
  isInstalling: boolean;
  canInstall: boolean;
  onInstall: () => void;
  t: TFunction;
}): JSX.Element {
  return (
    // AG-G3 — on the `ui/` cohesion layer (`surface-card`, `chip`) like every
    // sibling screen. This row was an ad-hoc utility stack (`u-pad-3-4 u-border
    // u-radius u-bg-surface`, hand-rolled chips), which is exactly the drift
    // DESIGN.md's shared primitives exist to prevent.
    <li className="surface-card u-p-3 u-flex u-items-start u-gap-3">
      <div className="u-flex-1 u-minw-0">
        <div className="u-flex u-items-baseline u-gap-2-5 u-wrap u-mb-1">
          <code className="u-fs-13 u-fw-600">{pack.name}</code>
          <span className="muted agentinstall-version">v{pack.version}</span>
          {pack.installed && (
            <span className="chip chip--success">{t('installInstalled')}</span>
          )}
        </div>
        {pack.description && (
          <p className="muted agentinstall-desc">
            {pack.description}
          </p>
        )}
        {pack.personas.length > 0 && (
          <div className="u-flex u-wrap u-gap-1">
            {pack.personas.map((p) => (
              <span key={p} className="chip chip--muted">{p}</span>
            ))}
          </div>
        )}
      </div>
      <div className="u-shrink-0">
        {/* AG-G4 — an installed row used to render a muted em-dash where an
            action would be, which reads as a broken control. The state is
            already stated by the chip, so the action slot is simply empty. */}
        {pack.installed || !canInstall ? null : (
          <Button
            onClick={onInstall}
            disabled={isInstalling}
            variant="primary" className="u-fs-12"
          >
            {isInstalling ? t('installInstalling') : t('installInstall')}
          </Button>
        )}
      </div>
    </li>
  );
}

