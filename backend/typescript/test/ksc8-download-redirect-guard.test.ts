/**
 * KSC-8 (ADR 0605 Tier 7, deferred there) — `fetchGuardedBytes` hand-rolled a
 * WEAKER SUBSET of `guardedEgressFetch`, and ADR 0605 recorded the four gaps:
 *
 *   > no per-hop scheme check … no `AbortSignal.timeout`, no `maxResponseSize`
 *   > (the cap is applied *post*-buffering), and it skips the ADR 0187 tenant
 *   > egress firewall.
 *
 * It was deferred with a stated reason, and that reason names the debt this file
 * pays: *"a behaviour change, which owes a witness against a REAL REDIRECT
 * CHAIN."* So every test here drives a real loopback HTTP server through a real
 * `undiciFetch` — no mocked fetch, because a mock cannot witness what undici's
 * `redirect: 'follow'` default does, which is the whole defect.
 *
 * THE DEFECT, in one sentence: the scheme was checked once, on the URL passed
 * in, and `undiciFetch` was then called with no `redirect` — so the default
 * `'follow'` took up to 20 hops and a `302` to `http://` was followed. The body
 * is un-credentialed (so no token leaks), but it arrives over cleartext,
 * attacker-modifiable in transit, on its way into a customer's knowledge base.
 *
 * `OPENWOP_WEBHOOK_ALLOW_PRIVATE=true` throughout: the receiver is loopback.
 * That flag relaxes the private-address arms, NOT the redirect logic under test.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchGuardedBytes } from '../src/host/knowledgeSourceFetch.js';
import { putEgressRules } from '../src/host/egressPolicy.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';

let server: http.Server;
let port = 0;
const hits: string[] = [];
/** Set per-test; the server reads it so one server serves every scenario. */
let hugeBodyBytes = 0;
/** Bytes the SERVER actually wrote. The discriminator between a streaming cap
 *  (client aborts early, server stops) and a post-buffering cap (client reads
 *  the whole body, then rejects it). */
let hugeBytesSent = 0;

beforeAll(async () => {
  // The tenant egress rules live in a DurableCollection, so the host-ext store
  // must be booted for `putEgressRules`. Bare in-memory storage is enough.
  initHostExtPersistence(await openStorage('memory://'));
  server = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    const url = req.url ?? '';
    if (url === '/downgrade') {
      // The defect's shape: a redirect whose target is plain http.
      res.writeHead(302, { location: `http://127.0.0.1:${port}/payload` });
      res.end();
      return;
    }
    if (url === '/to-file-scheme') {
      // A redirect target that is not http(s) at all. `unsupported_protocol` is
      // the ONE arm ADR 0607 places OUTSIDE the dev-flag escape, so this is
      // witnessable over plain http — it proves the scheme arm runs PER HOP.
      res.writeHead(302, { location: 'file:///etc/passwd' });
      res.end();
      return;
    }
    if (url === '/same-scheme') {
      // POSITIVE CONTROL — a redirect that does NOT downgrade must still work,
      // because pre-authenticated provider download URLs legitimately redirect.
      res.writeHead(302, { location: `http://127.0.0.1:${port}/payload` });
      res.end();
      return;
    }
    if (url.startsWith('/loop')) {
      const n = Number(url.slice('/loop'.length) || '0');
      res.writeHead(302, { location: `http://127.0.0.1:${port}/loop${n + 1}` });
      res.end();
      return;
    }
    if (url === '/huge') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      // Written in chunks so the cap can bite mid-stream rather than at the end.
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      const pump = (): void => {
        while (hugeBytesSent < hugeBodyBytes) {
          if (res.destroyed || res.writableEnded) return;
          hugeBytesSent += chunk.length;
          if (!res.write(chunk)) {
            res.once('drain', pump);
            return;
          }
        }
        res.end();
      };
      pump();
      return;
    }
    if (url === '/hang') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.write(Buffer.alloc(16, 0x61)); // headers + a byte, then never finish
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(Buffer.from('PAYLOAD'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  hits.length = 0;
  hugeBodyBytes = 0;
  hugeBytesSent = 0;
  delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
});

function outcome(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => 'RESOLVED',
    (e: unknown) => `REJECTED:${(e as { details?: { reason?: string } }).details?.reason ?? (e as { code?: string }).code ?? 'error'}`,
  );
}

describe('KSC-8 — the download leg refuses a scheme downgrade mid-redirect', () => {
  beforeAll(() => undefined);

  // WHAT THIS CAN AND CANNOT WITNESS, stated plainly, because the obvious test
  // is not available and writing it anyway would be the defect this file is about.
  //
  // The production downgrade is `https:` hop 1 -> `http:` hop 2 with the dev flag
  // OFF. Serving hop 1 needs a real TLS endpoint the pinned egress dispatcher
  // will dial, which this suite has no way to stand up. With the flag ON, `http:`
  // is permitted at EVERY hop, so a downgrade is not even a violation.
  //
  // So the property is witnessed in two halves that together imply it:
  //   (a) the scheme arm RUNS PER HOP  — via a redirect to `file://`, which is
  //       `unsupported_protocol`, the one arm ADR 0607 puts OUTSIDE the dev-flag
  //       escape, so it bites on a redirect target even with the flag on; and
  //   (b) the scheme arm REQUIRES https — via hop 1 with the flag off.
  // Neither half alone is the claim. An honest half-witness beats a test whose
  // name asserts more than its body checks.
  it('(a) the scheme arm runs PER HOP — a redirect to a non-http(s) target is refused', async () => {
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    expect(await outcome(fetchGuardedBytes(`http://127.0.0.1:${port}/to-file-scheme`, 'Probe'))).toBe(
      'REJECTED:unsupported_protocol',
    );
    // Hop 1 was really served; the refusal happened on the TARGET, not up front.
    expect(hits).toEqual(['/to-file-scheme']);
  });

  it('POSITIVE CONTROL — a legitimate redirect chain still downloads', async () => {
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    const bytes = await fetchGuardedBytes(`http://127.0.0.1:${port}/same-scheme`, 'Probe');
    expect(bytes.toString()).toBe('PAYLOAD');
    // Both hops were really taken — this is the "real redirect chain" ADR 0605
    // said the fix owed, and it proves the loop follows rather than refusing all.
    expect(hits).toEqual(['/same-scheme', '/payload']);
  });

  it('an unbounded redirect chain is refused rather than followed 20 deep', async () => {
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    await expect(fetchGuardedBytes(`http://127.0.0.1:${port}/loop0`, 'Probe')).rejects.toThrow(/redirects/i);
    // Bounded at MAX_DOWNLOAD_REDIRECTS (5) + the initial hop.
    expect(hits.length).toBeLessThanOrEqual(7);
    expect(hits.length).toBeGreaterThan(1);
  });

  it('(b) the scheme arm requires https — hop 1 over http is refused with the flag OFF', async () => {
    expect(await outcome(fetchGuardedBytes(`http://127.0.0.1:${port}/payload`, 'Probe'))).toBe(
      'REJECTED:insecure_scheme',
    );
    expect(hits).toEqual([]);
  });
});

describe('KSC-8 — the size cap bounds what is READ, not what was already read', () => {
  // The obvious assertion — "an over-cap body is rejected" — is TRUE OF BOTH
  // implementations, because `readBytes` also rejects it, just after
  // materialising the whole thing. MEASURED: sabotaging the streaming reader
  // back to `readBytes` left this suite fully green, so the first version of
  // this test named a property it could not observe.
  //
  // The discriminator is how much the SERVER got to write. A streaming reader
  // aborts mid-body, so the server stops far short of the total; a
  // post-buffering reader consumes everything before deciding.
  it('an over-cap body is rejected mid-stream — the server never finishes sending', async () => {
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    hugeBodyBytes = 16 * 1024 * 1024; // 16 MiB against a 256 KiB cap
    await expect(fetchGuardedBytes(`http://127.0.0.1:${port}/huge`, 'Probe', 256 * 1024)).rejects.toThrow(
      /exceeds the .* MiB sync cap/,
    );
    // Generous margin so socket buffering cannot make this flaky: anything under
    // half the body proves the read stopped early. Post-buffering sends it all.
    expect(hugeBytesSent, `server wrote ${hugeBytesSent} of ${hugeBodyBytes} bytes`).toBeLessThan(
      hugeBodyBytes / 2,
    );
  });

  it('POSITIVE CONTROL — a body under the cap still downloads intact', async () => {
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    const bytes = await fetchGuardedBytes(`http://127.0.0.1:${port}/payload`, 'Probe', 256 * 1024);
    expect(bytes.toString()).toBe('PAYLOAD');
  });
});

describe('KSC-8 — the ADR 0187 tenant egress firewall reaches the download leg', () => {
  // The credentialed metadata leg goes through `brokeredFetch`, which calls
  // `assertEgressAllowed`. The DOWNLOAD leg skipped it entirely — so a tenant
  // whose policy denies a host still had the host fetched, as long as the
  // provider handed back a download URL pointing at it.
  it('a denied host is refused on hop 1', async () => {
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    const tenantId = `t-ksc8-${Math.random().toString(36).slice(2)}`;
    await putEgressRules(tenantId, 'allowlist', ['example.com']); // 127.0.0.1 not on it
    expect(
      await outcome(fetchGuardedBytes(`http://127.0.0.1:${port}/payload`, 'Probe', undefined, { tenantId })),
    ).toBe('REJECTED:not_on_allowlist');
    expect(hits).toEqual([]);
  });

  // The load-bearing half: a redirect TARGET is a different host than the one
  // the policy was evaluated against, so a hop-1-only check is bypassable by
  // any provider that can redirect.
  it('a denied REDIRECT TARGET is refused — the policy is re-evaluated per hop', async () => {
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    const tenantId = `t-ksc8-${Math.random().toString(36).slice(2)}`;
    // Allow the literal first host, so hop 1 passes and only hop 2 can refuse.
    await putEgressRules(tenantId, 'allowlist', ['127.0.0.1']);
    const before = await fetchGuardedBytes(`http://127.0.0.1:${port}/same-scheme`, 'Probe', undefined, { tenantId });
    expect(before.toString(), 'control: with the host allowed, the chain completes').toBe('PAYLOAD');

    hits.length = 0;
    await putEgressRules(tenantId, 'allowlist', ['example.com']); // now deny it
    expect(
      await outcome(fetchGuardedBytes(`http://127.0.0.1:${port}/same-scheme`, 'Probe', undefined, { tenantId })),
    ).toBe('REJECTED:not_on_allowlist');
  });

  it('POSITIVE CONTROL — no tenantId means no policy call, not a silent allow-all', async () => {
    // The three real callers always pass one. This pins that omitting it does not
    // throw, so the arm cannot become an accidental hard dependency.
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    const bytes = await fetchGuardedBytes(`http://127.0.0.1:${port}/payload`, 'Probe');
    expect(bytes.toString()).toBe('PAYLOAD');
  });
});

describe('KSC-8 — the download leg is time-bounded', () => {
  // The original had NO timeout at all: a provider that returns headers and then
  // never finishes the body hung the sync tick forever. The daemon is a
  // self-rescheduling setTimeout, so one wedged download stalls the whole source.
  it('a body that never completes is aborted rather than hanging', async () => {
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    const started = Date.now();
    await expect(
      fetchGuardedBytes(`http://127.0.0.1:${port}/hang`, 'Probe', undefined, { timeoutMs: 300 }),
    ).rejects.toThrow();
    // The bound is what is being witnessed, not the error text: without a signal
    // this promise never settles and the test times out instead of passing.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('POSITIVE CONTROL — a prompt response is unaffected by the same bound', async () => {
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    const bytes = await fetchGuardedBytes(`http://127.0.0.1:${port}/payload`, 'Probe', undefined, {
      timeoutMs: 5_000,
    });
    expect(bytes.toString()).toBe('PAYLOAD');
  });
});
