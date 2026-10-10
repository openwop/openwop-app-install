/**
 * Dependabot #104 (CVE-2026-16633, pdf.js "arbitrary JS execution upon opening a
 * malicious PDF") — the office extraction lane must never hand a PDF to officeparser.
 *
 * `officeparser.parseOffice(buffer)` SNIFFS the format from the bytes, so the declared
 * MIME was no protection: a PDF uploaded as `.pptx` reached officeparser's bundled
 * pdf.js with JavaScript evaluation at its default (ON), server-side — the path H61
 * closed for real PDFs (`isEvalSupported: false` on the unpdf lane).
 *
 * The witness is that officeparser is NEVER CALLED for a mismatched body, not merely
 * that the answer is 4xx: a guard placed after the parse would also return an error,
 * after the damage. officeparser is mocked here (a spy) so the call itself is visible;
 * the real RTF round-trip lives in kb-file-upload.test.ts.
 *
 * Sabotage witnesses (grade-tests wave 6): removing the `officeBytesMatchMime` check
 * reds both PDF cases; breaking the `{\rtf` or `PK\x03\x04` sniff reds the matching
 * positive control.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const spy = vi.hoisted(() => ({ parseOffice: vi.fn(async () => ({ toText: () => 'parsed' })) }));
vi.mock('officeparser', () => ({ parseOffice: spy.parseOffice }));

import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { createCollection, ingestDocument } from '../src/features/kb/kbService.js';

const TENANT = 'kbguard-t';
const ORG = 'kbguard-org';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const ODT = 'application/vnd.oasis.opendocument.text';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-kbguard-')) });
});
beforeEach(() => spy.parseOffice.mockClear());

async function upload(title: string, bytes: Buffer, contentType: string) {
  const col = await createCollection(TENANT, ORG, 'tester', { name: `c-${title}` });
  return ingestDocument(TENANT, ORG, 'tester', col.collectionId, { title, contentBase64: bytes.toString('base64'), contentType });
}

describe('office extraction — the bytes must be the declared type', () => {
  it('a PDF declared as .pptx is refused 422 and NEVER reaches officeparser', async () => {
    const pdf = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n');
    await expect(upload('evil.pptx', pdf, PPTX)).rejects.toMatchObject({
      httpStatus: 422,
      details: { reason: 'content_type_mismatch' },
    });
    expect(spy.parseOffice, 'the PDF must not reach officeparser (and its pdf.js)').not.toHaveBeenCalled();
  });

  it('a PDF declared as RTF is refused the same way', async () => {
    // `reason` too: a post-parse failure is ALSO a 422, so the status alone cannot tell
    // the pre-parse guard from a guard placed after the damage.
    await expect(upload('evil.rtf', Buffer.from('%PDF-1.4\n%%EOF'), 'application/rtf')).rejects.toMatchObject({ httpStatus: 422, details: { reason: 'content_type_mismatch' } });
    expect(spy.parseOffice).not.toHaveBeenCalled();
  });

  it('a real ZIP-container office file still reaches officeparser (the guard is not a blanket refusal)', async () => {
    const zipHeader = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(26)]);
    await expect(upload('ok.odt', zipHeader, ODT)).resolves.toMatchObject({ title: 'ok.odt' });
    expect(spy.parseOffice).toHaveBeenCalledTimes(1);
    expect(spy.parseOffice).toHaveBeenCalledWith(zipHeader);
  });

  it('real RTF bytes still reach officeparser', async () => {
    const rtf = Buffer.from('{\\rtf1\\ansi hello}');
    await expect(upload('ok.rtf', rtf, 'text/rtf')).resolves.toMatchObject({ title: 'ok.rtf' });
    expect(spy.parseOffice).toHaveBeenCalledTimes(1);
    expect(spy.parseOffice).toHaveBeenCalledWith(rtf);
  });
});
