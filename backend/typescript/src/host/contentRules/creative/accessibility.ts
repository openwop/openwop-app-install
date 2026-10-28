/**
 * ADR 0946 D5 — `accessibility`: alt text, text contrast (WCAG 2.x), minimum
 * text size and video captions. A fact the producer did not supply is
 * reported, never assumed fine.
 */
import { channelSpec } from '../channelSpecs.js';
import { toFinding, type ContentFinding, type FindingAction, type FindingSeverity } from '../findings.js';
import type { CreativeMemberInput } from './types.js';

const PLACEHOLDER_ALT = new Set(['image', 'photo', 'picture', 'img', 'alt', 'placeholder', 'untitled', 'graphic', 'banner', 'logo']);
export const MIN_TEXT_PX = 12;

const finding = (m: CreativeMemberInput, ruleId: string, field: string, action: FindingAction, severity: FindingSeverity, message: string, recommendation?: string): ContentFinding =>
  toFinding({ ruleSet: 'accessibility', ruleId, severity, action, assetId: m.memberId, field, introduced: true, message, ...(recommendation ? { recommendation } : {}) });

function channel(hex: string): number[] | null {
  const h = hex.trim().replace(/^#/, '');
  const full = /^[0-9a-f]{3}$/i.test(h) ? h.split('').map((c) => c + c).join('') : h;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
}

function luminance(hex: string): number | null {
  const c = channel(hex);
  if (!c) return null;
  const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, or null when a colour is not a hex value. */
export function contrastRatio(fg: string, bg: string): number | null {
  const a = luminance(fg);
  const b = luminance(bg);
  if (a === null || b === null) return null;
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function checkAccessibility(m: CreativeMemberInput): ContentFinding[] {
  const out: ContentFinding[] = [];
  if (m.kind === 'image' && m.media) {
    const alt = (m.media.altText ?? '').trim();
    const decorative = m.media.altTextSource === 'decorative';
    const placeholder = PLACEHOLDER_ALT.has(alt.toLowerCase()) || /\.(png|jpe?g|gif|webp|svg)$/i.test(alt) || (alt.length > 0 && alt.length < 3);
    if (!decorative && (alt.length === 0 || placeholder)) {
      out.push(finding(m, alt.length === 0 ? 'accessibility.alt_missing' : 'accessibility.alt_placeholder', 'altText', 'block', 'high',
        alt.length === 0 ? 'The image has no alt text.' : `"${alt}" is a placeholder, not alt text.`, 'Describe what the image shows, or mark it decorative.'));
    }
  }
  for (const layer of m.render?.textLayers ?? []) {
    if (layer.sizePx < MIN_TEXT_PX) {
      out.push(finding(m, 'accessibility.text_size', `layer.${layer.layerId}`, 'needs_review', 'medium', `Text in ${layer.layerId} is ${layer.sizePx}px; below ${MIN_TEXT_PX}px it is hard to read.`));
    }
    if (layer.bg === null) {
      out.push(finding(m, 'accessibility.contrast_unmeasured', `layer.${layer.layerId}`, 'info', 'low', `Text in ${layer.layerId} sits on an image, so its contrast was not computed.`));
      continue;
    }
    const ratio = contrastRatio(layer.fg, layer.bg);
    const large = layer.sizePx >= 24 || (layer.sizePx >= 18.66 && (layer.weight ?? 400) >= 700);
    const needed = large ? 3 : 4.5;
    if (ratio === null) {
      out.push(finding(m, 'accessibility.contrast_unmeasured', `layer.${layer.layerId}`, 'needs_review', 'medium', `The colours in ${layer.layerId} are not hex values, so contrast could not be checked.`));
    } else if (ratio < needed) {
      out.push(finding(m, 'accessibility.contrast', `layer.${layer.layerId}`, 'block', 'high', `Text contrast in ${layer.layerId} is ${ratio.toFixed(2)}:1; it needs ${needed}:1.`));
    }
  }
  if (m.kind === 'video' && m.media) {
    const required = (() => {
      const g = channelSpec(m.channel)?.spec?.captionGuidance;
      return typeof g === 'object' && g !== null && (g as { requiredForAccessibility?: unknown }).requiredForAccessibility === true;
    })();
    if (m.media.hasCaptions === false) {
      out.push(finding(m, 'accessibility.captions_missing', 'media', required ? 'block' : 'needs_review', 'high', 'The video has no captions.', 'Add burned-in or sidecar captions.'));
    } else if (m.media.hasCaptions === undefined) {
      out.push(finding(m, 'accessibility.captions_unverified', 'media', 'needs_review', 'medium', 'Captions on this video were not verified.'));
    }
  }
  return out;
}
