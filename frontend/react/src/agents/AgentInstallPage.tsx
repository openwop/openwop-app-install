/**
 * Install-from-registry browser — `/agents/install` (phase E3).
 *
 * Fetches `GET /v1/host/openwop-app/registry/agent-packs` (BE scans the
 * local packs/ directory for `core.openwop.agents.*`). Each row
 * shows the pack's name, version, description, the personas it
 * ships, and an "Install" button for packs that aren't yet
 * registered in the in-process AgentRegistry. Installed packs show
 * "Installed" with no action.
 *
 * Install posts to `POST /v1/host/openwop-app/registry/agent-packs/install`,
 * which invokes the existing `installPackFromRegistry` machinery
 * (signature verification, etc.). On success, the page refreshes
 * the list so the newly-installed pack flips to "Installed".
 *
 * Most agent packs auto-mount at boot via `mountLocalPacks.ts`, so
 * in the typical sample install the page is mostly "already
 * installed" rows — that's a honest reflection of the host's
 * state, not a UX bug.
 */

import { useCallback, useEffect, useState } from 'react';
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
import { PackageIcon } from '../ui/icons/index.js';

interface State {
  packs: readonly AgentPackSummary[];
  isLoading: boolean;
  error: string | null;
}

export function AgentInstallPage(): JSX.Element {
  const [state, setState] = useState<State>({ packs: [], isLoading: true, error: null });
  const [installingName, setInstallingName] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const packs = await listAvailableAgentPacks();
      setState({ packs, isLoading: false, error: null });
    } catch (err) {
      setState({
        packs: [],
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
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstallingName(null);
    }
  }

  return (
    <section>
      <div className="u-mb-3">
        <Link to="/agents" className="u-fs-12 u-ink-3">
          ← All agents
        </Link>
      </div>
      <PageHeader
        eyebrow="Agents"
        title="Install from registry"
        lede={`Agent packs available in this host's local registry mirror. Most auto-mount at boot — those rows show "Installed".`}
      />

      {state.isLoading && (
        <SkeletonRows rows={4} columns={['40%', '12%', '60%']} />
      )}
      {state.error && (
        <Notice variant="error">Couldn&apos;t load pack list: {state.error}</Notice>
      )}
      {installError && (
        <Notice variant="error">Install failed: {installError}</Notice>
      )}
      {!state.isLoading && !state.error && state.packs.length === 0 && (
        <StateCard
          icon={<PackageIcon size={28} />}
          title="No agent packs in the local registry"
          body={
            <>
              Configure <code>OPENWOP_REGISTRY_URL</code> + restart the host to
              fetch from the public registry.
            </>
          }
          action={
            <Link to="/agents" className="primary">
              Back to all agents
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
              onInstall={() => void onInstall(pack)}
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
  onInstall,
}: {
  pack: AgentPackSummary;
  isInstalling: boolean;
  onInstall: () => void;
}): JSX.Element {
  return (
    <li
      className="u-pad-3-4 u-border u-radius u-bg-surface u-flex u-items-start u-gap-3"
    >
      <div className="u-flex-1 u-minw-0">
        <div className="u-flex u-items-baseline u-gap-2-5 u-wrap u-mb-1">
          <code className="u-fs-13 u-fw-600">{pack.name}</code>
          <span className="muted agentinstall-version">v{pack.version}</span>
          {pack.installed && (
            <span className="agentinstall-installed-chip">
              installed
            </span>
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
              <span
                key={p}
                className="u-pad-2x8 u-radius-10 u-bg-surface-2 u-border u-fs-11 u-ink-2"
              >
                {p}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="u-shrink-0">
        {pack.installed ? (
          <span className="muted u-fs-12">—</span>
        ) : (
          <button
            type="button"
            onClick={onInstall}
            disabled={isInstalling}
            className="primary u-fs-12"
          >
            {isInstalling ? 'Installing…' : 'Install'}
          </button>
        )}
      </div>
    </li>
  );
}

