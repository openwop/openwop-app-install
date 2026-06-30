/**
 * `app-builder` namespace catalog (ADR 0065 / ADR 0153 Phase 2b) — strings for the
 * full-screen app-builder editor (`src/features/app-builder/`). The namespace is
 * derived from the path (`features/app-builder/i18n/en.ts` → `app-builder`).
 */
export const messages = {
  loading: 'Loading editor…',
  loadError: 'Could not load this canvas.',
  noOrg: 'No workspace available.',
  appName: 'App name',
  version: 'v{{n}}',
  unsaved: 'Unsaved',
  saving: 'Saving…',
  save: 'Save',
  saveError: 'Could not save. Please try again.',
  conflict: 'This canvas changed elsewhere — reload to get the latest version before saving.',
  palette: 'Components',
  container: 'container',
  screens: 'Screens',
  outline: 'Outline',
  properties: 'Properties',
  deleteComponent: 'Delete component',
  selectHint: 'Select a component in the outline to edit its properties.',
  home: 'Home',
};
