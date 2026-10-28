/**
 * ADR 0922 D3 — the `openwop.cms.page` destination adapter.
 *
 * Reads and writes go through the CMS service (the single owner of pages), never
 * its store. Field paths are `title` or `sections[<sectionId>].data.<key>`, keyed
 * by the CMS's stable `sec:<uuid>` section id (`cmsService.ts` `Section`), never
 * by array index.
 *
 * Correction to ADR 0922 D3, found while building this: an in-place edit of a
 * PUBLISHED page IS a publish of the new content (ADR 0836 D9 —
 * `assertNoPublishBlockers` runs on it), so there is no separate publish step.
 * One version-guarded `updatePage` is the whole write. Its authority is the
 * CMS's own: a non-draft page needs `host:members:manage` on the client org, the
 * rule the CMS routes apply (`features/cms/routes.ts` delete/PATCH).
 */
import { OpenwopError } from '../../../types.js';
import { assertOrgScope } from '../../../host/accessControlService.js';
import { getPage, updatePage, type Page } from '../../cms/cmsService.js';
import { contentHashOf } from '../contentHash.js';
import { assertCreativePublishable } from '../../../host/creativePublishGate.js';
import type { AssetLocator, AssetSnapshot, ConstrainedEdit, DestinationAdapter, WriteOutcome } from '../types.js';

/** The page id of a CMS locator; '' (reads as not found) for any other locator. */
const pageIdOf = (l: AssetLocator): string => ('pageId' in l ? l.pageId : '');

const SECTION_PATH = /^sections\[(sec:[A-Za-z0-9-]+)\]\.data\.([A-Za-z][A-Za-z0-9_]{0,63})$/;

/** Every text field of a page, by path. Non-string data values are not editable. */
export function pageFields(page: Pick<Page, 'title' | 'sections'>): Record<string, string> {
  const out: Record<string, string> = { title: page.title };
  for (const s of page.sections) {
    if (s.ref) continue; // a shared-section reference renders someone else's content
    for (const [k, v] of Object.entries(s.data ?? {})) {
      if (typeof v === 'string') out[`sections[${s.sectionId}].data.${k}`] = v;
    }
  }
  return out;
}

export function pageContentHash(page: Pick<Page, 'title' | 'slug' | 'sections'>): string {
  return contentHashOf({ title: page.title, slug: page.slug, sections: page.sections });
}

function snapshotOf(page: Page): AssetSnapshot {
  return { version: page.version, contentHash: pageContentHash(page), fields: pageFields(page), state: { status: page.status } };
}

/** Apply one edit to a value. Returns null when the edit no longer matches. */
export function applyEdit(current: string, edit: ConstrainedEdit): string | null {
  if ('before' in edit) return current === edit.before ? edit.after : null;
  if (edit.find.length === 0) return null;
  const first = current.indexOf(edit.find);
  if (first < 0 || current.indexOf(edit.find, first + 1) >= 0) return null; // must occur exactly once
  return current.slice(0, first) + edit.replace + current.slice(first + edit.find.length);
}

/** The page's title and sections with `edits` applied, or the refusal. Pure. */
export function applyEditsToPage(
  page: Pick<Page, 'title' | 'sections'>,
  edits: readonly ConstrainedEdit[],
  editableFields: readonly string[],
): { title: string; sections: Page['sections'] } | { refused: 'not_editable' | 'edit_mismatch'; field: string } {
  let title = page.title;
  const sections = page.sections.map((s) => ({ ...s, data: { ...s.data } }));
  for (const edit of edits) {
    if (!editableFields.includes(edit.field)) return { refused: 'not_editable', field: edit.field };
    if (edit.field === 'title') {
      const next = applyEdit(title, edit);
      if (next === null) return { refused: 'edit_mismatch', field: edit.field };
      title = next;
      continue;
    }
    const m = SECTION_PATH.exec(edit.field);
    const section = m ? sections.find((s) => s.sectionId === m[1] && !s.ref) : undefined;
    const cur = section && m ? section.data[m[2]] : undefined;
    if (!section || !m || typeof cur !== 'string') return { refused: 'edit_mismatch', field: edit.field };
    const next = applyEdit(cur, edit);
    if (next === null) return { refused: 'edit_mismatch', field: edit.field };
    section.data[m[2]] = next;
  }
  return { title, sections };
}

/** ADR 0923 D4 (as built) — the hash a change set targets and read-back compares:
 *  the asset's EDITABLE fields only, by path. A whole-page hash cannot be the
 *  target, because the CMS sanitizes sections and stamps digests on save; the
 *  whole-page hash stays the SOURCE identity (any human edit anywhere moves it). */
export function fieldsHash(fields: Readonly<Record<string, string>>, editableFields: readonly string[]): string {
  const projected: Record<string, string | null> = {};
  for (const f of [...editableFields].sort()) projected[f] = fields[f] ?? null;
  return contentHashOf(projected);
}

/** ADR 0945 D5 — a media reference an edit puts on the page runs the creative
 *  publish gate. CMS sections hold media under these keys: an image section's
 *  `token`, a hero's `imageToken`, and a video section's `src` / `poster`
 *  (URLs; a host serve URL resolves, anything else passes untouched). Only
 *  references the edit CHANGES are checked: content already live is not this
 *  write's to refuse. */
const MEDIA_FIELD = /\.data\.(token|imageToken|src|poster)$/;
async function gateNewMedia(tenantId: string, before: Record<string, string>, after: Record<string, string>): Promise<{ field: string; code: string } | null> {
  for (const [field, value] of Object.entries(after)) {
    if (!MEDIA_FIELD.test(field) || !value || before[field] === value) continue;
    const decision = await assertCreativePublishable({ tenantId, mediaRef: value, destination: 'openwop.cms.page' });
    if (!decision.ok) return { field, code: decision.code };
  }
  return null;
}

export const cmsPageAdapter: DestinationAdapter = {
  kind: 'openwop.cms.page',

  async read(asset, ctx) {
    const page = await getPage(ctx.tenantId, asset.orgId, pageIdOf(asset.locator));
    return page ? snapshotOf(page) : null;
  },

  async preview(asset, edits, ctx) {
    const page = await getPage(ctx.tenantId, asset.orgId, pageIdOf(asset.locator));
    if (!page) return { refused: 'asset_gone' as const };
    const applied = applyEditsToPage(page, edits, asset.editableFields);
    if ('refused' in applied) return { refused: applied.refused, field: applied.field };
    const after = pageFields({ title: applied.title, sections: applied.sections });
    const blocked = await gateNewMedia(ctx.tenantId, pageFields(page), after);
    if (blocked) return { refused: 'creative_blocked' as const, field: `${blocked.field} (${blocked.code})` };
    return {
      sourceVersion: page.version,
      sourceContentHash: pageContentHash(page),
      targetFieldsHash: fieldsHash(after, asset.editableFields),
      after,
      before: pageFields(page),
    };
  },

  async write(asset, edits, opts, ctx): Promise<WriteOutcome> {
    const page = await getPage(ctx.tenantId, asset.orgId, pageIdOf(asset.locator));
    if (!page) return { kind: 'refused', reason: 'asset_gone' };
    if (page.version !== opts.expectedVersion) return { kind: 'version_conflict', currentVersion: page.version };
    const applied = applyEditsToPage(page, edits, asset.editableFields);
    if ('refused' in applied) return { kind: 'refused', reason: applied.refused, detail: applied.field };
    // Re-checked at write time: a verdict can change between preview and execution.
    const blocked = await gateNewMedia(ctx.tenantId, pageFields(page), pageFields({ title: applied.title, sections: applied.sections }));
    if (blocked) return { kind: 'refused', reason: 'creative_blocked', detail: `${blocked.field}: ${blocked.code}` };
    try {
      const saved = await updatePage(
        ctx.tenantId, asset.orgId, pageIdOf(asset.locator),
        { title: applied.title, sections: applied.sections },
        ctx.actingUserId,
        {
          expectedVersion: opts.expectedVersion,
          // The CMS's own status-dependent authority, decided on the row the CAS swaps.
          authorize: async (current) => {
            await assertOrgScope(ctx.tenantId, ctx.actingUserId, asset.orgId, current.status === 'draft' ? 'workspace:write' : 'host:members:manage');
          },
        },
      );
      if (!saved) return { kind: 'refused', reason: 'asset_gone' };
      return { kind: 'written', version: saved.version };
    } catch (err) {
      if (err instanceof OpenwopError) {
        if (err.code === 'conflict') {
          const cur = (err.details as { currentVersion?: number } | undefined)?.currentVersion;
          return { kind: 'version_conflict', ...(typeof cur === 'number' ? { currentVersion: cur } : {}) };
        }
        if (err.code === 'forbidden_scope' || err.code === 'not_found') return { kind: 'refused', reason: 'not_authorized' };
        if ((err.details as { reason?: string } | undefined)?.reason === 'publish_blocked') {
          return { kind: 'refused', reason: 'publish_blocked', detail: err.message };
        }
      }
      throw err; // ambiguous: the caller (ADR 0925) records `unknown` and reconciles
    }
  },
};
