/**
 * The builder's key rules, shared by the page and the condition editor.
 *
 * A field saved without a typed key gets `slug(label)` (`FormDetailPage.save`).
 * The condition editor must offer and store THAT key — the one the field will
 * actually have on save — or a form whose keys are all "(auto)" could never be
 * made conditional (grade-ux FRM2UX-4).
 */
export const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);

/** The key a field will be saved under. */
export const effectiveKey = (f: { key: string; label: string }): string => f.key.trim() || slug(f.label);
