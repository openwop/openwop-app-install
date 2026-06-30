/**
 * canvas.campaign inline renderer (ADR 0153 Phase 3). Renders a structured marketing
 * campaign — the `canvas.campaign` artifact payload — inline in the chat artifact
 * workbench: channels, the funnel, and content assets. Read-only; every value is
 * React-escaped text (no untrusted HTML, no code). Registered as canvas.campaign.
 */

import { useTranslation } from 'react-i18next';
import { Notice } from '../../ui/index.js';
import type { ArtifactRendererProps } from './rendererRegistry.js';

interface Channel { name: string; type: string; tactic?: string; budget?: number }
interface Stage { stage: string; description?: string; kpis?: string[] }
interface Asset { channel?: string; format?: string; headline?: string; body?: string; cta?: string }
interface Campaign { name: string; objective?: string; audience?: string; channels: Channel[]; funnel?: Stage[]; assets?: Asset[] }

function parseCampaign(content: string): Campaign | null {
  let raw: unknown;
  try { raw = JSON.parse(content); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.name !== 'string' || !Array.isArray(o.channels) || o.channels.length === 0) return null;
  return raw as Campaign;
}

export function CampaignPreview({ content }: ArtifactRendererProps): JSX.Element {
  const { t } = useTranslation('chat');
  const c = parseCampaign(content);
  if (!c) return <Notice variant="error">{t('campaignInvalid')}</Notice>;
  return (
    <div className="canvas-campaign">
      <div className="canvas-campaign__head">
        <h3 className="canvas-campaign__name">{c.name}</h3>
        {c.objective ? <p className="canvas-campaign__objective">{c.objective}</p> : null}
        {c.audience ? <p className="canvas-campaign__audience"><span className="canvas-campaign__label">{t('campaignAudience')}</span> {c.audience}</p> : null}
      </div>

      <section className="canvas-campaign__section" aria-label={t('campaignChannels')}>
        <h4 className="canvas-campaign__section-title">{t('campaignChannels')}</h4>
        <ul className="canvas-campaign__channels">
          {c.channels.map((ch, i) => (
            <li key={i} className="canvas-campaign__channel">
              <div className="canvas-campaign__channel-head">
                <span className="canvas-campaign__channel-name">{ch.name}</span>
                <span className="chip chip--muted canvas-campaign__channel-type">{ch.type}</span>
                {typeof ch.budget === 'number' ? <span className="canvas-campaign__budget">{t('campaignBudget')} {ch.budget}</span> : null}
              </div>
              {ch.tactic ? <p className="canvas-campaign__tactic">{ch.tactic}</p> : null}
            </li>
          ))}
        </ul>
      </section>

      {c.funnel && c.funnel.length ? (
        <section className="canvas-campaign__section" aria-label={t('campaignFunnel')}>
          <h4 className="canvas-campaign__section-title">{t('campaignFunnel')}</h4>
          <ol className="canvas-campaign__funnel">
            {c.funnel.map((s, i) => (
              <li key={i} className="canvas-campaign__stage">
                <span className="chip chip--accent canvas-campaign__stage-name">{s.stage}</span>
                {s.description ? <span className="canvas-campaign__stage-desc">{s.description}</span> : null}
                {s.kpis && s.kpis.length ? <span className="canvas-campaign__kpis">{s.kpis.join(' · ')}</span> : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {c.assets && c.assets.length ? (
        <section className="canvas-campaign__section" aria-label={t('campaignAssets')}>
          <h4 className="canvas-campaign__section-title">{t('campaignAssets')}</h4>
          <ul className="canvas-campaign__assets">
            {c.assets.map((a, i) => (
              <li key={i} className="canvas-campaign__asset">
                <div className="canvas-campaign__asset-meta">
                  {a.channel ? <span className="chip chip--muted">{a.channel}</span> : null}
                  {a.format ? <span className="canvas-campaign__asset-format">{a.format}</span> : null}
                </div>
                {a.headline ? <p className="canvas-campaign__asset-headline">{a.headline}</p> : null}
                {a.body ? <p className="canvas-campaign__asset-body">{a.body}</p> : null}
                {a.cta ? <span className="canvas-campaign__cta">{a.cta}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
