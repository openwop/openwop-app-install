/**
 * ADR 0946 D5 — `channel-policy`: a member against its row of the ONE channel
 * spec table (D3). Text is judged by the SOURCE of each limit:
 * - over an official `hardMax` → block (the platform refuses or cuts it);
 * - over a `recommended` length → info (legal, may be cut off in display);
 * - over the unsourced legacy value, with no sourced limit → needs_review
 *   (nobody has confirmed the platform's limit; a person checks);
 * - an empty required field → block.
 * Media, format and CTA findings are block: they come from the platform's
 * own spec facets.
 */
import { channelSpec, type ChannelSpecRow } from '../channelSpecs.js';
import { toFinding, type ContentFinding, type FindingDraft } from '../findings.js';
import type { CreativeMemberInput, MediaFacts } from './types.js';

const block = (m: CreativeMemberInput, ruleId: string, field: string, message: string, extra: Partial<FindingDraft> = {}): ContentFinding =>
  toFinding({ ruleSet: 'channel-policy', ruleId, severity: 'high', action: 'block', assetId: m.memberId, field, introduced: true, message, ...extra });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `image/jpeg` → `jpg`, `video/quicktime` → `mov`. */
function formatOf(contentType: string): string {
  const sub = contentType.split('/')[1]?.split(';')[0]?.trim().toLowerCase() ?? '';
  return ({ jpeg: 'jpg', quicktime: 'mov', 'x-m4v': 'mp4' } as Record<string, string>)[sub] ?? sub;
}

function ratios(facet: Record<string, unknown>): number[] {
  return Array.isArray(facet.aspectRatios)
    ? facet.aspectRatios.filter((a): a is { width: number; height: number } => isObj(a) && typeof a.width === 'number' && typeof a.height === 'number').map((a) => a.width / a.height)
    : [];
}

function checkMedia(m: CreativeMemberInput, row: ChannelSpecRow, media: MediaFacts): ContentFinding[] {
  const out: ContentFinding[] = [];
  const type = m.kind === 'video' ? 'video' : 'image';
  if (row.sizes) {
    if (media.width !== undefined && media.height !== undefined && !row.sizes.some((z) => z.width === media.width && z.height === media.height)) {
      out.push(block(m, 'channel-policy.size', 'media', `${media.width}×${media.height} is not one of ${row.channelSpecId}'s sizes.`));
    }
    return out;
  }
  const spec = row.spec;
  if (!spec) return out;
  if (!spec.supportedTypes.includes(type)) {
    out.push(block(m, 'channel-policy.media_type', 'media', `${row.channelSpecId} does not take ${type}.`));
    return out;
  }
  const facet = spec[type === 'video' ? 'videoSpec' : 'imageSpec'];
  if (!isObj(facet)) return out;
  const fmt = formatOf(media.contentType);
  if (Array.isArray(facet.formats) && facet.formats.length > 0 && !facet.formats.includes(fmt)) {
    out.push(block(m, 'channel-policy.format', 'media', `${row.channelSpecId} takes ${facet.formats.join(', ')}, not ${fmt}.`));
  }
  if (media.width !== undefined && media.height !== undefined) {
    const want = ratios(facet);
    const got = media.width / media.height;
    if (want.length > 0 && !want.some((r) => Math.abs(r - got) / r <= 0.01)) {
      out.push(block(m, 'channel-policy.aspect_ratio', 'media', `${media.width}×${media.height} matches none of ${row.channelSpecId}'s aspect ratios.`));
    }
    if ((typeof facet.minWidth === 'number' && media.width < facet.minWidth) || (typeof facet.minHeight === 'number' && media.height < facet.minHeight)) {
      out.push(block(m, 'channel-policy.min_size', 'media', `${media.width}×${media.height} is below ${row.channelSpecId}'s minimum of ${String(facet.minWidth)}×${String(facet.minHeight)}.`));
    }
  }
  if (media.sizeBytes !== undefined && typeof facet.maxFileSize === 'number' && media.sizeBytes > facet.maxFileSize) {
    out.push(block(m, 'channel-policy.file_size', 'media', `${media.sizeBytes} bytes is over ${row.channelSpecId}'s ${facet.maxFileSize}-byte cap.`));
  }
  if (type === 'video' && media.durationSec !== undefined) {
    if ((typeof facet.minDuration === 'number' && media.durationSec < facet.minDuration) || (typeof facet.maxDuration === 'number' && media.durationSec > facet.maxDuration)) {
      out.push(block(m, 'channel-policy.duration', 'media', `${media.durationSec}s is outside ${row.channelSpecId}'s ${String(facet.minDuration)}–${String(facet.maxDuration)}s.`));
    }
  }
  return out;
}

export function checkChannelPolicy(m: CreativeMemberInput): ContentFinding[] {
  const row = channelSpec(m.channel);
  if (!row) return [block(m, 'channel-policy.unknown_channel', 'channel', `"${m.channel}" is not in the channel spec table.`)];
  const out: ContentFinding[] = [];
  if (m.copy && row.text) {
    for (const [field, text] of Object.entries(m.copy)) {
      const limit = row.text[field];
      if (!limit) continue;
      const len = text.length;
      const overflow = (at: number): FindingDraft['span'] => ({ start: at, end: len, text: text.slice(at) });
      if (limit.hardMax !== undefined && len > limit.hardMax) {
        out.push(block(m, 'channel-policy.text_max', field, `${field} is ${len} characters; ${row.channelSpecId} allows ${limit.hardMax}.`, { span: overflow(limit.hardMax) }));
      } else if (limit.hardMax === undefined && limit.source.type === 'unsourced' && len > limit.legacyMax) {
        out.push(toFinding({ ruleSet: 'channel-policy', ruleId: 'channel-policy.text_unverified', severity: 'medium', action: 'needs_review', assetId: m.memberId, field, introduced: true, span: overflow(limit.legacyMax),
          message: `${field} is ${len} characters, over the unverified ${limit.legacyMax} on record for ${row.channelSpecId}; the platform's limit is not confirmed.` }));
      } else if (limit.recommended !== undefined && len > limit.recommended) {
        out.push(toFinding({ ruleSet: 'channel-policy', ruleId: 'channel-policy.text_recommended', severity: 'low', action: 'info', assetId: m.memberId, field, introduced: true, span: overflow(limit.recommended),
          message: `${field} is ${len} characters; ${limit.recommended} or fewer shows without being cut off on ${row.channelSpecId}.` }));
      }
      if (limit.min !== undefined && limit.min > 0 && text.trim().length === 0) out.push(block(m, 'channel-policy.text_min', field, `${field} is empty.`));
    }
    const cta = m.copy.ctaText ?? m.copy.cta;
    const ctaOptions = row.spec?.ctaOptions;
    if (cta !== undefined && isObj(ctaOptions) && ctaOptions.customAllowed === false && Array.isArray(ctaOptions.presets) && !ctaOptions.presets.includes(cta)) {
      out.push(block(m, 'channel-policy.cta_preset', 'ctaText', `"${cta}" is not one of ${row.channelSpecId}'s call-to-action buttons.`, { recommendation: `Use one of: ${ctaOptions.presets.join(', ')}.` }));
    }
  }
  if ((m.kind === 'image' || m.kind === 'video') && m.media) out.push(...checkMedia(m, row, m.media));
  return out;
}
