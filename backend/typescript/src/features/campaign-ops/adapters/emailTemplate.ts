/**
 * ADR 0922 D5 — the `openwop.email.template` destination adapter (F11 v1).
 *
 * F11's "versioned email draft" IS an ADR 0905 template version; campaign ops adds
 * no draft store and never sends (sending stays with ADR 0905). Reads and writes go
 * through the email service, never its store:
 *  - read: `getTemplate` in THIS client org (another org's template reads as none),
 *    version and source hash through `templateVersionOf` / `templateContentHash`,
 *    because legacy rows carry neither field;
 *  - write: `updateTemplate(…, {expectedVersion, actor})`; 0905's `version_conflict`
 *    maps through. An edit to the content of a template under send review returns
 *    that campaign to draft, which is 0905's rule and is right here.
 *
 * Editable fields are `subject` and `body` (what 0905's content hash covers with
 * `format`). The name is not delivered content and is not editable here.
 *
 * Authority is the email routes' own: `workspace:write` on the client org.
 *
 * Sent email is never changed: the template-scoped precheck reports existing
 * sends, and updateTemplate's `refuseIfSent` checks the send hold in the SAME
 * template CAS as the edit. A send winning after the precheck makes the edit
 * refuse `email_already_sent`; an edit winning first is what an unapproved send
 * subsequently pins. Approvals still require their exact approved version.
 */
import { OpenwopError } from '../../../types.js';
import { assertOrgScope } from '../../../host/accessControlService.js';
import { resolveOne } from '../../../host/featureToggles/service.js';
import {
  getCampaign,
  getTemplate,
  campaignsUsingTemplate,
  templateContentHash,
  templateVersionOf,
  updateTemplate,
  type EmailTemplate,
} from '../../email/emailService.js';
import type { AssetLocator, AssetSnapshot, ConstrainedEdit, DestinationAdapter, WriteOutcome, WriteRefusal } from '../types.js';
import { applyEdit, fieldsHash } from './cmsPage.js';

export const EMAIL_EDITABLE_FIELDS = ['subject', 'body'] as const;
type EmailField = (typeof EMAIL_EDITABLE_FIELDS)[number];

const templateIdOf = (l: AssetLocator): string => ('templateId' in l ? l.templateId : '');
const campaignIdsOf = (l: AssetLocator): string[] => ('templateId' in l ? l.campaignIds ?? [] : []);

export function templateFields(t: Pick<EmailTemplate, 'subject' | 'body'>): Record<EmailField, string> {
  return { subject: t.subject, body: t.body };
}

function snapshotOf(t: EmailTemplate): AssetSnapshot {
  return { version: templateVersionOf(t), contentHash: templateContentHash(t), fields: templateFields(t), state: { status: 'draft' } };
}

/** The template's subject and body with `edits` applied, or the refusal. Pure. */
export function applyEditsToTemplate(
  t: Pick<EmailTemplate, 'subject' | 'body'>,
  edits: readonly ConstrainedEdit[],
  editableFields: readonly string[],
): Record<EmailField, string> | { refused: 'not_editable' | 'edit_mismatch'; field: string } {
  const out = templateFields(t);
  for (const edit of edits) {
    if (!editableFields.includes(edit.field) || !(EMAIL_EDITABLE_FIELDS as readonly string[]).includes(edit.field)) {
      return { refused: 'not_editable', field: edit.field };
    }
    const f = edit.field as EmailField;
    const next = applyEdit(out[f], edit);
    if (next === null) return { refused: 'edit_mismatch', field: edit.field };
    out[f] = next;
  }
  return out;
}

async function emailEnabled(tenantId: string, userId?: string): Promise<boolean> {
  const a = await resolveOne('email', { tenantId, ...(userId ? { userId } : {}) }).catch(() => null);
  return !!a?.enabled;
}

/** ADR 0922 D5 — true when any campaign naming or referencing the template is sending or sent. */
async function alreadySent(tenantId: string, orgId: string, templateId: string, named: readonly string[]): Promise<boolean> {
  const sent = (s: string): boolean => s === 'sending' || s === 'sent';
  for (const id of named) {
    const c = await getCampaign(tenantId, orgId, id);
    if (c && c.templateId === templateId && sent(c.status)) return true;
  }
  return (await campaignsUsingTemplate(tenantId, orgId, templateId)).some((c) => sent(c.status));
}

const refused = (reason: WriteRefusal, detail?: string): WriteOutcome => ({ kind: 'refused', reason, ...(detail ? { detail } : {}) });

export const emailTemplateAdapter: DestinationAdapter = {
  kind: 'openwop.email.template',

  async read(asset, ctx) {
    const t = await getTemplate(ctx.tenantId, asset.orgId, templateIdOf(asset.locator));
    return t ? snapshotOf(t) : null;
  },

  async preview(asset, edits, ctx) {
    if (!(await emailEnabled(ctx.tenantId))) return { refused: 'destination_unavailable' as const };
    const t = await getTemplate(ctx.tenantId, asset.orgId, templateIdOf(asset.locator));
    if (!t) return { refused: 'asset_gone' as const };
    const applied = applyEditsToTemplate(t, edits, asset.editableFields);
    if ('refused' in applied) return { refused: applied.refused, field: applied.field };
    return {
      sourceVersion: templateVersionOf(t),
      sourceContentHash: templateContentHash(t),
      targetFieldsHash: fieldsHash(applied, asset.editableFields),
      before: templateFields(t),
      after: applied,
    };
  },

  async write(asset, edits, opts, ctx): Promise<WriteOutcome> {
    if (!(await emailEnabled(ctx.tenantId, ctx.actingUserId))) return refused('destination_unavailable');
    const templateId = templateIdOf(asset.locator);
    const t = await getTemplate(ctx.tenantId, asset.orgId, templateId);
    if (!t) return refused('asset_gone');
    if (templateVersionOf(t) !== opts.expectedVersion) return { kind: 'version_conflict', currentVersion: templateVersionOf(t) };
    try {
      await assertOrgScope(ctx.tenantId, ctx.actingUserId, asset.orgId, 'workspace:write');
    } catch {
      return refused('not_authorized');
    }
    if (await alreadySent(ctx.tenantId, asset.orgId, templateId, campaignIdsOf(asset.locator))) {
      return refused('email_already_sent', 'Sending has started for this template; create a new draft to edit it.');
    }
    const applied = applyEditsToTemplate(t, edits, asset.editableFields);
    if ('refused' in applied) return refused(applied.refused, applied.field);
    try {
      const saved = await updateTemplate(ctx.tenantId, asset.orgId, templateId, applied, { expectedVersion: opts.expectedVersion, actor: ctx.actingUserId, refuseIfSent: true });
      if (!saved) return refused('asset_gone');
      return { kind: 'written', version: templateVersionOf(saved) };
    } catch (err) {
      if (err instanceof OpenwopError && err.code === 'conflict') {
        const d = err.details as { reason?: string; currentVersion?: number } | undefined;
        if (d?.reason === 'version_conflict') return { kind: 'version_conflict', ...(typeof d.currentVersion === 'number' ? { currentVersion: d.currentVersion } : {}) };
        if (d?.reason === 'template_sent') return refused('email_already_sent', 'Sending has started for this template; create a new draft to edit it.');
      }
      throw err; // ambiguous: the caller (ADR 0925) records `unknown` and reconciles
    }
  },
};
