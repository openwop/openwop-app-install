/**
 * ADR 0748 — a `fields` section's limits, mirrored from the backend so the editor
 * refuses what the server would (the server re-validates regardless). A test pins
 * both values to `backend/typescript/src/features/cms/cmsService.ts`
 * (`FIELDS_KEY_RE`, `MAX.fieldKeys`) — ADR 0755, WIT-CNT-12.
 */
export const FIELD_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
export const FIELDS_MAX_KEYS = 40;
