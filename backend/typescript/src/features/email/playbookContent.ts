/**
 * ADR 0959 D5 — email owns the `email.template` playbook content kind: a template a playbook
 * installs into a client org (the ADR 0905 store). An update writes a new template version,
 * which reopens send review exactly as an editor's change does (ADR 0905 D3).
 */
import { createHash } from 'node:crypto';
import { OpenwopError } from '../../types.js';
import { registerPlaybookContentAdapter, shallowFieldDiff } from '../../host/playbookContentAdapters.js';
import { createTemplate, getTemplate, updateTemplate, templateVersionOf, type EmailBodyFormat, type EmailTemplate } from './emailService.js';

const templateIdOf = (key: string): string => `pb-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
const FORMATS: readonly string[] = ['text', 'markdown'];
const snapshot = (t: EmailTemplate) => ({ value: { name: t.name, subject: t.subject, body: t.body, ...(t.format ? { format: t.format } : {}) }, revision: templateVersionOf(t) });

export function registerEmailPlaybookContent(): void {
  registerPlaybookContentAdapter({
    kind: 'email.template',
    label: 'Email template',
    parse(payload) {
      const p = (payload ?? {}) as { name?: unknown; subject?: unknown; body?: unknown; format?: unknown };
      const name = typeof p.name === 'string' ? p.name.trim() : '';
      const subject = typeof p.subject === 'string' ? p.subject : '';
      const body = typeof p.body === 'string' ? p.body : '';
      if (!name || !body) throw new OpenwopError('validation_error', 'An email template needs a name and a body.', 400, { field: 'content.payload' });
      if (p.format !== undefined && (typeof p.format !== 'string' || !FORMATS.includes(p.format))) throw new OpenwopError('validation_error', 'Unknown template format.', 400, { field: 'content.payload.format' });
      return { name, subject, body, ...(typeof p.format === 'string' ? { format: p.format } : {}) };
    },
    async read(ctx, resourceId) {
      const t = await getTemplate(ctx.tenantId, ctx.orgId, resourceId);
      return t ? snapshot(t) : null;
    },
    diff: shallowFieldDiff,
    async create(ctx, desired) {
      const id = templateIdOf(ctx.key);
      if (await getTemplate(ctx.tenantId, ctx.orgId, id)) throw new OpenwopError('conflict', 'This template already exists; its earlier outcome needs review.', 409, { reason: 'content_outcome_unconfirmed', resourceId: id });
      const t = await createTemplate({
        tenantId: ctx.tenantId, orgId: ctx.orgId, templateId: templateIdOf(ctx.key), createdBy: ctx.by,
        name: String(desired.name), subject: String(desired.subject ?? ''), body: String(desired.body),
        ...(desired.format ? { format: desired.format as EmailBodyFormat } : {}),
      });
      return { resourceId: t.templateId, snapshot: snapshot(t) };
    },
    async update(ctx, resourceId, desired, expected) {
      const t = await updateTemplate(ctx.tenantId, ctx.orgId, resourceId, {
        name: String(desired.name), subject: String(desired.subject ?? ''), body: String(desired.body),
        ...(desired.format ? { format: desired.format as EmailBodyFormat } : {}),
      }, { actor: ctx.by, expectedVersion: Number(expected.revision) });
      if (!t) throw new OpenwopError('not_found', 'Template not found.', 404, { templateId: resourceId });
      return snapshot(t);
    },
  });
}
