/**
 * ADR 0768 follow-up D2 — what the model that will ACTUALLY answer can read.
 *
 * The composer's image/PDF warning used the conversation's DEFAULT model
 * (`config.model`) while the turn is sent with the per-message override from the
 * model switcher (`selectedModel`, useComposerModifiers). Picking a vision model
 * left a stale "can't read this image" warning; picking a non-vision one hid a
 * warning that applied. One helper, fed the effective model, for both shells.
 *
 * No "switch to a vision model" offer: MEASURED 2026-09-30, every provider in
 * providers.json is all-vision (anthropic, openai, google) or no-vision (minimax,
 * openwop-free), so a same-provider alternative never exists, and a cross-provider
 * one needs a second BYOK key — its own decision, not a composer touch.
 */
import { resolveActiveModel } from '../../byok/lib/providers.js';
import type { ModelChoice } from '../ModelSwitcher.js';

export interface AttachmentCaps {
  supportsImageInput: boolean;
  supportsPdfInput: boolean;
}

export function attachmentCaps(provider: string, defaultModel: string, override?: ModelChoice | null): AttachmentCaps {
  const prov = override?.provider || provider;
  const modelId = override?.model ?? defaultModel;
  const m = resolveActiveModel(prov, modelId);
  const supportsImageInput = m?.capabilities?.includes('vision') === true;
  const supportsPdfInput = supportsImageInput && (prov === 'anthropic' || prov === 'google');
  return { supportsImageInput, supportsPdfInput };
}
