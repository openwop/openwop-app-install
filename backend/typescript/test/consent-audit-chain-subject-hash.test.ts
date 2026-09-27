/**
 * ADR 0657 D11 (CONS-26) — the tamper-evident audit chain is DSAR-exempt, un-redactable
 * (hash-linked) and workspace-admin exportable, so a consent change must never write the
 * RAW subject key into it (since ADR 0394 a key may be a bare E.164 number — the WhatsApp
 * STOP lane writes `normalizeWaNumber(from)`). Two legs: a behavioural one over the real
 * chain, and a source scan of every `appendAudit(` site under `features/consent` so the
 * next writer cannot reintroduce the field. Born red on both against the 2026-09-11 tree.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { listChain, __resetAuditChain } from '../src/host/auditChainService.js';
import { recordConsent, mergeConsentCategories, __resetConsentStore } from '../src/features/consent/consentService.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONSENT_SRC = join(HERE, '..', 'src', 'features', 'consent');
const T = 'tAuditHash';
const PHONE = '+15550001111';

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  await __resetAuditChain();
  await __resetConsentStore();
});

describe('ADR 0657 D11 — consent audit rows carry a subject HASH, never the raw key', () => {
  it('leg 1 (behavioural): recordConsent + mergeConsentCategories write rows without the raw key, with a stable correlating hash', async () => {
    await recordConsent({ tenantId: T, subjectKey: PHONE, categories: { marketing: true }, source: 'test' });
    await mergeConsentCategories({ tenantId: T, subjectKey: PHONE, categories: { marketing: false }, source: 'test' });
    const rows = (await listChain(T)).filter((e) => e.kind === 'consent.change');
    expect(rows.length).toBe(2);
    for (const row of rows) {
      const flat = JSON.stringify(row);
      expect(flat, 'the raw E.164 must not appear anywhere in the row').not.toContain(PHONE);
      expect((row.payload as Record<string, unknown>).subjectKey).toBeUndefined();
      expect(typeof (row.payload as Record<string, unknown>).subjectHash).toBe('string');
    }
    expect((rows[0]!.payload as Record<string, unknown>).subjectHash, 'same subject ⇒ same hash (cross-row correlation survives)')
      .toBe((rows[1]!.payload as Record<string, unknown>).subjectHash);
  });

  it('leg 2 (source scan): no appendAudit( site under features/consent passes a subjectKey field', () => {
    const files = readdirSync(CONSENT_SRC).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    let sites = 0;
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(CONSENT_SRC, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      for (const m of src.matchAll(/appendAudit\s*\(/g)) {
        sites += 1;
        const open = src.indexOf('{', m.index);
        let depth = 0; let end = -1;
        for (let i = open; i < src.length; i += 1) {
          if (src[i] === '{') depth += 1;
          else if (src[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
        }
        const body = src.slice(open, end + 1);
        if (/(?:^|[{,\s])subjectKey\s*:/.test(body)) offenders.push(`${f}@${m.index}`);
      }
    }
    expect(sites, 'the scan must find the real call sites — otherwise this leg is vacuous').toBeGreaterThanOrEqual(2);
    expect(offenders).toEqual([]);
  });
});
