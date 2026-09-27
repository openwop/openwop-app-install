/**
 * Dashboard layout client (ADR 0375) — the caller's own per-workspace layout
 * intent over the Phase-1 self-scoped routes. The (tenant, subject) key is
 * derived server-side from the session, never sent by the client.
 */
import { requestJson } from '../../client/requestJson.js';
import type { TileSize } from './tileTypes.js';

export interface TileLayout {
  id: string;
  order: number;
  size: TileSize;
  enabled: boolean;
}
export interface DashboardLayout {
  tenantId: string;
  subject: string;
  tiles: TileLayout[];
  updatedAt: string;
}

const LAYOUT = '/host/openwop-app/dashboard/layout';

/** The caller's saved layout, or null when they have none yet (⇒ derive
 *  defaults from the registry — zero-write first paint). */
export async function getLayout(signal?: AbortSignal): Promise<DashboardLayout | null> {
  const out = await requestJson<{ layout: DashboardLayout | null }>(LAYOUT, { method: 'GET', ...(signal ? { signal } : {}) });
  return out.layout;
}

/** Upsert the caller's layout. */
export async function putLayout(tiles: TileLayout[]): Promise<DashboardLayout> {
  const out = await requestJson<{ layout: DashboardLayout }>(LAYOUT, { method: 'PUT', json: { tiles } });
  return out.layout;
}

// ── Personal note (ADR 0377 deferral closed 2026-07-16) ──────────────────────
export interface DashboardNote {
  text: string;
  updatedAt: string;
}

const NOTE = '/host/openwop-app/dashboard/note';

export async function getNote(): Promise<DashboardNote | null> {
  const out = await requestJson<{ note: DashboardNote | null }>(NOTE, { method: 'GET' });
  return out.note;
}

export async function putNote(text: string): Promise<DashboardNote> {
  const out = await requestJson<{ note: DashboardNote }>(NOTE, { method: 'PUT', json: { text } });
  return out.note;
}

// ── AI briefing tile config (ADR 0577) — a conversation POINTER, same
//    self-scoped row model as the note. ─────────────────────────────────────
export interface DashboardBriefingConfig {
  conversationId: string;
  updatedAt: string;
}

const BRIEFING = '/host/openwop-app/dashboard/briefing';

export async function getBriefingConfig(): Promise<DashboardBriefingConfig | null> {
  const out = await requestJson<{ config: DashboardBriefingConfig | null }>(BRIEFING, { method: 'GET' });
  return out.config;
}

export async function putBriefingConfig(conversationId: string): Promise<DashboardBriefingConfig> {
  const out = await requestJson<{ config: DashboardBriefingConfig }>(BRIEFING, { method: 'PUT', json: { conversationId } });
  return out.config;
}
