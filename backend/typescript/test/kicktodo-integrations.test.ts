/**
 * ADR 0421 P1/P3 — consent, the tokenized ICS feed, wearable evidence:
 *
 *  - the feed lane requires consent; the RAW token is minted once and stored
 *    HASHED; unknown/revoked tokens and revoked consent are uniform denials
 *  - the ICS body carries titles + day numbers ONLY (no instructions/notes)
 *  - consent revocation kills every live feed token immediately
 *  - wearable ingest is consent-gated; a threshold-met metric converts the
 *    matching occurrence into an IDEMPOTENT check-in (recorded evidence wins);
 *    below-threshold values convert nothing
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { kicktodoIntegrationsFeature } from '../src/features/kicktodo-integrations/feature.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll, __clearEnrollGuards } from '../src/features/kicktodo-core/enrollmentService.js';
import { todayFor, listCheckIns } from '../src/features/kicktodo-core/todayService.js';
import {
  grantConsent,
  revokeConsent,
  mintFeedToken,
  renderFeed,
  putWearableRule,
  ingestWearableMetric,
  ConsentRequiredError,
  FeedDeniedError,
} from '../src/features/kicktodo-integrations/integrationService.js';

const T = 'tenant-integrations';
const OWNER = 'user:int-owner';

let enrollmentId = '';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerToggleDefault(kicktodoIntegrationsFeature.toggleDefault!);
  await saveConfig({ ...kicktodoIntegrationsFeature.toggleDefault!, status: 'on' }, 'test');
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  __clearEnrollGuards();
  const draft = await createDraft({
    tenantId: T, title: 'Integrated Challenge', summary: 's', outcome: 'o', durationDays: 3,
    activities: [
      { stableActivityId: 'walk', day: 1, title: 'Walk 6k steps', instructions: 'SECRET-INSTRUCTIONS', evidencePolicy: 'measurement' },
    ],
  });
  await publishChallenge(T, draft.id, 1);
  const { enrollment } = await enroll({ tenantId: T, ownerSubject: OWNER, challengeId: draft.id, challengeVersion: 1, timezone: 'UTC' });
  enrollmentId = enrollment.id;
});

describe('the tokenized ICS feed (P1)', () => {
  it('consent-gated mint; titles + day numbers only; revocation kills tokens immediately', async () => {
    await expect(mintFeedToken(T, OWNER)).rejects.toBeInstanceOf(ConsentRequiredError);

    await grantConsent(T, OWNER, 'calendar-project');
    const token = await mintFeedToken(T, OWNER);
    expect(token).toMatch(/^ktfeed_/);

    const ics = await renderFeed(token);
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('Walk 6k steps');
    expect(ics).toContain('day 1');
    expect(ics).not.toContain('SECRET-INSTRUCTIONS'); // titles only

    // Unknown token → uniform denial.
    await expect(renderFeed('ktfeed_nope')).rejects.toBeInstanceOf(FeedDeniedError);

    // Consent revocation kills the live token immediately.
    await revokeConsent(T, OWNER, 'calendar-project');
    await expect(renderFeed(token)).rejects.toBeInstanceOf(FeedDeniedError);
  });

  it('the operator kill-switch holds for already-minted feeds (toggle OFF → uniform denial)', async () => {
    await grantConsent(T, OWNER, 'calendar-project');
    const token = await mintFeedToken(T, OWNER);
    await expect(renderFeed(token)).resolves.toContain('BEGIN:VCALENDAR');

    const d = kicktodoIntegrationsFeature.toggleDefault!;
    await saveConfig({ ...d, status: 'off' }, 'test');
    await expect(renderFeed(token)).rejects.toBeInstanceOf(FeedDeniedError); // fail-closed
    await saveConfig({ ...d, status: 'on' }, 'test');
    await expect(renderFeed(token)).resolves.toContain('BEGIN:VCALENDAR'); // re-enable restores
  });
});

describe('ICS injection (KTFULL-B21)', () => {
  it('escapes CRLF and RFC 5545 specials in creator-controlled titles', async () => {
    // A malicious activity title tries to close SUMMARY and inject its own
    // property into the participant's calendar client.
    const draft = await createDraft({
      tenantId: T, title: 'Injected', summary: 's', outcome: 'o', durationDays: 1,
      activities: [{
        stableActivityId: 'evil', day: 1,
        title: 'Walk\r\nX-EVIL-PROP:pwned\r\nSUMMARY:spoofed',
        instructions: 'i', evidencePolicy: 'attestation',
      }],
    });
    await publishChallenge(T, draft.id, 1);
    const owner = 'user:ics-victim';
    await enroll({ tenantId: T, ownerSubject: owner, challengeId: draft.id, challengeVersion: 1, timezone: 'UTC' });
    await grantConsent(T, owner, 'calendar-project');
    const ics = await renderFeed(await mintFeedToken(T, owner));

    // The injected property never becomes a real line…
    expect(ics).not.toMatch(/^X-EVIL-PROP:/m);
    // …and exactly ONE SUMMARY line exists per event.
    expect(ics.split(/\r\n/).filter((l) => l.startsWith('SUMMARY:'))).toHaveLength(1);
    // The text survives, escaped rather than dropped.
    expect(ics).toContain('\\n');
  });
});

describe('wearable evidence (P3)', () => {
  it('consent-gated ingest; threshold-met metrics convert to idempotent check-ins; below-threshold converts nothing', async () => {
    await expect(ingestWearableMetric(T, OWNER, 'steps', 7000)).rejects.toBeInstanceOf(ConsentRequiredError);

    await grantConsent(T, OWNER, 'wearable-evidence');
    await putWearableRule(T, OWNER, { enrollmentId, stableActivityId: 'walk', metric: 'steps', threshold: 6000 });

    // Below threshold: nothing converts.
    expect(await ingestWearableMetric(T, OWNER, 'steps', 4000)).toBe(0);

    // Threshold met: the walk occurrence completes with mapped evidence.
    expect(await ingestWearableMetric(T, OWNER, 'steps', 7200)).toBe(1);
    const today = await todayFor(T, OWNER);
    const walk = today.enrollments[0].actions.find((a) => a.occurrence.stableActivityId === 'walk');
    expect(walk?.card?.completed).toBe(true);
    const [checkIn] = await listCheckIns(T, enrollmentId);
    expect(checkIn.note).toContain('wearable:steps=7200');
    expect(checkIn.measuredValue).toBe(7200);

    // Idempotent: a second reading never overwrites the recorded evidence.
    expect(await ingestWearableMetric(T, OWNER, 'steps', 9999)).toBe(1); // matched, but…
    const [after] = await listCheckIns(T, enrollmentId);
    expect(after.measuredValue).toBe(7200); // …recorded evidence wins
  });
});
