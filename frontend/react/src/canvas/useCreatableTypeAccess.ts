/**
 * The ONE per-toggle access map for first-party creatable canvas types
 * (architect review of #1609/#1611): the creation gallery and the documents
 * list both gate on this hook, so the literal exists ONCE. Hooks must stay
 * static (a fixed call count per render), which is why this is a literal map
 * and not a loop over CREATABLE_CANVAS_TYPES — the creatableGating tripwire
 * test pins THIS file against the registry so a new type fails loudly here.
 */
import { useFeatureAccess } from '../featureToggles/FeatureAccessContext.js';

export function useCreatableTypeAccess(): Record<string, { enabled: boolean }> {
  return {
    slides: useFeatureAccess('slides'),
    drawings: useFeatureAccess('drawings'),
    cad: useFeatureAccess('cad'),
    'campaign-studio': useFeatureAccess('campaign-studio'),
    'app-builder': useFeatureAccess('app-builder'),
    'document-editor': useFeatureAccess('document-editor'),
  };
}
