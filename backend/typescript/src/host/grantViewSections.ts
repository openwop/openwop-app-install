/**
 * ADR 1099 D10 (P4) — sections a feature adds to what a collaborator sees on a
 * granted resource (the client portal page). A section is READ-ONLY: answers still
 * go through the propose tools (D6), held for the firm's review.
 *
 * The host's half of the contract:
 *  - the scope comes from the grant only (`clientScopeOf`, the same builder the
 *    turn lane's client tools use). `read` takes the scope and nothing else, so no
 *    request field can reach it;
 *  - every read and every list passes the one per-use check (`checkGrantUse`,
 *    action `view`) and the kind's switch, or answers the uniform 404 (the route);
 *  - the output is a JSON object of at most 64 KB. A least view is closed to
 *    `{ available: false, message, code? }`;
 *  - a reader's own typed 4xx refusal passes its code and message; anything else
 *    is 502 (reason `section_unavailable`), with no internals, and is logged
 *    (`collab_section_read_failed`: ids and the error only) for the operator;
 *  - an optional `enabledFor(tenantId)` hides a section the firm switched off. Over 64 KB is 502
 *    (reason `section_too_large`).
 *
 * The feature's half, which the host cannot check: `read` must answer from the
 * scope's audience (absent ⇒ the least view) and must never return another
 * party's rows. A builder's grant must never receive a client's rows.
 * Sections store nothing, so erasure is unaffected.
 */
import { OpenwopError } from '../types.js';
import type { ClientToolScope } from './clientProjectTools.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.grantViewSections');

export interface GrantViewSection {
  /** The grant resource kind this section serves (e.g. `project`). */
  kind: string;
  /** Stable id, prefixed by the feature id: `<featureId>.<name>` (e.g. `casavoga.due`). */
  id: string;
  featureId: string;
  /** Ascending; ties break by id. */
  order: number;
  read: (scope: ClientToolScope) => Promise<unknown>;
  /** Optional: whether the section exists for this tenant (e.g. the owning
   *  feature's toggle). Off ⇒ absent from the list and 404 on a read, so a feature
   *  the firm switched off leaves no empty card. A fault counts as off. */
  enabledFor?: (tenantId: string) => boolean | Promise<boolean>;
}

export const SECTION_MAX_BYTES = 64 * 1024;
const SLUG = '[a-z0-9][a-z0-9-]*';
const FEATURE_RE = new RegExp(`^${SLUG}(\\.${SLUG})*$`);
const CODE_RE = /^[a-z0-9_.-]{1,64}$/;
const LEAST_VIEW_MESSAGE_MAX = 500;

const sections = new Map<string, GrantViewSection>();
const keyOf = (kind: string, id: string): string => `${kind}\u0000${id}`;

export function registerGrantViewSection(section: GrantViewSection): void {
  if (!section.kind || !/^[a-z0-9-]+$/.test(section.kind)) throw new Error(`grantViewSections: invalid kind '${section.kind}'`);
  if (!FEATURE_RE.test(section.featureId)) throw new Error(`grantViewSections: invalid featureId '${section.featureId}'`);
  const name = section.id.startsWith(`${section.featureId}.`) ? section.id.slice(section.featureId.length + 1) : '';
  if (!new RegExp(`^${SLUG}$`).test(name) || section.id.length > 96) {
    throw new Error(`grantViewSections: id '${section.id}' must be '${section.featureId}.<name>'`);
  }
  if (!Number.isFinite(section.order)) throw new Error(`grantViewSections: '${section.id}' needs a finite order`);
  if (typeof section.read !== 'function') throw new Error(`grantViewSections: '${section.id}' needs read()`);
  const key = keyOf(section.kind, section.id);
  if (sections.has(key)) throw new Error(`grantViewSections: '${section.id}' is already registered for '${section.kind}'`);
  sections.set(key, section);
}

/** Whether a section is on for a tenant (`enabledFor`; absent ⇒ on; a fault ⇒ off). */
export async function sectionEnabledFor(section: GrantViewSection, tenantId: string): Promise<boolean> {
  if (!section.enabledFor) return true;
  try {
    return (await section.enabledFor(tenantId)) === true;
  } catch (err) {
    log.warn('collab_section_enabled_check_failed', { kind: section.kind, section: section.id, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/** The sections of a kind that are on for the tenant, ids and order only, in display order. */
export async function grantViewSectionsFor(kind: string, tenantId: string): Promise<Array<{ id: string; order: number }>> {
  const of = [...sections.values()]
    .filter((s) => s.kind === kind)
    .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const on = await Promise.all(of.map((s) => sectionEnabledFor(s, tenantId)));
  return of.filter((_, i) => on[i]).map(({ id, order }) => ({ id, order }));
}

/** A kind's section by id, only while it is on for the tenant. */
export async function grantViewSection(kind: string, id: string, tenantId: string): Promise<GrantViewSection | undefined> {
  const section = sections.get(keyOf(kind, id));
  return section && (await sectionEnabledFor(section, tenantId)) ? section : undefined;
}

const unavailable = (): OpenwopError =>
  new OpenwopError('internal_error', 'This section could not be read right now.', 502, { reason: 'section_unavailable' });

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Run a section's reader on a scope the caller built from a checked grant, and
 * close its output. The caller (the route) has already run the per-use check.
 */
export async function readGrantViewSection(section: GrantViewSection, scope: ClientToolScope): Promise<Record<string, unknown>> {
  let out: unknown;
  try {
    out = await section.read(scope);
  } catch (err) {
    if (err instanceof OpenwopError && err.httpStatus >= 400 && err.httpStatus < 500) {
      // Its code and sentence only; any other detail the reader attached stays here.
      const raw = typeof err.details?.code === 'string' ? err.details.code : err.code;
      const reason = CODE_RE.test(raw) ? raw : 'refused';
      throw new OpenwopError(err.code, err.message.slice(0, LEAST_VIEW_MESSAGE_MAX), err.httpStatus, { reason });
    }
    // A broken reader must be visible to the operator: ids and the error only,
    // never the scope's people.
    log.warn('collab_section_read_failed', { kind: section.kind, section: section.id, error: err instanceof Error ? err.message : String(err) });
    throw unavailable();
  }
  if (!isPlainObject(out)) {
    log.warn('collab_section_read_failed', { kind: section.kind, section: section.id, error: 'not a JSON object' });
    throw unavailable();
  }
  if (out.available === false) {
    // The least view is closed: nothing else a reader puts beside it is sent.
    const message = typeof out.message === 'string' ? out.message.slice(0, LEAST_VIEW_MESSAGE_MAX) : '';
    const code = typeof out.code === 'string' && CODE_RE.test(out.code) ? out.code : undefined;
    return { available: false, message, ...(code ? { code } : {}) };
  }
  let bytes: number;
  try { bytes = Buffer.byteLength(JSON.stringify(out), 'utf8'); } catch (err) {
    log.warn('collab_section_read_failed', { kind: section.kind, section: section.id, error: err instanceof Error ? err.message : String(err) });
    throw unavailable();
  }
  if (bytes > SECTION_MAX_BYTES) {
    log.warn('collab_section_too_large', { kind: section.kind, section: section.id, bytes });
    throw new OpenwopError('internal_error', 'This section is too large to show.', 502, { reason: 'section_too_large' });
  }
  return out;
}
