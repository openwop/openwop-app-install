/**
 * Dashboard layout persistence (ADR 0375, Phase 1).
 *
 * The editable dashboard OWNS layout intent + the grid UI; it owns NO tile DATA
 * (every tile is a compact projection over an existing feature client — ADR 0082,
 * no parallel store). This service persists ONE thing: a user's per-workspace
 * layout intent — which tiles are enabled, their order, their size.
 *
 * Keyed `${tenantId}:${subject}` (workspace × user, ADR 0015): available tiles
 * depend on the workspace's enabled features AND the user's role in THAT
 * workspace, so the layout is per-(user, workspace), never per-user-global.
 * A point lookup (`get`), never a `list()` scan — one row per user.
 *
 * The server validates SHAPE ONLY and stays deliberately IGNORANT of the tile
 * registry (which is frontend-side): it persists the user's raw intent, and the
 * FE computes the EFFECTIVE list (registry ∩ toggle-on ∩ role ∩ enabled). A
 * stored id no longer in the registry is inert on the FE — no migration.
 */

import { DurableCollection } from '../../host/hostExtPersistence.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';

export type TileSize = 'half' | 'full';

/** One tile's persisted layout intent (NOT its definition — that's the FE registry). */
export interface DashboardTileLayout {
  id: string;
  order: number;
  size: TileSize;
  enabled: boolean;
}

export interface DashboardLayout {
  tenantId: string;
  /** The acting user's opaque subject (session-derived, never request input). */
  subject: string;
  tiles: DashboardTileLayout[];
  updatedAt: string;
}

/** Upper bound on stored tiles — far above any realistic registry size; a cap so
 *  a malformed/oversized PUT can't bloat a row. */
export const MAX_TILES = 100;

const layouts = new DurableCollection<DashboardLayout>('dashboardlayout', (l) => `${l.tenantId}:${l.subject}`);

/** The caller's layout, or null when they have none yet (⇒ the FE derives
 *  defaults from the current registry — zero-write first paint). */
export async function getLayout(tenantId: string, subject: string): Promise<DashboardLayout | null> {
  return layouts.get(`${tenantId}:${subject}`);
}

/** Upsert the caller's layout (last-writer-wins is correct for a self-owned
 *  single row — a race is between the user's own tabs). Returns the stored row. */
export async function putLayout(tenantId: string, subject: string, tiles: DashboardTileLayout[], now: string = new Date().toISOString()): Promise<DashboardLayout> {
  const row: DashboardLayout = { tenantId, subject, tiles, updatedAt: now };
  await layouts.put(row);
  return row;
}

// ── Personal note (ADR 0377 Wave-3 deferral closed 2026-07-16) ────────────────
// The personal-note tile's ONE piece of owned content. A SEPARATE subject-scoped
// row — deliberately NOT a field on the layout rows: a tile writing the shared
// layout row-set would race DashboardPage's debounced whole-set PUT
// (last-writer-wins clobber). Same key scheme as the layout (workspace × user).

export interface DashboardNote {
  tenantId: string;
  subject: string;
  text: string;
  updatedAt: string;
}

/** Hard cap on note length — a sticky note, not a document store. */
export const MAX_NOTE_CHARS = 4000;

const notes = new DurableCollection<DashboardNote>('dashboardnote', (n) => `${n.tenantId}:${n.subject}`);

export async function getNote(tenantId: string, subject: string): Promise<DashboardNote | null> {
  return (await notes.get(`${tenantId}:${subject}`)) ?? null;
}

export async function putNote(tenantId: string, subject: string, text: string): Promise<DashboardNote> {
  const note: DashboardNote = { tenantId, subject, text, updatedAt: new Date().toISOString() };
  await notes.put(note);
  return note;
}

// ── AI briefing tile config (ADR 0577) ───────────────────────────────────────
// The tile projects a scheduled agent chat; its ONLY config is WHICH
// conversation — a pointer, never content (the tile renders through the chat
// clients; no parallel store, the ADR 0082 rule the layout docblock states).
// Same self-scoped `${tenantId}:${subject}` key + point-lookup contract as the
// note row.
export interface DashboardBriefingConfig {
  tenantId: string;
  subject: string;
  conversationId: string;
  updatedAt: string;
}

const briefings = new DurableCollection<DashboardBriefingConfig>('dashboardbriefing', (b) => `${b.tenantId}:${b.subject}`);

export async function getBriefingConfig(tenantId: string, subject: string): Promise<DashboardBriefingConfig | null> {
  return (await briefings.get(`${tenantId}:${subject}`)) ?? null;
}

export async function putBriefingConfig(tenantId: string, subject: string, conversationId: string): Promise<DashboardBriefingConfig> {
  const row: DashboardBriefingConfig = { tenantId, subject, conversationId, updatedAt: new Date().toISOString() };
  await briefings.put(row);
  return row;
}

// ── GDPR subject erasure (grade-data HOME-D1, 2026-07-16) ────────────────────
// All dashboard rows are subject-keyed, and the personal note is the subject's
// own CONTENT — a DSAR erasure must reach them. Same seam + semantics as the
// comments eraser (DSAR subjectKey = the opaque userId): deterministic point
// deletes, no scan. Idempotent (deleting absent rows is a no-op).
export async function eraseDashboardSubject(tenantId: string, subjectKey: string): Promise<void> {
  if (!subjectKey) return; // fail-closed on a falsy subject
  await layouts.delete(`${tenantId}:${subjectKey}`);
  await notes.delete(`${tenantId}:${subjectKey}`);
  await briefings.delete(`${tenantId}:${subjectKey}`);
}
registerSubjectEraser(async function eraseDashboard(tenantId, subjectKey) { await eraseDashboardSubject(tenantId, subjectKey); });
