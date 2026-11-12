/**
 * ADR 1091 — project health providers. A feature that holds a project's real
 * records (a schedule, approvals, orders, a white-label adopter's domain) says
 * what they mean for the project's health. The charter's `health` stays the
 * person's own value and the override; a provider never writes it.
 *
 * Same shape as `chatSubjectContextProviders`: idempotent by id, run in
 * registration order, a failing provider is logged and skipped. The first
 * provider with a reading wins. A provider applies its own toggle and access,
 * and returns nothing for a project it does not know.
 */

import { createLogger } from '../observability/logger.js';
import type { Project } from '../features/projects/projectsService.js';

const log = createLogger('host.projectHealthProviders');

export type ComputedHealthLevel = 'on-track' | 'at-risk' | 'off-track';
export interface ComputedProjectHealth {
  level: ComputedHealthLevel;
  /** One sentence a person can act on. */
  reason: string;
  /** Who computed it, for people: the providing feature's name. */
  source: string;
  /** The day the reading is for (YYYY-MM-DD). */
  asOf: string;
}
export interface ProjectHealthRequest { tenantId: string; project: Project; callerUserId?: string }
export type ProjectHealthProvider = (req: ProjectHealthRequest) => Promise<ComputedProjectHealth | undefined>;

const LEVELS: readonly string[] = ['on-track', 'at-risk', 'off-track'];
const MAX_REASON = 500;
/** A provider gets this long per call; the project read never waits on a hung one. */
export const PROVIDER_TIMEOUT_MS = 2000;
const providers: Array<{ id: string; fn: ProjectHealthProvider }> = [];

export function registerProjectHealthProvider(id: string, fn: ProjectHealthProvider): void {
  if (providers.some((p) => p.id === id)) return;
  providers.push({ id, fn });
}

/** Test seam. */
export function __resetProjectHealthProviders(): void { providers.length = 0; }

function valid(h: unknown): h is ComputedProjectHealth {
  if (!h || typeof h !== 'object') return false;
  const x = h as Record<string, unknown>;
  return typeof x.level === 'string' && LEVELS.includes(x.level)
    && typeof x.reason === 'string' && x.reason.trim().length > 0
    && typeof x.source === 'string' && x.source.trim().length > 0
    && typeof x.asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.asOf);
}

/** The first provider's reading for this project, and the providers that failed. */
export async function resolveComputedProjectHealth(req: ProjectHealthRequest): Promise<{ computed?: ComputedProjectHealth & { providerId: string }; failed: string[] }> {
  const failed: string[] = [];
  for (const p of providers) {
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${PROVIDER_TIMEOUT_MS} ms`)), PROVIDER_TIMEOUT_MS); });
      const h = await Promise.race([p.fn(req), timeout]).finally(() => clearTimeout(timer));
      if (h === undefined) continue;
      if (!valid(h)) { log.warn('project_health_provider_invalid', { providerId: p.id, projectId: req.project.id }); failed.push(p.id); continue; }
      return { computed: { level: h.level, reason: h.reason.trim().slice(0, MAX_REASON), source: h.source.trim(), asOf: h.asOf, providerId: p.id }, failed };
    } catch (err) {
      log.warn('project_health_provider_failed', { providerId: p.id, projectId: req.project.id, error: err instanceof Error ? err.message : String(err) });
      failed.push(p.id);
    }
  }
  return { failed };
}
