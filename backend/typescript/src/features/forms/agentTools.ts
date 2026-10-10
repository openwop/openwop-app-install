/**
 * Forms chat tools (CFP-1 repair; ADR 0308 D2 seam) — the read grounding for the
 * Forms Lead Insights agent. The agent pack formerly allowlisted the workflow
 * node typeIds `feature.forms.nodes.list-forms` / `list-submissions`, which
 * nothing projects into a conversational tool — so the agent loaded with zero
 * resolvable tools (the CFP-1 bug: `resolveAgentTools` silently drops entries
 * outside `builtinAgentToolIds()`). These `registerFeatureAgentTool` tools make
 * the same reads real, over the same `formsService` the routes + surface use.
 *
 * Authority (hard rule #1): both tools resolve org scope through the shared
 * `resolveReadOrgScope` (`listOrgs` + `resolveEffectiveAccess('workspace:read')`).
 * CORRECTED (ADR 0850 D8 / FRMWF-9): this used to say it is "the same predicate
 * the forms routes enforce via `authorizeOrgScope`". It is not: the route's
 * `assertOrgScope` has a personal-owner short-circuit this helper lacks. The
 * drift is fail-CLOSED (the tool is the stricter of the two), so a personal
 * workspace owner can be told "no read access" by chat while the route serves —
 * a parity gap, not an escalation. Read posture (the goals-tool precedent): FAIL
 * EMPTY — no acting user, feature off, or no accessible org ⇒ an empty result
 * (annotated), never a probe.
 */

import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { resolveReadOrgScope, str, toolEmpty, toolOk } from '../../host/agentToolKit.js';
import { listForms, getForm, listSubmissions } from './formsService.js';

export const FORMS_LIST_FORMS_TOOL_ID = 'openwop:forms.list-forms';
export const FORMS_LIST_SUBMISSIONS_TOOL_ID = 'openwop:forms.list-submissions';

// Project out internal columns exactly as the `ctx.features.forms` surface does.
const FORM_INTERNAL = new Set(['tenantId', 'createdBy']);
// ADR 0850 — `releasedBy` is an operator id and `removing` an internal claim;
// neither is a fact about the lead (grade-code FRM2CD-11).
const SUB_INTERNAL = new Set(['tenantId', 'orgId', 'releasedBy', 'removing']);
/** ADR 0850 D6 — the read is a bounded page, never the whole log (up to 50 000
 *  rows) into the model's context. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
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
    effect: 'read',
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
    effect: 'read',
    def: {
      name: FORMS_LIST_SUBMISSIONS_TOOL_ID,
      description:
        "List a form's captured submissions (values + timestamps), newest first, to summarize lead volume and common answers. "
        + 'Read-only. Requires a `formId` (from list-forms). Returns a page: `total` is the true count and `truncated` says whether you saw all of it. '
        + 'Held (quarantined, probable-spam) submissions are excluded unless `includeHeld` is true.',
      inputSchema: {
        type: 'object',
        properties: {
          formId: { type: 'string', description: 'The form whose submissions to read.' },
          orgId: { type: 'string', description: 'Organization id (optional when the workspace has one org).' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `How many of the newest submissions to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
          includeHeld: { type: 'boolean', description: 'Also return held (quarantined) submissions. Default false: they are probable spam and were delivered nowhere.' },
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
      const all = await listSubmissions(scope.tenantId, r.orgId, formId); // newest first
      const heldCount = all.filter((s) => s.flagged).length;
      const pool = input.includeHeld === true ? all : all.filter((s) => !s.flagged);
      const rawLimit = typeof input.limit === 'number' && Number.isInteger(input.limit) ? input.limit : DEFAULT_LIMIT;
      const limit = Math.min(MAX_LIMIT, Math.max(1, rawLimit));
      const page = pool.slice(0, limit);
      const truncated = pool.length > page.length;
      return toolOk({
        formTitle: form.title,
        total: pool.length,
        heldCount,
        truncated,
        // ADR 0850 D6 — said in words too, so a summary of a partial read is not
        // reported as the whole ("total submissions" is the prompt's first ask).
        ...(truncated ? { note: `Showing the newest ${page.length} of ${pool.length} submissions; \`total\` is the true count.` } : {}),
        submissions: page.map((s) => project(s, SUB_INTERNAL)),
      });
    },
  });
}
