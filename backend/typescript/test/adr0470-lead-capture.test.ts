/**
 * ADR 0470 P1 — anonymous lead capture: the FIRST non-deliverable anon write tool.
 *
 * The keystone proof: the ADR 0469 anon write tier now lands a REAL mutation (a CRM
 * Contact) — not a read-as-write stand-in — genuinely closing §N3. Plus the tool's
 * anon-exclusivity (authenticated turns go to the ADR 0208 governed write), the
 * no-authority closed schema, the no-PII-echo result boundary, email validation, and
 * the operator-facing lead summary in the review projection.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { runAnonReadTurn } from '../src/host/anonymousActor.js';
import { createScopedAgentToolProvider } from '../src/host/agentToolProvider.js';
import { registerCrmAgentTools, CRM_LEAD_CAPTURE_TOOL_ID } from '../src/features/crm/agentTools.js';
import { findContactByEmail } from '../src/features/crm/contactsService.js';
import { approvalToReview } from '../src/host/reviewProjection.js';
import type { PendingApproval } from '../src/host/approvalService.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { crmFeature } from '../src/features/crm/feature.js';
import type { AiToolCallRequest, AiToolCallResult } from '../src/executor/types.js';

const AGENT = { agentId: 'a-lead', persona: 'Concierge', systemPrompt: 'You capture leads.' };
const TENANT = 'lead-tenant';

function scriptedProvider(calls: { id: string; name: string; input: Record<string, unknown> }[], captured: { round2: AiToolCallRequest['messages'] }): (r: AiToolCallRequest) => Promise<AiToolCallResult> {
  let round = 0;
  return async (r) => { round += 1; if (round === 1) return { content: '', toolCalls: calls }; captured.round2 = r.messages; return { content: 'done', toolCalls: [] }; };
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  initHostExtPersistence(await openStorage('memory://'));
  registerCrmAgentTools(); // registers openwop:crm.lead.capture into BUILTINS
  if (crmFeature.toggleDefault) registerToggleDefault(crmFeature.toggleDefault); // crm is default-on (ADR 0191)
});

describe('ADR 0470 P1 — the anon write tier lands a REAL write (§N3 closed)', () => {
  it('an anon auto-run lead.capture creates a CRM Contact (leadSource=anon-widget), echoing NO PII', async () => {
    const storage = await openStorage('memory://');
    const captured = { round2: [] as AiToolCallRequest['messages'] };
    await runAnonReadTurn({
      storage, tenantId: TENANT, agent: AGENT,
      grant: { read: [], write: [CRM_LEAD_CAPTURE_TOOL_ID], writeControl: 'rate-limit-session-cap' },
      surfaceSessionKey: 'w:lead1', fencedUserMessage: 'I want a demo',
      callAIWithTools: scriptedProvider([{ id: 'c1', name: CRM_LEAD_CAPTURE_TOOL_ID, input: { email: 'jane@example.com', name: 'Jane Doe', note: 'wants a demo' } }], captured),
      autoWriteUnderCap: async () => ({ allowed: true }), // operator opted into capped auto-run
    });
    // The write LANDED — a real Contact now exists, sourced as an anon-widget lead.
    const contact = await findContactByEmail(TENANT, 'jane@example.com');
    expect(contact).toBeTruthy();
    expect(contact?.leadSource).toBe('anon-widget');
    expect(contact?.name).toBe('Jane Doe');
    // The tool succeeded (no fail-closed floor) and echoed the opaque contactId, NOT PII.
    const round2 = JSON.stringify(captured.round2);
    expect(round2).toContain('success');
    expect(round2).not.toContain('acting_user_required');
    expect(round2).toContain(contact!.contactId);
    expect(round2).not.toContain('jane@example.com'); // no-PII-echo boundary
  });

  it('REJECTS an invalid email (the agent must re-ask) — no Contact created', async () => {
    const storage = await openStorage('memory://');
    const captured = { round2: [] as AiToolCallRequest['messages'] };
    await runAnonReadTurn({
      storage, tenantId: TENANT, agent: AGENT,
      grant: { read: [], write: [CRM_LEAD_CAPTURE_TOOL_ID], writeControl: 'rate-limit-session-cap' },
      surfaceSessionKey: 'w:lead2', fencedUserMessage: 'hi',
      callAIWithTools: scriptedProvider([{ id: 'c1', name: CRM_LEAD_CAPTURE_TOOL_ID, input: { email: 'not-an-email' } }], captured),
      autoWriteUnderCap: async () => ({ allowed: true }),
    });
    expect(JSON.stringify(captured.round2)).toContain('validation_error');
    expect(await findContactByEmail(TENANT, 'not-an-email')).toBeNull();
  });
});

describe('ADR 0470 P1 — anon-EXCLUSIVE boundary (authenticated → governed write)', () => {
  it('a signed-in turn (actingUserId present) is refused → use_governed_write (preserves ADR 0208)', async () => {
    const provider = createScopedAgentToolProvider({ tenantId: TENANT, runId: 'r1', actingUserId: 'user-1' });
    const res = await provider.executeTool({ name: CRM_LEAD_CAPTURE_TOOL_ID, input: { email: 'bob@example.com' } });
    expect(res.isError).toBe(true);
    expect(res.content).toContain('use_governed_write');
    // NOT created via this tool from an authenticated turn.
    expect(await findContactByEmail(TENANT, 'bob@example.com')).toBeNull();
  });
});

describe('ADR 0470 P1 — the operator sees the lead in the review projection', () => {
  it('a held lead surfaces "New lead: <name> <email> — <note>" as the card summary + a risk chip', () => {
    const appr = {
      approvalId: 'appr:anon:run-x:0', tenantId: TENANT, rosterId: '', persona: '', workflowId: '',
      proposal: 'Anonymous visitor requested: openwop:crm.lead.capture', kind: 'anon-surface-write', orgId: 'org-1',
      anonSurfaceWrite: {
        widgetId: 'w', principal: 'anon:sess-a', runId: 'run-x', toolCallIdx: 0,
        tool: { name: CRM_LEAD_CAPTURE_TOOL_ID, args: { email: 'jane@example.com', name: 'Jane', note: 'wants a demo' } },
        capturedName: 'Jane', capturedEmail: 'jane@example.com', capturedNote: 'wants a demo',
      },
      status: 'pending', createdAt: '2026-07-23T00:00:00.000Z',
    } as PendingApproval;
    const r = approvalToReview(appr);
    expect(r.summary).toBe('New lead: Jane jane@example.com — wants a demo');
    expect(r.risk?.level).toBe('medium');
    expect(r.requestedBy?.label).toBe('Anonymous visitor');
    expect(r.actions.map((a) => a.action)).toEqual(['approve', 'reject']);
  });
});
