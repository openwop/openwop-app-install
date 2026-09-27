/**
 * H17 — the conformance host must not hard-code its listen port.
 *
 * `scripts/ci.sh` runs `npm run test:conformance` inside `npm run ci`, and this
 * repo's working arrangement is several worktrees on one machine. With
 * `const PORT = 18080` the second lane died with `EADDRINUSE` mid-gate, which
 * reads as a real break rather than as contention (MEASURED 2026-08-16: two
 * agents' lanes collided).
 *
 * These use REAL ephemeral listeners rather than a stub probe. The whole point
 * of the helper is its bind semantics; a fake probe would let those drift while
 * the test stayed green.
 */

import { describe, expect, it } from 'vitest';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONFORMANCE_PORT_DEFAULT,
  CONFORMANCE_PORT_ENV,
  probePort,
  selectConformancePort,
} from '../conformance/port.js';

/** Bind a real server on an OS-chosen port and return it plus a closer. */
async function occupyEphemeralPort(host = '127.0.0.1'): Promise<{ port: number; release: () => Promise<void> }> {
  const server = net.createServer();
  await new Promise<void>((res) => server.listen(0, host, res));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address');
  return {
    port: address.port,
    release: () => new Promise<void>((res) => server.close(() => res())),
  };
}

describe('conformance port selection (H17)', () => {
  it('the probe binds LOOPBACK V4 (H41): a 127.0.0.1 holder reads BUSY; a wildcard [::] holder reads whatever a 127.0.0.1 bind would — FREE where the two coexist (macOS), BUSY where [::] is dual-stack (Linux) — because our loopback bind then answers 127.0.0.1 traffic', async () => {
    // MEASURED on macOS 2026-08-17: `[::]:P` and `127.0.0.1:P` binds COEXIST in
    // both orders, and the address-specific socket always answers 127.0.0.1
    // connections. So the wildcard probe the first cut used had the hole (it
    // reported free/bound while a loopback-only occupant took the suite's
    // traffic), and a loopback probe answers the only question that matters:
    // "will 127.0.0.1:P reach ME?".
    const loopbackHolder = await occupyEphemeralPort('127.0.0.1');
    try {
      await expect(probePort(loopbackHolder.port)).resolves.toMatchObject({ free: false });
    } finally {
      await loopbackHolder.release();
    }
    const wildcardHolder = net.createServer((sock) => sock.end('WILDCARD'));
    await new Promise<void>((res) => wildcardHolder.listen(0, '::', res));
    const wAddr = wildcardHolder.address();
    if (wAddr === null || typeof wAddr === 'string') throw new Error('expected a TCP address');
    // PLATFORM-HONEST (2026-09-07). The first cut asserted `free: true` here
    // unconditionally — true on macOS, where `[::]:P` and `127.0.0.1:P` coexist,
    // and FALSE on Linux, where a `[::]` listener is dual-stack by default
    // (IPV6_V6ONLY=0) and owns 0.0.0.0:P too, so the loopback bind fails with
    // EADDRINUSE. MEASURED by a white-label adopter on ubuntu-latest: the leg
    // reported the probe wrong when the probe was right. The invariant is not
    // "a wildcard holder reads FREE"; it is "the probe answers the only question
    // that matters — will 127.0.0.1:P reach ME?" — so assert the probe's answer
    // AGAINST the bind that decides it, whichever way the platform decides.
    const ours = net.createServer((sock) => sock.end('LOOPBACK'));
    try {
      const probed = await probePort(wAddr.port);
      const bound = await new Promise<boolean>((res, rej) => {
        ours.once('error', (e: NodeJS.ErrnoException) => (e.code === 'EADDRINUSE' ? res(false) : rej(e)));
        ours.listen(wAddr.port, '127.0.0.1', () => res(true));
      });
      expect(probed.free, 'the probe must report exactly what a 127.0.0.1 bind experiences on this platform').toBe(bound);
      const answered = await new Promise<string>((res) => {
        const c = net.connect(wAddr.port, '127.0.0.1');
        let d = '';
        c.on('data', (x) => { d += String(x); });
        c.on('end', () => res(d));
      });
      // Coexisting (macOS): the address-specific socket takes loopback traffic.
      // Dual-stack (Linux): the wildcard holder does — and that is why BUSY was right.
      expect(answered).toBe(bound ? 'LOOPBACK' : 'WILDCARD');
    } finally {
      if (ours.listening) await new Promise<void>((res) => ours.close(() => res()));
      await new Promise<void>((res) => wildcardHolder.close(() => res()));
    }
  });

  it('a PINNED port that is busy is an error naming the env var — never silently moved', async () => {
    const held = await occupyEphemeralPort();
    try {
      await expect(selectConformancePort({ pinned: String(held.port) })).rejects.toThrow(
        new RegExp(`pinned port :${held.port} cannot be bound[\\s\\S]*${CONFORMANCE_PORT_ENV}`),
      );
    } finally {
      await held.release();
    }
  });

  it('a PINNED port that is free is used verbatim', async () => {
    const held = await occupyEphemeralPort();
    await held.release();
    const chosen = await selectConformancePort({ pinned: String(held.port) });
    expect(chosen).toMatchObject({ port: held.port, source: 'pinned' });
  });

  it('rejects a pinned value that is not a port', async () => {
    await expect(selectConformancePort({ pinned: 'not-a-port' })).rejects.toThrow(
      new RegExp(`${CONFORMANCE_PORT_ENV}=not-a-port is not a valid port`),
    );
    await expect(selectConformancePort({ pinned: '70000' })).rejects.toThrow(/not a valid port/);
  });

  it('UNPINNED and busy: moves to the next free port', async () => {
    const held = await occupyEphemeralPort();
    try {
      const chosen = await selectConformancePort({ start: held.port });
      expect(chosen.port).toBeGreaterThan(held.port);
      expect(chosen.source).toBe('scanned');
      // The port it moved to must genuinely be bindable — a scan that returns a
      // busy port is the "readiness probe answered by the OCCUPANT" defect.
      expect(await probePort(chosen.port)).toEqual({ free: true });
    } finally {
      await held.release();
    }
  });

  it('UNPINNED and free: takes the start port', async () => {
    const held = await occupyEphemeralPort();
    await held.release();
    const chosen = await selectConformancePort({ start: held.port });
    expect(chosen).toMatchObject({ port: held.port, source: 'default' });
  });

  it('UNPINNED with every candidate busy: throws rather than returning a busy port', async () => {
    const held = await occupyEphemeralPort();
    try {
      // limit 0 ⇒ the start port is the only candidate, and it is taken.
      await expect(selectConformancePort({ start: held.port, limit: 0 })).rejects.toThrow(
        new RegExp(`no free port in ${held.port}-${held.port}[\\s\\S]*${CONFORMANCE_PORT_ENV}`),
      );
    } finally {
      await held.release();
    }
  });

  it('the default scan start is still 18080', () => {
    expect(CONFORMANCE_PORT_DEFAULT).toBe(18080);
  });

  it('run.ts derives its port from the helper, not from a literal', () => {
    const runTs = readFileSync(join(__dirname, '..', 'conformance', 'run.ts'), 'utf8');
    expect(runTs).toMatch(/selectConformancePort\(\s*\{\s*pinned:/);
    // A re-introduced `const PORT = <literal>` is the exact regression this
    // whole item removes; BASE_URL and process.env.PORT must follow the choice.
    expect(runTs).not.toMatch(/const\s+PORT\s*=\s*\d+/);
    expect(runTs).toMatch(/const\s+PORT\s*=\s*selectedPort\.port/);
    expect(runTs).toMatch(/const\s+BASE_URL\s*=\s*`http:\/\/127\.0\.0\.1:\$\{PORT\}`/);
  });
});
