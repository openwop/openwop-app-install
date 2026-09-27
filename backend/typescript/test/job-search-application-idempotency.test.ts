/**
 * ADR 0540 — `ensureApplicationFieldDefs` really is idempotent.
 *
 * It claimed to be ("seeds any missing definition, leaves existing ones
 * untouched") and was not: it compared the camelCase literal `jobUrl` against
 * the STORED key, which `buildFieldSpec` normalises to `joburl`. The guard never
 * matched, so the second call tried to re-create the field and threw
 * `A field \`joburl\` already exists`.
 *
 * Nothing caught it because every existing test creates ONE application per
 * tenant. ADR 0545's campaign loop was the first caller to create a second, and
 * it failed on listing #2 — meaning every real user would have hit this on their
 * second job application. This test is the direct pin, so the regression cannot
 * hide behind the campaign suite.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ensureApplicationFieldDefs, APPLICATION_FIELD_DEFS } from '../src/features/job-search/domain/applications.js';
import { listFieldDefs } from '../src/features/crm/crmEntitiesService.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';

const T = 'user:t-idem';
const ORG = 'org-1';

beforeEach(() => { __resetHostExtPersistence(); initHostExtPersistence(openSqliteStorage(':memory:')); });

describe('ensureApplicationFieldDefs', () => {
  it('seeds once, then does nothing — and does not throw', async () => {
    const first = await ensureApplicationFieldDefs(T, ORG);
    expect(first).toBe(APPLICATION_FIELD_DEFS.length);

    // The call that used to throw.
    const second = await ensureApplicationFieldDefs(T, ORG);
    expect(second, 'a second call must create nothing').toBe(0);

    const third = await ensureApplicationFieldDefs(T, ORG);
    expect(third).toBe(0);
  });

  it('does not duplicate the definitions', async () => {
    await ensureApplicationFieldDefs(T, ORG);
    await ensureApplicationFieldDefs(T, ORG);
    const defs = await listFieldDefs(T, ORG, 'deal');
    expect(defs).toHaveLength(APPLICATION_FIELD_DEFS.length);
  });

  it('the stored keys really are normalised — the premise of the bug', async () => {
    // If this ever stops being true the comparison above is pointless, and a
    // future reader deserves to see WHY the normalisation exists rather than
    // guessing it is defensive noise.
    await ensureApplicationFieldDefs(T, ORG);
    const keys = (await listFieldDefs(T, ORG, 'deal')).map((d) => d.key);
    expect(keys, 'buildFieldSpec lowercases on the way in').toContain('joburl');
    expect(keys).not.toContain('jobUrl');
  });
});
