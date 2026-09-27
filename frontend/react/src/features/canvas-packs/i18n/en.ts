/**
 * `canvas-packs` namespace catalog (ADR 0310 Phase D) — GENERIC type-contract strings for pack-declared canvas types (which carry their collection/adder labels as pack data); chassis strings live in the `canvas` namespace.
 */
export const messages = {
  editorHeading: 'Canvas editor',
  docName: 'Name',
  deleteDoc: 'Delete canvas',
  deleteDocTitle: 'Delete "{{name}}"?',
  deleteDocBody: 'The canvas working copy and its version history are permanently removed. The chat artifact it was opened from is not affected. This cannot be undone.',
  deleteDocDone: 'Canvas deleted.',
  deleteDocFailed: 'Could not delete this canvas.',
  previewFrameTitle: 'Canvas preview plugin',
  typeUnavailable: "This canvas type is not available in this workspace — its pack may not be installed, or the feature may be off.",
  retry: "Try again",
};
