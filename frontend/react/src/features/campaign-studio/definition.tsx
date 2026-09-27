/**
 * The campaign-studio CanvasTypeDefinition (ADR 0310 Phase C) — the elements
 * trait's MULTI-COLLECTION consumer: a `canvas.campaign` document holds THREE
 * parallel element collections (channels / funnel / assets) plus doc-level
 * strategy fields (objective, audience). Properties-driven editing; the ONE
 * campaign renderer (`CampaignContentView`) is mounted by the editor preview.
 * Campaign-orchestration remains a separate subsystem (research doc §5.5).
 */
import type { CanvasEditorDefinition } from '../../canvas/CanvasEditorPage.js';
import type { CanvasNode, CanvasPropDef } from '../../canvas/types.js';
import type { FrameBase } from '../../canvas/frameOps.js';
import { RequiredEnumWidget } from '../../canvas/widgets.js';
import { CampaignContentView } from '../../chat/artifacts/CampaignPreview.js';
import { campaignGraph } from './campaignGraph.js';

export interface CampaignDoc {
  name: string;
  objective?: string;
  audience?: string;
  channels: Record<string, unknown>[];
  funnel?: Record<string, unknown>[];
  assets?: Record<string, unknown>[];
}

const arr = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === 'object' && !Array.isArray(s)) : [];

/** Narrow the canvas state into the editable campaign (safe fallbacks; a
 *  campaign always has at least one channel — the schema's minItems). */
export function coerceCampaign(state: Record<string, unknown>): CampaignDoc {
  const channels = arr(state.channels);
  const funnel = arr(state.funnel);
  const assets = arr(state.assets);
  return {
    name: typeof state.name === 'string' && state.name ? state.name : 'Untitled campaign',
    ...(typeof state.objective === 'string' ? { objective: state.objective } : {}),
    ...(typeof state.audience === 'string' ? { audience: state.audience } : {}),
    // R2 CS-SP-9 — the starter channel belongs to a FRESH doc only (the key is
    // ABSENT, as in coerceDoc({})). Any PRESENT value that coerces to nothing —
    // empty array, non-array, array of garbage — must render empty, not get a
    // fabricated 'New channel · email' that the next Save persists as real data.
    channels: channels.length ? channels
      : state.channels == null ? [{ name: 'New channel', type: 'email' }]
        : [],
    ...(funnel.length ? { funnel } : {}),
    ...(assets.length ? { assets } : {}),
  };
}

const str = (name: string, label: string): CanvasPropDef => ({ name, type: 'string', label });
const long = (name: string, label: string): CanvasPropDef => ({ name, type: 'longtext', label });

const trunc = (v: unknown): string => (typeof v === 'string' && v ? (v.length > 32 ? `${v.slice(0, 32)}…` : v) : '');

export const campaignStudioDefinition: CanvasEditorDefinition<CampaignDoc, FrameBase, CanvasNode> = {
  canvasTypeId: 'canvas.campaign',
  touchSupport: 'view',
  toggleId: 'campaign-studio',
  clientBasePath: '/host/openwop-app/campaign-studio',
  editorPath: '/campaign-studio',
  i18nNamespace: 'campaign-studio',
  Renderer: CampaignContentView,
  coerceDoc: coerceCampaign,
  // ADR 0359 Phase 5 — collab via the chassis element binding (mirrors the
  // backend registerCanvasEditorRoutes `collab: true` registration).
  collab: 'elements',
  docNameKey: 'name',
  // ADR 0360 — the funnel board (graph trait; stored x/y, order-derived chain).
  graph: campaignGraph,
  elements: [
    {
      key: 'channels',
      max: 40,
      min: 1,
      adders: [{ id: 'channel', make: () => ({ name: 'New channel', type: 'email' }) }],
      labelFor: (el, tr) => trunc(el.name) || tr('add_channel'),
      propDefs: () => [
        { ...str('name', 'Channel name'), required: true },
        { name: 'type', type: 'enum-required', label: 'Type', options: ['email', 'social', 'search', 'display', 'content', 'sms', 'events', 'pr'], required: true },
        str('tactic', 'Tactic'),
        { name: 'budget', type: 'number', label: 'Budget', min: 0 },
      ],
    },
    {
      key: 'funnel',
      max: 12,
      adders: [{ id: 'stage', make: () => ({ stage: 'awareness' }) }],
      labelFor: (el, tr) => (typeof el.stage === 'string' && el.stage ? tr(`stage_${el.stage}`) : tr('add_stage')),
      propDefs: () => [
        { name: 'stage', type: 'enum-required', label: 'Stage', options: ['awareness', 'consideration', 'conversion', 'retention', 'advocacy'], required: true, quick: true },
        long('description', 'Description'),
        { name: 'kpis', type: 'stringlist', label: 'KPIs (one per line)' },
      ],
    },
    {
      key: 'assets',
      max: 60,
      adders: [{ id: 'asset', make: () => ({ headline: 'New asset' }) }],
      labelFor: (el, tr) => trunc(el.headline) || trunc(el.format) || trunc(el.channel) || tr('add_asset'),
      propDefs: () => [
        str('channel', 'Channel'),
        str('format', 'Format'),
        str('headline', 'Headline'),
        long('body', 'Body'),
        str('cta', 'Call to action'),
      ],
    },
  ],
  docPropDefs: [long('objective', 'Objective'), long('audience', 'Audience')],
  propertyWidgets: { 'enum-required': RequiredEnumWidget },
};
