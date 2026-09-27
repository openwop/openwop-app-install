/**
 * Plugin health tile (ADR 0377 Wave 4) — served UI plugins by trust tier
 * (ADR 0367: 'trusted' = pinned-key verified RIGHT NOW; else community/sandbox)
 * over the EXISTING ui-plugins client. Admin-tier ops tile; MyndHyve
 * PluginHealthWidget parity. Owns no data (ADR 0082).
 */
import { useTranslation } from 'react-i18next';
import { listPlugins, type PluginList } from '../../ui-plugins/pluginClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { formatNumber } from '../../../i18n/format.js';
import { useTileData } from '../useTileData.js';
import { TileStats } from '../TileStats.js';
import type { DashboardTileProps } from '../tileTypes.js';

export default function PluginHealthTile(_props: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const { status, data } = useTileData<PluginList>(() => listPlugins(), []);

  if (status === 'loading') return <SkeletonRows rows={2} columns={['30%', '30%', '30%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;
  const plugins = data?.plugins ?? [];
  if (plugins.length === 0) return <p className="dash-tile__state muted">{t('pluginsEmpty')}</p>;

  const trusted = plugins.filter((p) => p.tier === 'trusted').length;
  return (
    <TileStats
      stats={[
        { label: t('pluginsServed'), value: formatNumber(plugins.length) },
        { label: t('pluginsTrusted'), value: formatNumber(trusted) },
        { label: t('pluginsCommunity'), value: formatNumber(plugins.length - trusted) },
      ]}
    />
  );
}
