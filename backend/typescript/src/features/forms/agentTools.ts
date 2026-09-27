/**
 * Forms chat tools (CFP-1 repair; ADR 0308 D2 seam) — the read grounding for the
 * Forms Lead Insights agent. The agent pack formerly allowlisted the workflow
 * node typeIds `feature.forms.nodes.list-forms` / `list-submissions`, which
 * nothing projects into a conversational tool — so the agent loaded with zero
 * resolvable tools (the CFP-1 bug: `resolveAgentTools` silently drops entries
 * outside `builtinAgentToolIds()`). These `registerFeatureAgentTool` tools make
 * the same reads real, over the same `formsService` the routes + surface use.
 *
 * Authority parity (hard rule #1): both tools resolve org scope through the same
 * `listOrgs` + `resolveEffectiveAccess('workspace:read')` predicate the forms
 * routes enforce via `authorizeOrgScope`. Read posture (the goals-tool
 * precedent): FAIL EMPTY — no acting user, feature off, or no accessible org ⇒
 * an empty result (annotated), never a probe.
 */

import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { resolveReadOrgScope, str, toolEmpty, toolOk } from '../../host/agentToolKit.js';
import { listForms, getForm, listSubmissions } from './formsService.js';

export const FORMS_LIST_FORMS_TOOL_ID = 'openwop:forms.list-forms';
export const FORMS_LIST_SUBMISSIONS_TOOL_ID = 'openwop:forms.list-submissions';

// Project out internal columns exactly as the `ctx.features.forms` surface does.
const FORM_INTERNAL = new Set(['tenantId', 'createdBy']);
const SUB_INTERNAL = new Set(['tenantId', 'orgId']);
function project(o: object, drop: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!drop.has(k)) out[k] = v;
  return out;
}

/** Per-call toggle + org-scope honesty (ADR 0308 D2 / CFPT-1), via the shared
 *  read gate: fail-EMPTY, subject-shaped toggle read (CFPT-1b). */
const resolveReadOrg = (scope: Parameters<typeof resolveReadOrgScope>[0], orgIdInput?: string) =>
  resolveReadOrgScope(scope, { featureId: 'forms', featureLabel: 'Forms' }, orgIdInput);

export function registerFormsAgentTools(): void {
  registerFeatureAgentTool({
    // RFC 0137 §F1 — this result carries content the host did not author:
    // pack-authored labels/titles/options from a form-content template, AND
    // values submitted through a PUBLIC unauthenticated page. Both are
    // attacker-controlled.
    //
    // Note the values arm does NOT depend on `originTemplate`: a value
    // submitted through a HAND-AUTHORED form is exactly as attacker-controlled
    // as one collected through a template. RFC 0137 phrases the obligation
    // around templates because an RFC can only legislate its own kind — not
    // because hand-authored submissions are safe.
    contentTrust: 'untrusted',
    def: {
      name: FORMS_LIST_FORMS_TOOL_ID,
      description:
        "List an organization's forms (id, title, field definitions) so you can pick the form to analyze. "
        + 'Read-only; grounded in the workspace\'s own Forms data.',
      inputSchema: {
        type: 'object',
        properties: { orgId: { type: 'string', description: 'Organization id (optional when the workspace has one org).' } },
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const r = await resolveReadOrg(scope, str(input.orgId));
      if (r.kind === 'empty') return toolEmpty({ forms: [], note: r.note });
      if (r.kind === 'error') return r.result;
      const forms = await listForms(scope.tenantId, r.orgId);
      return toolOk({ forms: forms.map((f) => project(f, FORM_INTERNAL)) });
    },
  });

  registerFeatureAgentTool({
    // RFC 0137 §F1 — this result carries content the host did not author:
    // pack-authored labels/titles/options from a form-content template, AND
    // values submitted through a PUBLIC unauthenticated page. Both are
    // attacker-controlled.
    //
    // Note the values arm does NOT depend on `originTemplate`: a value
    // submitted through a HAND-AUTHORED form is exactly as attacker-controlled
    // as one collected through a template. RFC 0137 phrases the obligation
    // around templates because an RFC can only legislate its own kind — not
    // because hand-authored submissions are safe.
    contentTrust: 'untrusted',
    def: {
      name: FORMS_LIST_SUBMISSIONS_TOOL_ID,
      description:
        "List a form's captured submissions (values + timestamps) to summarize lead volume and common answers. "
        + 'Read-only. Requires a `formId` (from list-forms).',
      inputSchema: {
        type: 'object',
        properties: {
          formId: { type: 'string', description: 'The form whose submissions to read.' },
          orgId: { type: 'string', description: 'Organization id (optional when the workspace has one org).' },
        },
        required: ['formId'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const r = await resolveReadOrg(scope, str(input.orgId));
      if (r.kind === 'empty') return toolEmpty({ submissions: [], note: r.note });
      if (r.kind === 'error') return r.result;
      const formId = str(input.formId);
      if (!formId) return toolEmpty({ submissions: [], note: '`formId` is required.' });
      // getForm enforces tenant+org; an absent/cross-tenant form ⇒ empty (no probe).
      const form = await getForm(scope.tenantId, r.orgId, formId);
      if (!form) return toolEmpty({ submissions: [], note: 'Form not found in this organization.' });
      const submissions = await listSubmissions(scope.tenantId, r.orgId, formId);
      return toolOk({ formTitle: form.title, submissions: submissions.map((s) => project(s, SUB_INTERNAL)) });
    },
  });
}
