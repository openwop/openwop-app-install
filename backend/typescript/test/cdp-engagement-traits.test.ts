/**
 * CDP-C — event-based behavioral segment traits (ADR 0265). `emailClicks` reads the
 * email engagement store; a segment filtered on it selects only contacts with a
 * recorded click (a contact with none counts as 0 and is excluded).
 *
 * Not asserted here (no seam observes it): that attribute-only segments skip the
 * engagement read — w38g1-en-attronly is an honest ceiling. `emailOpens` shares the
 * same aggregation and is not separately exercised.
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
    expect(await recordClick(token)).toMatch(/^https:\/\/example\.test/); // the click was recorded

    const seg = await createSegment({ tenantId, name: 'clickers', filters: [{ field: 'emailClicks', op: 'gt', value: '0' }], createdBy: 'test' });
    const ids = (await resolveSegmentMembers(tenantId, seg.segmentId)).map((c) => c.contactId);
    expect(ids).not.toContain(quiet.contactId); // no click ⇒ count 0 ⇒ out
    expect(ids).toEqual([clicker.contactId]);
  });
});
