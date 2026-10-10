/**
 * ADR 0867 D3 — the boot round trip every network blob backend must pass before
 * the process listens: put one small object under a reserved tenant root, read
 * it back, find it in a prefix list, fetch it through a presigned URL, and
 * delete it (always, even after a failed step). A wrong bucket, endpoint,
 * credential or signing permission therefore fails the revision's startup probe
 * instead of every blob call.
 */
import type { BlobSurface } from '../inMemorySurfaces.js';
import { randomUUID } from 'node:crypto';

/** The reserved tenant the boot check writes under (`<prefix>tenants/__openwop_boot_check__/`). */
export const BLOB_BOOT_CHECK_TENANT = '__openwop_boot_check__';

export async function blobBootRoundTrip(blob: BlobSurface, fetchFn: typeof fetch): Promise<void> {
  const key = `boot-check-${randomUUID()}`;
  const body = 'openwop boot check';
  try {
    // A transport error can follow a successful PUT. Always attempt cleanup,
    // and avoid collisions when instances share a PID and start simultaneously.
    await blob.put({ key, contentBase64: Buffer.from(body, 'utf8').toString('base64'), contentType: 'text/plain' });
    const got = (await blob.get({ key })) as { found?: boolean; contentBase64?: string };
    const text = got.found === false || !got.contentBase64 ? null : Buffer.from(got.contentBase64, 'base64').toString('utf8');
    if (text !== body) throw new Error('blob boot check: the object just written did not read back.');
    const listed = (await blob.list({ prefix: key })) as { entries?: Array<{ key?: unknown }> };
    if (!(listed.entries ?? []).some((e) => e.key === key)) throw new Error('blob boot check: the object just written was not listed.');
    const signed = (await blob.presign({ key, expiresInSeconds: 60 })) as { url?: string };
    if (!signed.url) throw new Error('blob boot check: presign returned no URL for an existing object.');
    const res = await fetchFn(signed.url);
    const fetched = res.ok ? await res.text() : null;
    if (fetched !== body) throw new Error(`blob boot check: the presigned URL did not serve the object (HTTP ${res.status}).`);
  } finally {
    await blob.delete({ key });
  }
}
