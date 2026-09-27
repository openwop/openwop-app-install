/**
 * CDP-C — event-based behavioral segment traits (ADR 0265). `emailClicks`/`emailOpens`
 * read the email engagement store; a segment filtered on them selects only contacts
 * with the matching engagement. Attribute-only segments never pay the engagement read.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createContact } from '../src/features/crm/contactsService.js';
import { createSegment, resolveSegmentMembers } from '../src/features/crm/segmentsService.js';
import { mintToken, recordClick } from '../src/features/email/engagementService.js';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
});

describe('CDP-C engagement traits', () => {
  it('emailClicks selects contacts who clicked; others are excluded', async () => {
    const tenantId = `org:eng-${Date.now()}`;
    const clicker = await createContact({ tenantId, name: 'Clicker', email: 'click@x.test' });
    const quiet = await createContact({ tenantId, name: 'Quiet', email: 'quiet@x.test' });

    // seed a click event for the clicker
    const token = await mintToken({ tenantId, campaignId: 'camp1', contactId: clicker.contactId, kind: 'click', url: 'https://example.test', email: 'click@x.test' });
    await recordClick(token);

    const seg = await createSegment({ tenantId, name: 'clickers', filters: [{ field: 'emailClicks', op: 'gt', value: '0' }], createdBy: 'test' });
    const ids = (await resolveSegmentMembers(tenantId, seg.segmentId)).map((c) => c.contactId);
    expect(ids).toContain(clicker.contactId);
    expect(ids).not.toContain(quiet.contactId);
  });

  it('a contact with no clicks does not match emailClicks gt 0', async () => {
    const tenantId = `org:eng2-${Date.now()}`;
    await createContact({ tenantId, name: 'NoClicks', email: 'n@x.test' });
    const seg = await createSegment({ tenantId, name: 'clickers', filters: [{ field: 'emailClicks', op: 'gt', value: '0' }], createdBy: 'test' });
    expect((await resolveSegmentMembers(tenantId, seg.segmentId)).length).toBe(0);
  });
});
